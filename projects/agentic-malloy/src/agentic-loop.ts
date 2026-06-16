/**
 * Two-model author->fixer agentic loop. Ported from data-chat-mini's
 * runAgenticLoop (OpenRouter streaming, tool-call accumulation, usage tracking,
 * controllog wiring), trimmed of the web/SSE/mviz/context-tool coupling and
 * extended with the model-tiering escalation.
 *
 * The mid-tier AUTHOR drives tool calls; on repeated compile/exec errors or after
 * max author turns without submitting, we escalate to the expensive FIXER in the
 * same conversation. Tokens/cost accrue across both; controllog tags each
 * exchange + tool call with role + model.
 */
import { streamChatCompletion, type ChatMessage, type ContentBlock, type ToolSchema } from './llm-client.js';
import { dispatchTool, type ToolDeps } from './tools.js';
import * as cl from './controllog.js';

export interface RunTaskOpts {
  question: string;
  guidelines?: string | null;
  systemPrompt: string;
  toolSchemas: ToolSchema[];
  deps: ToolDeps;
  authorModel: string;
  fixerModel: string;
  escalateAfter: number;
  maxAuthorTurns: number;
  maxFixerTurns: number;
  reasoningEffort?: string;
  taskId: string;
  runId: string;
  onEvent?: (e: { kind: string; detail?: unknown }) => void;
}

export interface TaskUsage {
  promptTokens: number;
  completionTokens: number;
  cost: number;
}
export interface TaskResult {
  submitted: boolean;
  escalated: boolean;
  escalationReason: string | null;
  authorTurns: number;
  fixerTurns: number;
  toolCallCount: number;
  usage: TaskUsage;
  authorModel: string;
  fixerModel: string;
  hitLimit: boolean;
}

const FIXER_INSTRUCTION =
  'You are the senior fixer. The author got stuck (repeated Malloy compile/execution errors or ran out of turns). ' +
  'Review the conversation and the diagnostics above, then write CORRECT Malloy and call submit_answer. ' +
  'Prefer reusing the central layer; keep the per-query Malloy minimal.';

interface ParsedTurn {
  assistantBlocks: ContentBlock[];
  toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>;
  text: string;
  usage: { promptTokens: number; completionTokens: number; cost?: number };
}

async function streamOneTurn(opts: {
  model: string;
  messages: ChatMessage[];
  tools: ToolSchema[];
  systemPrompt: string;
  reasoningEffort?: string;
}): Promise<ParsedTurn> {
  const stream = await streamChatCompletion({
    model: opts.model,
    messages: opts.messages,
    tools: opts.tools,
    systemPrompt: opts.systemPrompt,
    reasoningEffort: opts.reasoningEffort,
  });
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  const pending = new Map<number, { id: string; name: string; args: string }>();
  const usage = { promptTokens: 0, completionTokens: 0, cost: undefined as number | undefined };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') continue;
      let chunk;
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }
      if (chunk.usage) {
        usage.promptTokens = chunk.usage.prompt_tokens || 0;
        usage.completionTokens = chunk.usage.completion_tokens || 0;
        if (typeof chunk.usage.cost === 'number') usage.cost = chunk.usage.cost;
        else if (chunk.usage.cost_details?.upstream_inference_cost) usage.cost = chunk.usage.cost_details.upstream_inference_cost;
      }
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta || {};
      if (delta.content) text += delta.content;
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          if (!pending.has(idx)) pending.set(idx, { id: tc.id || '', name: tc.function?.name || '', args: '' });
          const p = pending.get(idx)!;
          if (tc.id) p.id = tc.id;
          if (tc.function?.name) p.name = tc.function.name;
          if (tc.function?.arguments) p.args += tc.function.arguments;
        }
      }
    }
  }

  const assistantBlocks: ContentBlock[] = [];
  if (text) assistantBlocks.push({ type: 'text', text });
  const toolCalls: ParsedTurn['toolCalls'] = [];
  for (const [, tc] of pending) {
    let input: Record<string, unknown> = {};
    try {
      input = JSON.parse(tc.args || '{}');
    } catch {
      /* leave empty */
    }
    assistantBlocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input });
    toolCalls.push({ id: tc.id, name: tc.name, input });
  }
  return { assistantBlocks, toolCalls, text, usage };
}

export async function runTask(opts: RunTaskOpts): Promise<TaskResult> {
  const { deps, taskId, runId } = opts;
  const messages: ChatMessage[] = [
    {
      role: 'user',
      content: `Question: ${opts.question}\n\nGuidelines: ${opts.guidelines || '(none)'}\n\nFollow the skill: browse the Malloy layer, then author Malloy and submit_answer. The answer must be Malloy.`,
    },
  ];

  let activeModel = opts.authorModel;
  let role: 'author' | 'fixer' = 'author';
  let escalated = false;
  let escalationReason: string | null = null;
  let consecutiveErrors = 0;
  let authorTurns = 0;
  let fixerTurns = 0;
  let toolCallCount = 0;
  const usage: TaskUsage = { promptTokens: 0, completionTokens: 0, cost: 0 };
  // Hard ceiling only; each role is bounded separately below so the expensive
  // fixer can never run past --max-fixer-turns regardless of when it escalated.
  const HARD_CAP = opts.maxAuthorTurns + opts.maxFixerTurns;

  const escalate = (reason: string) => {
    escalated = true;
    escalationReason = reason;
    activeModel = opts.fixerModel;
    role = 'fixer';
    consecutiveErrors = 0;
    messages.push({ role: 'user', content: FIXER_INSTRUCTION });
    opts.onEvent?.({ kind: 'escalate', detail: reason });
  };

  for (let turn = 0; turn < HARD_CAP; turn++) {
    // Enforce the ACTIVE role's budget before spending a turn. (Cast: TS doesn't
    // track that `escalate` reassigns `role` inside its closure, so it over-narrows
    // `role` to 'author' here — at runtime it can be 'fixer' from a prior iteration.)
    const activeRole = role as 'author' | 'fixer';
    if (activeRole === 'fixer' && fixerTurns >= opts.maxFixerTurns) break;
    if (activeRole === 'author' && authorTurns >= opts.maxAuthorTurns) {
      if (deps.state.submitted) break;
      escalate('author hit max turns without submitting');
      if (fixerTurns >= opts.maxFixerTurns) break; // fixer already exhausted
    }
    if (role === 'author') authorTurns++;
    else fixerTurns++;

    const exchangeId = cl.newId();
    const t0 = Date.now();
    let parsed: ParsedTurn;
    try {
      parsed = await streamOneTurn({
        model: activeModel,
        messages,
        tools: opts.toolSchemas,
        systemPrompt: opts.systemPrompt,
        reasoningEffort: opts.reasoningEffort,
      });
    } catch (e) {
      opts.onEvent?.({ kind: 'stream_error', detail: e instanceof Error ? e.message : String(e) });
      break;
    }
    const wallMs = Date.now() - t0;

    usage.promptTokens += parsed.usage.promptTokens;
    usage.completionTokens += parsed.usage.completionTokens;
    if (parsed.usage.cost) usage.cost += parsed.usage.cost;

    cl.modelPrompt({ taskId, runId, provider: 'openrouter', model: activeModel, promptTokens: parsed.usage.promptTokens, exchangeId, role, payload: { turn } });
    cl.modelCompletion({
      taskId, runId, provider: 'openrouter', model: activeModel,
      completionTokens: parsed.usage.completionTokens, wallMs, exchangeId, costMoney: parsed.usage.cost, role,
      payload: { turn, has_tool_use: parsed.toolCalls.length > 0 },
    });

    if (parsed.toolCalls.length === 0) {
      // Terminal text without a submission. Nudge once via escalation if author.
      if (!deps.state.submitted && role === 'author') {
        escalate('author produced terminal text without submitting');
        continue;
      }
      break;
    }

    messages.push({ role: 'assistant', content: parsed.assistantBlocks });
    const toolResults: ContentBlock[] = [];
    let anyError = false;
    for (const call of parsed.toolCalls) {
      toolCallCount++;
      const callId = call.id || cl.newId();
      cl.toolCall({ taskId, runId, name: call.name, callId, arguments: call.input, model: activeModel });
      const ts = Date.now();
      let result;
      try {
        result = await dispatchTool(deps, call.name, call.input);
      } catch (e) {
        result = { content: `Error: ${e instanceof Error ? e.message : String(e)}`, isError: true };
      }
      cl.toolResult({ taskId, runId, name: call.name, callId, ok: !result.isError, durationMs: Date.now() - ts, model: activeModel, output: result.content.slice(0, 2000) });
      toolResults.push({ type: 'tool_result', tool_use_id: callId, content: result.content, ...(result.isError && { is_error: true }) });
      // Only Malloy-authoring failures count toward escalation — an exploration
      // query/list_columns error is normal iteration, not a "stuck author".
      if (result.isError && (call.name === 'run_malloy' || call.name === 'submit_answer')) anyError = true;
      opts.onEvent?.({ kind: 'tool', detail: { name: call.name, ok: !result.isError } });
    }
    messages.push({ role: 'user', content: toolResults });

    if (deps.state.submitted) break;

    consecutiveErrors = anyError ? consecutiveErrors + 1 : 0;
    // Author max-turns escalation is handled at the top of the loop; here we
    // only escalate early on repeated tool errors.
    if (role === 'author' && consecutiveErrors >= opts.escalateAfter) {
      escalate(`${consecutiveErrors} consecutive tool errors`);
    }
  }

  const hitLimit = !deps.state.submitted;
  return {
    submitted: deps.state.submitted,
    escalated,
    escalationReason,
    authorTurns,
    fixerTurns,
    toolCallCount,
    usage,
    authorModel: opts.authorModel,
    fixerModel: opts.fixerModel,
    hitLimit,
  };
}
