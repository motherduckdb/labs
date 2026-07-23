import { streamChatCompletion as defaultStreamChatCompletion } from './llm-client';
import type { ModelProfile } from './llm-client';
import { dispatchTool as defaultDispatchTool } from './tool-dispatch';
import { requiresConfirmation } from './mcp-client';
import { buildGeminiDiveSupplement } from './gemini-dive-guide';
import {
  stepMvizFence,
  flushMvizFence,
  createMvizFenceState,
  buildMvizFallbackHtml,
} from './mviz-fence';
import * as cl from './controllog';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { TurnSink, AgenticLoopFinishReason } from './turn-sink';

/** data-chat-mini types/chat.ts ThinkingLevel — not ported into ./types, so it lives here. */
export type ThinkingLevel = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export type { AgenticLoopFinishReason } from './turn-sink';

/**
 * The agentic loop — calls the LLM, dispatches MCP tool calls, and repeats
 * until the model produces a terminal text response.
 *
 * Ported from data-chat-mini's lib/agentic-loop.ts with two deliberate changes:
 *   1. SSE emission is replaced by a TurnSink (see turn-sink.ts) — the loop is
 *      transport-agnostic and the Slack layer supplies the sink.
 *   2. No context-layer interception. data-chat-mini paused the loop for a
 *      browser/IndexedDB round-trip on its invented query_context_layer /
 *      update_context_layer tool shapes; quackbot's durable memory is the real
 *      MotherDuck guides tools (see mcp-client.ts), which flow through
 *      dispatchTool like any other tool — the 'context_pause' finish reason no
 *      longer exists.
 */

export interface RunAgenticLoopOpts {
  messages: Array<{ role: string; content: unknown }>;
  turnStartIndex: number;
  profile: ModelProfile;
  thinkingLevel: ThinkingLevel;
  client: Client;
  tools: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>;
  systemPrompt: string;
  sink: TurnSink;
  taskId: string;
  runId: string;
  requestText: string;
  historyLength: number;
  streamChatCompletion?: typeof defaultStreamChatCompletion;
  dispatchToolImpl?: typeof defaultDispatchTool;
  /**
   * How the dive-authoring guide (`get_dive_guide`) is resolved on Gemini
   * profiles. `fetchStock` dispatches the REAL server guide via MCP and returns
   * its text. Default: the real stock guide with `buildGeminiDiveSupplement()`
   * appended — the Phase-3 winner (see gemini-dive-guide.ts). Overridable so the
   * Phase-3 benchmark (scripts/bench-dive-guide.ts) can drive the stock-alone
   * and full-override arms through the identical loop.
   */
  resolveGeminiDiveGuide?: (fetchStock: () => Promise<string>) => Promise<string>;
  /**
   * Gate for tools that `requiresConfirmation` flags (durable writes). Resolves
   * true to proceed, false to skip. When omitted, no confirmation is requested
   * and writes proceed — the Slack layer always supplies one; test/other
   * callers opt in explicitly.
   */
  confirmTool?: (call: { id: string; name: string; args: Record<string, unknown> }) => Promise<boolean>;
}

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
          opts.sink.onThinking(thinking);
        }

        if (delta.content) {
          fullResponseText += delta.content;

          const { events: mvizEvents, newState } = stepMvizFence(fullResponseText, mvizState);
          mvizState = newState;
          for (const ev of mvizEvents) {
            if (ev.kind === 'text') {
              opts.sink.onText(ev.content);
            } else if (ev.kind === 'mviz_pending') {
              opts.sink.onMvizPending(ev.id);
            } else if (ev.kind === 'mviz_block') {
              let html: string | null = null;
              try {
                const { processMvizMarkdown } = await import('./mviz-processor');
                const rendered = processMvizMarkdown(ev.source);
                if (rendered) html = rendered;
              } catch (err) {
                console.error('[Chat] inline mviz error:', err);
              }
              if (html) {
                opts.sink.onMvizBlock({ id: ev.id ?? '', source: ev.source, html });
              } else {
                opts.sink.onMvizBlock({
                  id: ev.id ?? '',
                  source: ev.source,
                  html: buildMvizFallbackHtml('The chart block failed to render — malformed mviz spec.'),
                  fallback: true,
                });
              }
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
        opts.sink.onText(ev.content);
      } else if (ev.kind === 'mviz_fallback') {
        opts.sink.onMvizBlock({
          id: ev.id,
          source: '',
          html: buildMvizFallbackHtml('The chart block was cut off before it finished streaming.'),
          fallback: true,
        });
      }
    }

    if (currentThinking) {
      assistantContentBlocks.push({ type: 'thinking', thinking: currentThinking });
      opts.sink.onThinkingDone();
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

    opts.sink.onUsage({
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      ...(usage.cachedPromptTokens !== undefined && { cachedPromptTokens: usage.cachedPromptTokens }),
      ...(usage.reasoningTokens !== undefined && { reasoningTokens: usage.reasoningTokens }),
      ...(usage.cost !== undefined && { cost: usage.cost }),
      model: profile.id,
      contextWindow: profile.contextWindow,
    });

    if (hasToolUse) {
      const toolResults: Array<{ type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }> = [];
      let authExpired = false;

      for (const block of assistantContentBlocks) {
        if (block.type !== 'tool_use') continue;
        const toolId = block.id as string;
        const toolName = block.name as string;
        const toolInput = block.input as Record<string, unknown>;

        opts.sink.onToolStart({ id: toolId, name: toolName, args: toolInput });

        // The dive-authoring guide (`get_dive_guide`) gets a Gemini-specific
        // augmentation: fetch the REAL stock server guide, then append
        // `buildGeminiDiveSupplement()` — the guardrails the stock guide still
        // lacks (never-print-source, REQUIRED_DATABASES parser edge cases, the
        // wrong-hook negative examples, the read_dive-same-turn rule, …). The
        // stock guide alone let Gemini drop REQUIRED_DATABASES ~half the time
        // (mdw-turbo #149); the full ~40K-token local override that used to sit
        // here fixed that but cost ~2.6× the tokens and scored WORSE on
        // first-attempt saves. Phase 3 (MCP_MIGRATION_PLAN.md,
        // scripts/bench-dive-guide.ts) benchmarked all three and stock+supplement
        // won. Other model families get the plain stock guide via dispatchTool.
        if (
          toolName === 'get_dive_guide' &&
          /gemini/i.test(profile.id)
        ) {
          const tStart = Date.now();
          const fetchStock = async (): Promise<string> => {
            const dispatchTool = opts.dispatchToolImpl ?? defaultDispatchTool;
            const dispatch = await dispatchTool({ client: opts.client, name: toolName, args: toolInput });
            return dispatch.content;
          };
          const resolve =
            opts.resolveGeminiDiveGuide ??
            (async (fetch) => `${await fetch()}\n\n${buildGeminiDiveSupplement()}`);
          const content = await resolve(fetchStock);
          toolResults.push({ type: 'tool_result', tool_use_id: toolId, content });
          opts.sink.onToolEnd({ id: toolId, name: toolName, result: content.slice(0, 500) });
          try {
            cl.toolEnd({
              taskId: opts.taskId, runId: opts.runId,
              toolName, toolUseId: toolId, ok: true,
              durationMs: Date.now() - tStart, resultBytes: content.length,
              iteration: iterations,
              payload: { gemini_supplement: true },
            });
          } catch (logErr) {
            console.error('[Controllog] toolEnd error:', logErr);
          }
          continue;
        }

        // Durable writes (create_guide / update_guide / save_dive) pause for an
        // explicit user Approve before running — this is the block that stops a
        // prompt-injected write from committing unattended. On deny/timeout the
        // tool is skipped with an error tool_result so the round stays paired.
        if (opts.confirmTool && requiresConfirmation(toolName, toolInput)) {
          const approved = await opts.confirmTool({ id: toolId, name: toolName, args: toolInput });
          if (!approved) {
            const declined = `The user declined to run ${toolName}. Do not retry it — continue without this write.`;
            toolResults.push({ type: 'tool_result', tool_use_id: toolId, content: declined, is_error: true });
            opts.sink.onToolEnd({ id: toolId, name: toolName, result: declined, error: true });
            try {
              cl.toolEnd({
                taskId: opts.taskId, runId: opts.runId,
                toolName, toolUseId: toolId, ok: false,
                durationMs: 0, iteration: iterations,
                payload: { declined: true },
              });
            } catch (logErr) {
              console.error('[Controllog] toolEnd error:', logErr);
            }
            continue;
          }
        }

        const tStart = Date.now();
        try {
          const dispatchTool = opts.dispatchToolImpl ?? defaultDispatchTool;
          const dispatch = await dispatchTool({ client: opts.client, name: toolName, args: toolInput });
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolId,
            content: dispatch.content,
            ...(dispatch.isError && { is_error: true }),
          });
          opts.sink.onToolEnd({
            id: toolId, name: toolName, result: dispatch.content.slice(0, 500),
            ...(dispatch.isError && { error: true }),
          });
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
          opts.sink.onToolEnd({ id: toolId, name: toolName, result: `Error: ${errMsg}`, error: true });
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
            opts.sink.onAuthExpired('Your MotherDuck connection failed. Check MOTHERDUCK_TOKEN.');
            authExpired = true;
            break;
          }
        }
      }

      if (authExpired) {
        // The auth break exits mid-round: later tool_use blocks in this
        // assistant message never ran and have no tool_result yet. Persisting
        // an unpaired tool_use corrupts the thread history — the next model
        // call converts each assistant tool_call into OpenAI format, which
        // requires a matching `role: tool` message. Pair every leftover
        // tool_use with a synthetic error result so the round stays
        // well-formed. (The data-chat-mini source has this same hole; fixed
        // here rather than ported.)
        const answeredIds = new Set(toolResults.map(r => r.tool_use_id));
        for (const block of assistantContentBlocks) {
          if (block.type !== 'tool_use') continue;
          const id = block.id as string;
          if (answeredIds.has(id)) continue;
          toolResults.push({
            type: 'tool_result',
            tool_use_id: id,
            content: 'Error: MotherDuck auth expired before this tool ran.',
            is_error: true,
          });
        }
        messages.push({ role: 'assistant', content: assistantContentBlocks });
        messages.push({ role: 'user', content: toolResults });
        for (const tc of pendingToolCalls.values()) turnToolNames.add(tc.name);
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
        opts.sink.onError(terminalErrMsg);
        try {
          cl.streamError({
            taskId: opts.taskId, runId: opts.runId, errorKind: 'empty_stop',
            message: `Empty response after retry (finish=${finishReason ?? 'n/a'})`,
            iteration: iterations, model: profile.id, payload: { retried: false, terminal: true },
          });
        } catch (logErr) { console.error('[Controllog] streamError error:', logErr); }
      }

      if (finishReason === 'length') {
        opts.sink.onError('Output length exceeded — the response was cut short. Try a more focused question.');
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
  const hitIterationLimit = iterations >= MAX_ITERATIONS;
  if (newTurnMessages.length > 0) {
    opts.sink.onTurnComplete(hitIterationLimit ? 'iteration_limit' : 'done');
  }

  if (hitIterationLimit) {
    opts.sink.onError(`Iteration limit reached (${MAX_ITERATIONS}) — the agent was still working but had to stop.`);
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
