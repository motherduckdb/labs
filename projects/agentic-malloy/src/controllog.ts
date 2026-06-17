/**
 * controllog emitter — forked from data-chat-mini/lib/controllog.ts and EXTENDED
 * with the builders this experiment needs (runMetadata, toolCall/toolResult,
 * stateMove, utility, generic event/post). Writes the same events.jsonl /
 * postings.jsonl schema (spec-v1.1) the Python controllog-viz already consumes —
 * no viz/schema changes.
 *
 * No-double-counting ownership (single source of truth per quantity):
 *   - model events (modelPrompt/modelCompletion) own token, cost, model-wall postings
 *   - tool events (toolResult) own tool-latency postings only
 *   - stateMove owns state; utility owns utility
 *   - a task_complete event (emitted via event() in the harness) carries NO
 *     token/cost/wall postings — task wall-time is a plain payload field.
 */
import { appendFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { uuid7 } from './uuid7.js';

export interface Posting {
  account_type: string;
  account_id: string;
  unit: string;
  delta_numeric: number;
  dims_json: Record<string, unknown>;
}
interface EventRow {
  event_id: string;
  event_time: string;
  ingest_time: string;
  kind: string;
  actor_agent_id: string | null;
  actor_task_id: string | null;
  project_id: string;
  run_id: string | null;
  source: string;
  idempotency_key: string;
  payload_json: Record<string, unknown>;
}
interface PostingRow extends Posting {
  posting_id: string;
  event_id: string;
}
export interface Session {
  id: string;
  events: EventRow[];
  postings: PostingRow[];
}

let projectId = 'agentic-malloy';
let baseLogDir = 'results';
let agentId = 'agent:asm-malloy';
const als = new AsyncLocalStorage<Session>();

export function init(opts: { project?: string; logDir?: string; agentId?: string }): void {
  if (opts.project) projectId = opts.project;
  if (opts.logDir) baseLogDir = opts.logDir;
  if (opts.agentId) agentId = opts.agentId;
}

export function newId(): string {
  return uuid7();
}
export function createSession(): Session {
  return { id: uuid7(), events: [], postings: [] };
}
export function runInSession<T>(session: Session, fn: () => Promise<T>): Promise<T> {
  return als.run(session, fn);
}
function nowIso(): string {
  return new Date().toISOString();
}
function stableHash(obj: unknown): string {
  const canonical = JSON.stringify(obj, Object.keys(obj as object).sort());
  return createHash('sha256').update(canonical).digest('hex');
}

export function post(
  account_type: string,
  account_id: string,
  unit: string,
  delta: number,
  dims: Record<string, unknown> = {},
): Posting {
  return { account_type, account_id, unit, delta_numeric: delta, dims_json: dims };
}

export interface EmitOpts {
  kind: string;
  taskId?: string;
  agentId?: string;
  runId?: string;
  payload?: Record<string, unknown>;
  postings?: Posting[];
  idempotencyKey?: string;
}

export function event(opts: EmitOpts): void {
  const session = als.getStore();
  if (!session) return;
  const eventId = uuid7();
  session.events.push({
    event_id: eventId,
    event_time: nowIso(),
    ingest_time: nowIso(),
    kind: opts.kind,
    actor_agent_id: opts.agentId ?? null,
    actor_task_id: opts.taskId ?? null,
    project_id: projectId,
    run_id: opts.runId ?? null,
    source: 'runtime',
    idempotency_key: opts.idempotencyKey ?? eventId,
    payload_json: opts.payload ?? {},
  });
  (opts.postings ?? []).forEach((p, i) => {
    session.postings.push({ ...p, posting_id: `${eventId}-${i}`, event_id: eventId });
  });
}

// --- builders ----------------------------------------------------------------

export function modelPrompt(args: {
  taskId: string; runId: string; provider: string; model: string;
  promptTokens: number; exchangeId: string; role?: string; payload?: Record<string, unknown>;
}): void {
  event({
    kind: 'model_prompt',
    taskId: args.taskId, agentId, runId: args.runId,
    idempotencyKey: `${args.exchangeId}:prompt`,
    payload: { ...(args.payload ?? {}), provider: args.provider, model: args.model,
      prompt_tokens: args.promptTokens, phase: 'prompt', exchange_id: args.exchangeId,
      ...(args.role && { role: args.role }) },
    postings: [
      post('resource.tokens', `provider:${args.provider}`, '+tokens', -args.promptTokens, { model: args.model, phase: 'prompt' }),
      post('resource.tokens', `project:${projectId}`, '+tokens', +args.promptTokens, { model: args.model, phase: 'prompt' }),
    ],
  });
}

export function modelCompletion(args: {
  taskId: string; runId: string; provider: string; model: string;
  completionTokens: number; wallMs: number; exchangeId: string; costMoney?: number;
  role?: string; payload?: Record<string, unknown>;
}): void {
  const postings: Posting[] = [
    post('resource.tokens', `provider:${args.provider}`, '+tokens', -args.completionTokens, { model: args.model, phase: 'completion' }),
    post('resource.tokens', `project:${projectId}`, '+tokens', +args.completionTokens, { model: args.model, phase: 'completion' }),
    post('truth.time', agentId, 'ms', -args.wallMs, { kind: 'wall', ...(args.role && { role: args.role }) }),
    post('truth.time', `project:${projectId}`, 'ms', +args.wallMs, { kind: 'wall', ...(args.role && { role: args.role }) }),
  ];
  if (args.costMoney !== undefined) {
    postings.push(
      post('truth.money', `vendor:${args.provider}`, '$', -args.costMoney, { model: args.model, ...(args.role && { role: args.role }) }),
      post('truth.money', `project:${projectId}`, '$', +args.costMoney, { model: args.model, ...(args.role && { role: args.role }) }),
    );
  }
  event({
    kind: 'model_completion',
    taskId: args.taskId, agentId, runId: args.runId,
    idempotencyKey: `${args.exchangeId}:completion`,
    payload: { ...(args.payload ?? {}), provider: args.provider, model: args.model,
      completion_tokens: args.completionTokens, wall_ms: args.wallMs, phase: 'completion',
      exchange_id: args.exchangeId, ...(args.role && { role: args.role }) },
    postings,
  });
}

export function toolCall(args: {
  taskId: string; runId: string; name: string; callId: string;
  arguments?: unknown; model?: string; payload?: Record<string, unknown>;
}): void {
  event({
    kind: 'tool_call',
    taskId: args.taskId, agentId, runId: args.runId,
    idempotencyKey: `${args.callId}:tool_call`,
    payload: { ...(args.payload ?? {}), call_id: args.callId, name: args.name, phase: 'call',
      ...(args.arguments !== undefined && { arguments: args.arguments }),
      ...(args.model && { model: args.model }) },
  });
}

export function toolResult(args: {
  taskId: string; runId: string; name: string; callId: string;
  ok: boolean; durationMs: number; model?: string; output?: unknown;
  payload?: Record<string, unknown>;
}): void {
  event({
    kind: 'tool_result',
    taskId: args.taskId, agentId, runId: args.runId,
    idempotencyKey: `${args.callId}:tool_result`,
    payload: { ...(args.payload ?? {}), call_id: args.callId, name: args.name, phase: 'result',
      status: args.ok ? 'ok' : 'error', duration_ms: args.durationMs,
      ...(args.output !== undefined && { output: args.output }),
      ...(args.model && { model: args.model }) },
    postings: [
      post('truth.time', agentId, 'ms', -args.durationMs, { kind: 'tool', tool: args.name, ...(args.model && { model: args.model }) }),
      post('truth.time', `project:${projectId}`, 'ms', +args.durationMs, { kind: 'tool', tool: args.name, ...(args.model && { model: args.model }) }),
    ],
  });
}

export function stateMove(args: {
  taskId: string; from: string; to: string; runId?: string; idempotencyKey?: string;
}): void {
  event({
    kind: 'state_move',
    taskId: args.taskId, agentId, runId: args.runId,
    idempotencyKey: args.idempotencyKey ?? `${args.taskId}:${args.from}:${args.to}`,
    postings: [
      post('truth.state', `task:${args.taskId}`, 'tasks', -1, { from: args.from }),
      post('truth.state', `task:${args.taskId}`, 'tasks', +1, { to: args.to }),
    ],
  });
}

export function utility(args: {
  taskId: string; metric: string; value: number; runId?: string;
}): void {
  event({
    kind: 'utility',
    taskId: args.taskId, agentId, runId: args.runId,
    postings: [
      post('truth.utility', `task:${args.taskId}`, 'points', +args.value, { metric: args.metric }),
      post('truth.utility', `project:${projectId}`, 'points', -args.value, { metric: args.metric }),
    ],
  });
}

export function runMetadata(args: {
  runId: string; resolvedConfig: Record<string, unknown>;
  commitSha?: string; repo?: string; dirty?: boolean; agentName?: string;
  datasetName?: string; datasetVersion?: string; payload?: Record<string, unknown>;
}): Record<string, unknown> {
  const configHash = stableHash(args.resolvedConfig);
  const payload: Record<string, unknown> = {
    ...(args.payload ?? {}),
    resolved_config: args.resolvedConfig,
    config_hash: configHash,
    ...(args.commitSha && { commit_sha: args.commitSha }),
    ...(args.repo && { repo: args.repo }),
    ...(args.dirty !== undefined && { dirty: args.dirty }),
    ...(args.agentName && { agent_name: args.agentName }),
    ...(args.datasetName && { dataset_name: args.datasetName }),
    ...(args.datasetVersion && { dataset_version: args.datasetVersion }),
  };
  event({ kind: 'run_metadata', runId: args.runId, idempotencyKey: `${args.runId}:run_metadata`, payload });
  return payload;
}

/**
 * Append buffered events/postings to disk and DRAIN what was written, so this
 * is safe to call repeatedly (e.g. once per task) for crash-durable telemetry —
 * a mid-run crash then preserves everything emitted before it, instead of
 * discarding the whole in-memory buffer. Splicing only the rows we serialized
 * keeps any events emitted concurrently during the await for the next flush.
 */
export async function flushSession(session: Session): Promise<void> {
  if (session.events.length === 0 && session.postings.length === 0) return;
  const dir = path.join(baseLogDir, 'controllog');
  await mkdir(dir, { recursive: true });
  const events = session.events.splice(0, session.events.length);
  const postings = session.postings.splice(0, session.postings.length);
  if (events.length) {
    await appendFile(path.join(dir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  }
  if (postings.length) {
    await appendFile(path.join(dir, 'postings.jsonl'), postings.map((p) => JSON.stringify(p)).join('\n') + '\n');
  }
}
