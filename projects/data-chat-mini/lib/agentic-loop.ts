import { streamChatCompletion as defaultStreamChatCompletion } from '@/lib/llm-client';
import type { ModelProfile } from '@/lib/llm-client';
import { dispatchTool } from '@/lib/tool-dispatch';
import { isContextTool, CONTEXT_PLACEHOLDER } from '@/lib/context-tools';
import {
  stepMvizFence,
  flushMvizFence,
  createMvizFenceState,
  buildMvizFallbackHtml,
} from '@/lib/mviz-fence';
import * as cl from '@/lib/controllog';
import {
  sseAuthExpired,
  sseContextTool,
  sseError,
  sseMvizHtml,
  sseMvizPending,
  sseText,
  sseThinking,
  sseThinkingDone,
  sseToolEnd,
  sseToolStart,
  sseTurnComplete,
  sseUsage,
} from '@/lib/sse-encoder';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { ThinkingLevel } from '@/types/chat';

/**
 * The agentic loop — calls the LLM, dispatches read-only MCP tool calls,
 * intercepts the local context-layer tools (pausing for a client round-trip),
 * and repeats until the model produces a terminal text response.
 */

export interface RunAgenticLoopOpts {
  messages: Array<{ role: string; content: unknown }>;
  turnStartIndex: number;
  profile: ModelProfile;
  thinkingLevel: ThinkingLevel;
  client: Client;
  tools: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>;
  systemPrompt: string;
  emit: (chunk: Uint8Array) => void;
  taskId: string;
  runId: string;
  requestText: string;
  historyLength: number;
  streamChatCompletion?: typeof defaultStreamChatCompletion;
}

export type AgenticLoopFinishReason = 'done' | 'iteration_limit' | 'auth_expired' | 'context_pause';

export interface RunAgenticLoopResult {
  finishReason: AgenticLoopFinishReason;
  finalMessages: Array<{ role: string; content: unknown }>;
  newTurnMessages: Array<{ role: string; content: unknown }>;
  turnToolNames: Set<string>;
}

const MAX_ITERATIONS = 40;
const MAX_EMPTY_STOP_RETRIES = 1;

const EMPTY_STOP_NUDGE =
  'You ran tool calls in the previous step but stopped without responding to me. ' +
  'Please write your response now, summarizing the relevant findings from the tool results above. ' +
  'Do not call any more tools unless absolutely necessary.';

export async function runAgenticLoop(opts: RunAgenticLoopOpts): Promise<RunAgenticLoopResult> {
  const messages = opts.messages;
  const turnStartIndex = opts.turnStartIndex;
  const profile = opts.profile;
  let continueLoop = true;
  let iterations = 0;
  let emptyStopRetriesUsed = 0;
  let pendingContinuationNudge: string | null = null;
  let contextPaused = false;
  const turnToolNames = new Set<string>();

  while (continueLoop && iterations < MAX_ITERATIONS) {
    iterations++;

    const exchangeId = cl.newId();
    const callStart = Date.now();

    const messagesForCall = pendingContinuationNudge
      ? [...messages, { role: 'user' as const, content: pendingContinuationNudge }]
      : messages;
    pendingContinuationNudge = null;

    const streamChatCompletion = opts.streamChatCompletion ?? defaultStreamChatCompletion;
    const llmStream = await streamChatCompletion({
      model: profile.id,
      messages: messagesForCall,
      tools: opts.tools,
      systemPrompt: opts.systemPrompt,
      temperature: 0.3,
      maxTokens: profile.maxTokens,
      thinkingLevel: opts.thinkingLevel,
      provider: profile.provider,
      onFetchRetry: (originalMessage) => {
        cl.streamError({
          taskId: opts.taskId, runId: opts.runId,
          errorKind: 'fetch_retry', message: originalMessage,
          iteration: iterations, model: profile.id,
        });
      },
    });

    const assistantContentBlocks: Array<Record<string, unknown>> = [];
    let hasToolUse = false;
    let fullResponseText = '';
    let mvizState = createMvizFenceState();
    const usage: {
      promptTokens: number;
      completionTokens: number;
      cachedPromptTokens?: number;
      reasoningTokens?: number;
      cost?: number;
    } = { promptTokens: 0, completionTokens: 0 };
    let finishReason: string | undefined;
    const pendingToolCalls = new Map<number, { id: string; name: string; args: string }>();
    let currentThinking = '';

    const reader = llmStream.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      sseBuffer += decoder.decode(value, { stream: true });
      const lines = sseBuffer.split('\n');
      sseBuffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;

        let chunk;
        try { chunk = JSON.parse(data); } catch { continue; }

        if (chunk.usage) {
          usage.promptTokens = chunk.usage.prompt_tokens || 0;
          usage.completionTokens = chunk.usage.completion_tokens || 0;
          if (typeof chunk.usage.cost === 'number') {
            usage.cost = chunk.usage.cost;
          } else if (chunk.usage.cost_details && typeof chunk.usage.cost_details.upstream_inference_cost === 'number') {
            usage.cost = chunk.usage.cost_details.upstream_inference_cost;
          }
          const ptd = chunk.usage.prompt_tokens_details;
          if (ptd && typeof ptd.cached_tokens === 'number') usage.cachedPromptTokens = ptd.cached_tokens;
          const ctd = chunk.usage.completion_tokens_details;
          if (ctd && typeof ctd.reasoning_tokens === 'number') usage.reasoningTokens = ctd.reasoning_tokens;
        }

        const choice = chunk.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta || {};
        if (choice.finish_reason) finishReason = choice.finish_reason;

        if (delta.reasoning_content || delta.reasoning) {
          const thinking = delta.reasoning_content || delta.reasoning || '';
          currentThinking += thinking;
          opts.emit(sseThinking(thinking));
        }

        if (delta.content) {
          fullResponseText += delta.content;

          const { events: mvizEvents, newState } = stepMvizFence(fullResponseText, mvizState);
          mvizState = newState;
          for (const ev of mvizEvents) {
            if (ev.kind === 'text') {
              opts.emit(sseText(ev.content));
            } else if (ev.kind === 'mviz_pending') {
              opts.emit(sseMvizPending(ev.id));
            } else if (ev.kind === 'mviz_block') {
              let html: string | null = null;
              try {
                const { processMvizMarkdown } = await import('@/lib/mviz-processor');
                const rendered = processMvizMarkdown(ev.source);
                if (rendered) html = rendered;
              } catch (err) {
                console.error('[Chat] inline mviz error:', err);
              }
              if (!html) html = buildMvizFallbackHtml('The chart block failed to render — malformed mviz spec.');
              opts.emit(sseMvizHtml(html, { source: ev.source, ...(ev.id && { id: ev.id }) }));
            }
          }
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!pendingToolCalls.has(idx)) {
              pendingToolCalls.set(idx, { id: tc.id || '', name: tc.function?.name || '', args: '' });
              hasToolUse = true;
            }
            const pending = pendingToolCalls.get(idx)!;
            if (tc.id) pending.id = tc.id;
            if (tc.function?.name) pending.name = tc.function.name;
            if (tc.function?.arguments) pending.args += tc.function.arguments;
          }
        }
      }
    }

    const { events: flushEvents, newState: flushedState } = flushMvizFence(fullResponseText, mvizState);
    mvizState = flushedState;
    for (const ev of flushEvents) {
      if (ev.kind === 'text') {
        opts.emit(sseText(ev.content));
      } else if (ev.kind === 'mviz_fallback') {
        opts.emit(sseMvizHtml(
          buildMvizFallbackHtml('The chart block was cut off before it finished streaming.'),
          { id: ev.id },
        ));
      }
    }

    if (currentThinking) {
      assistantContentBlocks.push({ type: 'thinking', thinking: currentThinking });
      opts.emit(sseThinkingDone());
    }
    if (fullResponseText) {
      assistantContentBlocks.push({ type: 'text', text: fullResponseText });
    }
    for (const [, tc] of pendingToolCalls) {
      let parsedArgs: Record<string, unknown> = {};
      try { parsedArgs = JSON.parse(tc.args || '{}'); } catch { /* */ }
      assistantContentBlocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: parsedArgs });
    }

    const wallMs = Date.now() - callStart;
    const toolCallSummary = Array.from(pendingToolCalls.values()).map(tc => ({ id: tc.id, name: tc.name, args: tc.args }));
    try {
      cl.modelPrompt({
        taskId: opts.taskId, runId: opts.runId, provider: 'openrouter',
        model: profile.id, promptTokens: usage.promptTokens, exchangeId,
        requestText: opts.requestText,
        payload: {
          iteration: iterations, thinking_level: opts.thinkingLevel, history_len: opts.historyLength,
          ...(usage.cachedPromptTokens !== undefined && { cached_prompt_tokens: usage.cachedPromptTokens }),
        },
      });
      cl.modelCompletion({
        taskId: opts.taskId, runId: opts.runId, provider: 'openrouter',
        model: profile.id, completionTokens: usage.completionTokens, wallMs, exchangeId,
        responseText: fullResponseText, costMoney: usage.cost,
        payload: {
          iteration: iterations, has_tool_use: hasToolUse, finish_reason: finishReason,
          ...(currentThinking && { thinking_text: currentThinking }),
          ...(usage.reasoningTokens !== undefined && { reasoning_tokens: usage.reasoningTokens }),
          ...(toolCallSummary.length > 0 && { tool_calls: toolCallSummary }),
        },
      });
    } catch (logErr) {
      console.error('[Controllog] Error:', logErr);
    }

    opts.emit(sseUsage({
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      ...(usage.cachedPromptTokens !== undefined && { cachedPromptTokens: usage.cachedPromptTokens }),
      ...(usage.reasoningTokens !== undefined && { reasoningTokens: usage.reasoningTokens }),
      ...(usage.cost !== undefined && { cost: usage.cost }),
      model: profile.id,
      contextWindow: profile.contextWindow,
    }));

    if (hasToolUse) {
      const toolResults: Array<{ type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }> = [];
      let authExpired = false;

      for (const block of assistantContentBlocks) {
        if (block.type !== 'tool_use') continue;
        const toolId = block.id as string;
        const toolName = block.name as string;
        const toolInput = block.input as Record<string, unknown>;

        // Local context-layer tools: intercept, emit a context_tool event, and
        // push a placeholder result. The loop pauses; the client services the
        // call against IndexedDB and re-POSTs with resolvedContext to resume.
        if (isContextTool(toolName)) {
          opts.emit(sseContextTool({ callId: toolId, name: toolName, args: toolInput }));
          toolResults.push({ type: 'tool_result', tool_use_id: toolId, content: CONTEXT_PLACEHOLDER });
          contextPaused = true;
          continueLoop = false;
          turnToolNames.add(toolName);
          continue;
        }

        opts.emit(sseToolStart({ id: toolId, name: toolName, args: toolInput }));

        const tStart = Date.now();
        try {
          const dispatch = await dispatchTool({ client: opts.client, name: toolName, args: toolInput });
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolId,
            content: dispatch.content,
            ...(dispatch.isError && { is_error: true }),
          });
          opts.emit(sseToolEnd({
            id: toolId, name: toolName, result: dispatch.content.slice(0, 500),
            ...(dispatch.isError && { error: true }),
          }));
          try {
            cl.toolEnd({
              taskId: opts.taskId, runId: opts.runId,
              toolName, toolUseId: toolId, ok: !dispatch.isError,
              durationMs: Date.now() - tStart, resultBytes: dispatch.content.length,
              ...(dispatch.isError && { errorMessage: dispatch.errorMessage }),
              iteration: iterations,
            });
          } catch (logErr) {
            console.error('[Controllog] toolEnd error:', logErr);
          }
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : 'Unknown error';
          const isAuthErr = /401|403|unauthorized|forbidden|expired|invalid.?token/i.test(errMsg);
          toolResults.push({ type: 'tool_result', tool_use_id: toolId, content: `Error: ${errMsg}`, is_error: true });
          opts.emit(sseToolEnd({ id: toolId, name: toolName, result: `Error: ${errMsg}`, error: true }));
          try {
            cl.toolEnd({
              taskId: opts.taskId, runId: opts.runId,
              toolName, toolUseId: toolId, ok: false,
              durationMs: Date.now() - tStart, errorMessage: errMsg, iteration: iterations,
              payload: { threw: true, ...(isAuthErr && { auth_error: true }) },
            });
          } catch (logErr) {
            console.error('[Controllog] toolEnd error:', logErr);
          }
          if (isAuthErr) {
            opts.emit(sseAuthExpired('Your MotherDuck connection failed. Check MOTHERDUCK_TOKEN.'));
            authExpired = true;
            break;
          }
        }
      }

      if (authExpired) {
        messages.push({ role: 'assistant', content: assistantContentBlocks });
        messages.push({ role: 'user', content: toolResults });
        return {
          finishReason: 'auth_expired',
          finalMessages: messages,
          newTurnMessages: messages.slice(turnStartIndex),
          turnToolNames,
        };
      }

      messages.push({ role: 'assistant', content: assistantContentBlocks });
      messages.push({ role: 'user', content: toolResults });

      for (const tc of pendingToolCalls.values()) turnToolNames.add(tc.name);
    } else {
      const isEmptyStop = !fullResponseText && !currentThinking;
      const hadToolUseThisTurn = turnToolNames.size > 0;
      if (isEmptyStop && emptyStopRetriesUsed < MAX_EMPTY_STOP_RETRIES) {
        emptyStopRetriesUsed++;
        if (hadToolUseThisTurn) pendingContinuationNudge = EMPTY_STOP_NUDGE;
        console.warn(`[Chat] Empty-stop on iter ${iterations} (finish=${finishReason ?? 'n/a'}) — retrying`);
        try {
          cl.streamError({
            taskId: opts.taskId, runId: opts.runId, errorKind: 'empty_stop',
            message: `Empty response (finish=${finishReason ?? 'n/a'}); retrying`,
            iteration: iterations, model: profile.id,
            payload: { retried: true, had_tool_use_this_turn: hadToolUseThisTurn },
          });
        } catch (logErr) { console.error('[Controllog] streamError error:', logErr); }
        continue;
      }
      if (isEmptyStop) {
        const terminalErrMsg = hadToolUseThisTurn
          ? 'The model ran your tool calls but stopped before writing a response, even after a nudge. Try breaking the request into smaller steps.'
          : 'The model returned an empty response twice in a row. This is usually an upstream hiccup — please try again.';
        opts.emit(sseError(terminalErrMsg));
        try {
          cl.streamError({
            taskId: opts.taskId, runId: opts.runId, errorKind: 'empty_stop',
            message: `Empty response after retry (finish=${finishReason ?? 'n/a'})`,
            iteration: iterations, model: profile.id, payload: { retried: false, terminal: true },
          });
        } catch (logErr) { console.error('[Controllog] streamError error:', logErr); }
      }

      if (finishReason === 'length') {
        opts.emit(sseError('Output length exceeded — the response was cut short. Try a more focused question.'));
        try {
          cl.streamError({
            taskId: opts.taskId, runId: opts.runId, errorKind: 'length_truncated',
            message: 'Response cut off by maxTokens cap', iteration: iterations, model: profile.id,
          });
        } catch (logErr) { console.error('[Controllog] streamError error:', logErr); }
      }

      if (!isEmptyStop && assistantContentBlocks.length > 0) {
        messages.push({ role: 'assistant', content: assistantContentBlocks });
      }

      continueLoop = false;
    }
  }

  const newTurnMessages = messages.slice(turnStartIndex);
  if (newTurnMessages.length > 0) {
    opts.emit(sseTurnComplete(newTurnMessages));
  }

  if (contextPaused) {
    return { finishReason: 'context_pause', finalMessages: messages, newTurnMessages, turnToolNames };
  }

  if (iterations >= MAX_ITERATIONS) {
    opts.emit(sseError(`Iteration limit reached (${MAX_ITERATIONS}) — the agent was still working but had to stop.`));
    try {
      cl.streamError({
        taskId: opts.taskId, runId: opts.runId, errorKind: 'iteration_limit',
        message: `Hit MAX_ITERATIONS=${MAX_ITERATIONS}`, iteration: iterations, model: profile.id,
      });
    } catch (logErr) { console.error('[Controllog] streamError error:', logErr); }
    return { finishReason: 'iteration_limit', finalMessages: messages, newTurnMessages, turnToolNames };
  }

  return { finishReason: 'done', finalMessages: messages, newTurnMessages, turnToolNames };
}
