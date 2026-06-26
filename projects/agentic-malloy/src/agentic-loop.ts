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
import { streamChatCompletion, parseCacheTokens, type ChatMessage, type ContentBlock, type ToolSchema } from './llm-client.js';
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
  /** When true, the consecutive-compile-error trigger injects a content-bearing
   *  steer and keeps the AUTHOR model (up to STEER_BUDGET times) instead of
   *  failing over to the fixer model. The arm is opus-free only if the caller also
   *  pins fixerModel === authorModel (the CLI flag does this). Default false. */
  steerInsteadOfEscalate?: boolean;
  reasoningEffort?: string;
  provider?: string; // pin OpenRouter to a single upstream provider
  taskId: string;
  runId: string;
  onEvent?: (e: { kind: string; detail?: unknown }) => void;
}

export interface TaskUsage {
  promptTokens: number;
  completionTokens: number;
  cost: number;
  /** Prompt tokens served from cache (cache HIT) across all turns. */
  cachedTokens: number;
  /** Prompt tokens written to cache (cache WRITE) across all turns. */
  cacheWriteTokens: number;
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
  /** Set when the loop ended because a model stream failed (transport/setup),
   *  so the harness can distinguish a real stream failure from a plain
   *  turns-exhausted hit-limit. null when no stream failure occurred. */
  streamFailureReason: string | null;
  /** True if the author was given its one forced submit-now recovery turn. */
  authorRecoveryUsed: boolean;
  /** In-place stuck-author steers issued (--steer-instead-of-escalate); 0 otherwise. */
  steersUsed: number;
  /** Total OpenRouter stream-setup retries across all turns (telemetry). */
  retryCount: number;
  /** The full bundled conversation (OpenAI Responses-item shape: user / message /
   *  function_call / function_call_output) so the dive can render the COMPLETE
   *  trace — model text + reasoning + every call/result — not just tool I/O. */
  trace: TraceItem[];
}

/** One conversation item, matching the reference dive's `raw_response.messages`. */
export interface TraceItem {
  step: 'user' | 'message' | 'function_call' | 'function_call_output';
  role?: string; // author | fixer (for message/function_call)
  name?: string; // tool name (function_call / output)
  arguments?: string; // JSON args (function_call)
  output?: string; // tool result text (function_call_output)
  content?: string; // message / user text
  status?: 'ok' | 'error'; // function_call_output
}

// All three steer/recovery/fixer prompts are FLAG-AWARE on the SQL fallback: when
// it's disabled (Malloy-only arm), they must NOT mention submit_sql — otherwise the
// run measures a rejected-tool/contradicted-prompt mismatch instead of a clean
// no-SQL condition (submit_sql is also dropped from the tool schemas when off).
function fixerInstruction(sqlOn: boolean): string {
  return (
    'You are the senior fixer. The author got stuck (repeated Malloy compile/execution errors or ran out of turns). ' +
    'Review the conversation and the diagnostics above, then ' +
    (sqlOn
      ? 'either write CORRECT Malloy and call submit_answer, or — if Malloy is the problem — compute the answer in SQL and call submit_sql (scored identically). '
      : 'write CORRECT Malloy and call submit_answer. ') +
    'Prefer reusing a layer view (see list_views); keep the per-query Malloy minimal.'
  );
}

// Before escalating terminal prose to the expensive fixer, give the SAME author
// one forced recovery turn: it already has the working context, so the common
// "stopped without submitting" case is usually a missing tool call, not a hard
// authoring failure. Only if recovery still doesn't submit do we hand off.
function authorRecoveryInstruction(sqlOn: boolean): string {
  return (
    'You stopped without submitting, so nothing was recorded and this scores zero. Do NOT explain — ' +
    (sqlOn
      ? 'call submit_answer now with the Malloy whose compiled-SQL result IS the answer (or submit_sql with raw SQL if Malloy is the blocker). '
      : 'call submit_answer now with the Malloy whose compiled-SQL result IS the answer. ') +
    'Reuse the work above.'
  );
}

// Shown once when run_malloy/submit_answer fails with the SAME error twice in a
// row — the agent is looping, usually on a layer defect it cannot fix by editing
// its query. Steer it off the dead view: to the SQL fallback when enabled, else to
// a different view/source.
function sameErrorSteer(sqlOn: boolean): string {
  return (
    'That run_malloy attempt failed with the SAME error as your previous one — re-running or re-reading layer files will NOT fix it. ' +
    'If the error is inside the COMPILED SQL (e.g. a binder/scope error like "Referenced table ... not found"), it is a defect in the central layer view, not in your query — stop using that view. ' +
    (sqlOn
      ? 'Instead: use the `query` (SQL) tool to compute the answer directly, then call `submit_sql` with that SQL — it runs on MotherDuck and is scored exactly like a Malloy answer. Do NOT wrap SQL inside Malloy (`duckdb.sql(...)` is rejected).'
      : 'Instead: pivot to a DIFFERENT layer view or source that does not depend on the broken one, and submit_answer with that Malloy.')
  );
}

// Shown (in --steer-instead-of-escalate mode) on N consecutive Malloy-authoring
// errors INSTEAD of escalating to the fixer model. Operationalizes what opus did
// when it "rescued" these tasks: read the exact field names rather than guessing,
// apply the Malloy form named in the diagnostic, switch off a broken view, or fall
// back to submit_sql. General (no dataset-specific nouns); flag-aware on SQL.
function stuckAuthorSteer(n: number, sqlOn: boolean): string {
  return (
    `You've hit ${n} Malloy compile errors in a row — re-running the same shape will NOT clear them. Diagnose by cause, then fix:\n` +
    "- \"'X' is not defined\": you are guessing a column name. Do NOT guess — call list_columns (or get_file on the source) and use the EXACT field names verbatim.\n" +
    '- select / avg / aggregate / date-type errors: these are SQL habits Malloy rejects. Read the diagnostic literally — a reduction uses group_by: + aggregate:, never select:.\n' +
    '- If the COMPILED SQL errors (a binder/scope error), the layer view itself is broken — switch to a DIFFERENT view or source.\n' +
    (sqlOn
      ? 'If Malloy keeps fighting you, compute the answer with the `query` (SQL) tool and call `submit_sql` — it runs on MotherDuck and is scored identically. Do NOT wrap SQL inside Malloy.'
      : 'Pivot to a DIFFERENT layer view/source that does not depend on the broken one, and submit_answer with that Malloy.')
  );
}

/** Collapse an error message to a signature (drop digits/aliases/punctuation) so
 *  "table m_0 not found" and "table mm_1 not found" compare equal. */
function normErrSig(s: string): string {
  return s.toLowerCase().replace(/[^a-z]+/g, ' ').trim().slice(0, 120);
}

interface ParsedTurn {
  assistantBlocks: ContentBlock[];
  toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>;
  text: string;
  usage: { promptTokens: number; completionTokens: number; cost?: number; cachedTokens: number; cacheWriteTokens: number };
}

export async function streamOneTurn(opts: {
  model: string;
  messages: ChatMessage[];
  tools: ToolSchema[];
  systemPrompt: string;
  reasoningEffort?: string;
  provider?: string;
  onRetryCount?: (n: number) => void;
}): Promise<ParsedTurn> {
  const retryReport = { retryCount: 0 };
  const stream = await streamChatCompletion({
    model: opts.model,
    messages: opts.messages,
    tools: opts.tools,
    systemPrompt: opts.systemPrompt,
    reasoningEffort: opts.reasoningEffort,
    provider: opts.provider,
    retryReport,
  });
  opts.onRetryCount?.(retryReport.retryCount);
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  const pending = new Map<number, { id: string; name: string; args: string }>();
  const usage = { promptTokens: 0, completionTokens: 0, cost: undefined as number | undefined, cachedTokens: 0, cacheWriteTokens: 0 };

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
        // Cache telemetry (cache HIT/WRITE) from the final usage chunk.
        const ct = parseCacheTokens(chunk.usage);
        usage.cachedTokens = ct.cachedTokens;
        usage.cacheWriteTokens = ct.cacheWriteTokens;
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
  // SQL fallback on unless explicitly disabled — gates the submit_sql wording in
  // the fixer/recovery/steer prompts so a --no-sql-fallback run is a clean no-SQL
  // condition (submit_sql is also absent from the tool schemas then).
  const sqlOn = deps.allowSqlFallback !== false;
  const howToAnswer = sqlOn
    ? 'Follow the skill: find a layer view (or author Malloy) and submit_answer; if no view fits and Malloy fights you, compute it in SQL and submit_sql.'
    : 'Follow the skill: browse the Malloy layer, then author Malloy and submit_answer. The answer must be Malloy.';
  const taskPrompt = `Question: ${opts.question}\n\nGuidelines: ${opts.guidelines || '(none)'}\n\n${howToAnswer}`;
  const messages: ChatMessage[] = [{ role: 'user', content: taskPrompt }];
  // Full bundled conversation for the dive's complete trace view (not just tool I/O).
  const trace: TraceItem[] = [{ step: 'user', content: taskPrompt }];

  let activeModel = opts.authorModel;
  let role: 'author' | 'fixer' = 'author';
  let escalated = false;
  let escalationReason: string | null = null;
  let consecutiveErrors = 0;
  let authorTurns = 0;
  let fixerTurns = 0;
  let toolCallCount = 0;
  let streamFailureReason: string | null = null;
  let authorRecoveryUsed = false; // the author's one forced submit-now turn
  let retryCount = 0;
  let prevMalloyErrSig: string | null = null; // last turn's run_malloy/submit error signature
  let steersUsed = 0; // stuck-author steers issued (--steer-instead-of-escalate)
  const STEER_BUDGET = 2; // after this many in-place steers, fall back to escalate()
  const usage: TaskUsage = { promptTokens: 0, completionTokens: 0, cost: 0, cachedTokens: 0, cacheWriteTokens: 0 };
  // Hard ceiling only; each role is bounded separately below so the expensive
  // fixer can never run past --max-fixer-turns regardless of when it escalated.
  const HARD_CAP = opts.maxAuthorTurns + opts.maxFixerTurns;

  const escalate = (reason: string) => {
    escalated = true;
    escalationReason = reason;
    activeModel = opts.fixerModel;
    role = 'fixer';
    consecutiveErrors = 0;
    messages.push({ role: 'user', content: fixerInstruction(sqlOn) });
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
        provider: opts.provider,
        onRetryCount: (n) => { retryCount += n; },
      });
    } catch (e) {
      // A stream-setup failure that survived the retry policy. Record the reason
      // so the harness reports it as a stream failure, not a generic hit-limit.
      streamFailureReason = e instanceof Error ? e.message : String(e);
      opts.onEvent?.({ kind: 'stream_error', detail: streamFailureReason });
      break;
    }
    const wallMs = Date.now() - t0;

    usage.promptTokens += parsed.usage.promptTokens;
    usage.completionTokens += parsed.usage.completionTokens;
    if (parsed.usage.cost) usage.cost += parsed.usage.cost;
    usage.cachedTokens += parsed.usage.cachedTokens;
    usage.cacheWriteTokens += parsed.usage.cacheWriteTokens;

    cl.modelPrompt({ taskId, runId, provider: 'openrouter', model: activeModel, promptTokens: parsed.usage.promptTokens, exchangeId, role, payload: { turn } });
    cl.modelCompletion({
      taskId, runId, provider: 'openrouter', model: activeModel,
      completionTokens: parsed.usage.completionTokens, wallMs, exchangeId, costMoney: parsed.usage.cost, role,
      payload: { turn, has_tool_use: parsed.toolCalls.length > 0, cached_tokens: parsed.usage.cachedTokens, cache_write_tokens: parsed.usage.cacheWriteTokens },
    });
    // Bundle the assistant's own text (the reasoning/narrative the tool-events
    // reconstruction can't show) into the trace.
    if (parsed.text.trim()) trace.push({ step: 'message', role, content: parsed.text.trim() });

    if (parsed.toolCalls.length === 0) {
      // Terminal text without a submission. The author gets ONE forced
      // submit-now recovery turn FIRST (it already has the context, so this is
      // usually just a missing tool call) — only if that still fails do we
      // escalate to the expensive fixer. The fixer's own terminal prose ends
      // the loop.
      if (!deps.state.submitted && role === 'author') {
        if (!authorRecoveryUsed) {
          authorRecoveryUsed = true;
          messages.push({ role: 'assistant', content: parsed.assistantBlocks });
          messages.push({ role: 'user', content: authorRecoveryInstruction(sqlOn) });
          opts.onEvent?.({ kind: 'author_recovery', detail: 'terminal text — forced submit-now' });
          continue;
        }
        escalate('author produced terminal text without submitting (after recovery)');
        continue;
      }
      break;
    }

    messages.push({ role: 'assistant', content: parsed.assistantBlocks });
    const toolResults: ContentBlock[] = [];
    let anyError = false;
    let malloyErr: string | null = null; // the run_malloy/submit_answer error this turn
    for (const call of parsed.toolCalls) {
      toolCallCount++;
      const callId = call.id || cl.newId();
      cl.toolCall({ taskId, runId, name: call.name, callId, arguments: call.input, model: activeModel });
      trace.push({ step: 'function_call', role, name: call.name, arguments: JSON.stringify(call.input) });
      const ts = Date.now();
      let result;
      try {
        result = await dispatchTool(deps, call.name, call.input);
      } catch (e) {
        result = { content: `Error: ${e instanceof Error ? e.message : String(e)}`, isError: true };
      }
      cl.toolResult({ taskId, runId, name: call.name, callId, ok: !result.isError, durationMs: Date.now() - ts, model: activeModel, output: result.content.slice(0, 2000) });
      trace.push({ step: 'function_call_output', name: call.name, output: result.content.slice(0, 2000), status: result.isError ? 'error' : 'ok' });
      toolResults.push({ type: 'tool_result', tool_use_id: callId, content: result.content, ...(result.isError && { is_error: true }) });
      // Only Malloy-authoring failures count toward escalation — an exploration
      // query/list_columns error is normal iteration, not a "stuck author".
      if (result.isError && (call.name === 'run_malloy' || call.name === 'submit_answer')) { anyError = true; malloyErr = result.content; }
      opts.onEvent?.({ kind: 'tool', detail: { name: call.name, ok: !result.isError } });
    }
    messages.push({ role: 'user', content: toolResults });

    if (deps.state.submitted) break;

    const errSig = malloyErr ? normErrSig(malloyErr) : null;
    consecutiveErrors = anyError ? consecutiveErrors + 1 : 0;
    // Author max-turns escalation is handled at the top of the loop; here we act
    // on repeated tool errors. Exactly one of these fires per turn:
    //  1. steer-in-place (flagged): keep the author model, inject a steer, continue;
    //  2. escalate to the fixer (default, or after the steer budget is spent);
    //  3. one-shot same-error nudge when neither (1) nor (2) tripped this turn.
    const stuck = role === 'author' && consecutiveErrors >= opts.escalateAfter;
    if (stuck && opts.steerInsteadOfEscalate && steersUsed < STEER_BUDGET) {
      messages.push({ role: 'user', content: stuckAuthorSteer(consecutiveErrors, sqlOn) });
      opts.onEvent?.({ kind: 'stuck_author_steer', detail: errSig?.slice(0, 80) ?? null });
      steersUsed++;
      consecutiveErrors = 0; // give the author a fresh streak after the steer
    } else if (stuck) {
      escalate(`${consecutiveErrors} consecutive tool errors`);
    } else if (errSig && errSig === prevMalloyErrSig) {
      // Looping on the SAME error (often a layer binder/scope bug it can't fix by
      // rewriting). One-shot nudge off the dead view.
      messages.push({ role: 'user', content: sameErrorSteer(sqlOn) });
      opts.onEvent?.({ kind: 'repeat_error_steer', detail: errSig.slice(0, 80) });
    }
    prevMalloyErrSig = errSig;
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
    streamFailureReason,
    authorRecoveryUsed,
    steersUsed,
    retryCount,
    trace,
  };
}
