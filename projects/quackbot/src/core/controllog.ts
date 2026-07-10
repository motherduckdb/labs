/**
 * Slim controllog emitter — writes spec-compatible JSONL that the labs
 * `controllog` Python package can upload to MotherDuck and `controllog-viz`
 * can render. This is intentionally NOT the heavy mdw-turbo port: it only
 * emits, it does not upload. Hand off to the Python tooling for that:
 *
 *   pip install "controllog[duckdb] @ git+https://github.com/motherduckdb/labs#subdirectory=projects/controllog"
 *   python -c "from controllog import motherduck; from pathlib import Path; motherduck.upload(motherduck_db='data_chat_mini', log_dir=Path('logs'))"
 *
 * Schema follows docs/spec-v1.1.md exactly — including the `truth.money` /
 * `truth.time` account names (the mdw-turbo port diverged to `resource.*`,
 * which breaks controllog-viz cost/latency rollups; we do NOT repeat that).
 *
 * Layout: logs/controllog/{events,postings}.jsonl (flat, no date partition).
 */
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { uuid7 } from './uuid7';
import { isLoggingDisabled } from './logging-flag';

interface Posting {
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
  userHint?: string;
  events: EventRow[];
  postings: PostingRow[];
}

let projectId = 'quackbot';
let baseLogDir = 'logs';
const als = new AsyncLocalStorage<Session>();

export function init(project: string, logDir: string): void {
  projectId = project;
  baseLogDir = logDir;
}

export function newId(): string {
  return uuid7();
}

export function createSession(userHint?: string): Session {
  return { id: uuid7(), userHint, events: [], postings: [] };
}

export function runInSession<T>(session: Session, fn: () => Promise<T>): Promise<T> {
  return als.run(session, fn);
}

function nowIso(): string {
  return new Date().toISOString();
}

function post(
  account_type: string,
  account_id: string,
  unit: string,
  delta: number,
  dims: Record<string, unknown> = {},
): Posting {
  return { account_type, account_id, unit, delta_numeric: delta, dims_json: dims };
}

interface EmitOpts {
  kind: string;
  taskId?: string;
  agentId?: string;
  runId?: string;
  payload?: Record<string, unknown>;
  postings?: Posting[];
  idempotencyKey?: string;
}

function emit(opts: EmitOpts): void {
  if (isLoggingDisabled()) return;
  const session = als.getStore();
  if (!session) return; // no active session — drop (chat route always wraps in one)

  const eventId = uuid7();
  const event: EventRow = {
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
  };
  session.events.push(event);
  (opts.postings ?? []).forEach((p, i) => {
    session.postings.push({ ...p, posting_id: `${eventId}-${i}`, event_id: eventId });
  });
}

const AGENT = 'agent:quackbot';

export function modelPrompt(args: {
  taskId: string; agentId?: string; runId: string; provider: string; model: string;
  promptTokens: number; exchangeId: string; requestText?: string; payload?: Record<string, unknown>;
}): void {
  emit({
    kind: 'model_prompt',
    taskId: args.taskId, agentId: args.agentId ?? AGENT, runId: args.runId,
    idempotencyKey: `${args.exchangeId}:prompt`,
    payload: {
      ...(args.payload ?? {}),
      provider: args.provider, model: args.model,
      prompt_tokens: args.promptTokens, phase: 'prompt', exchange_id: args.exchangeId,
      ...(args.requestText !== undefined && { request_text: args.requestText }),
    },
    postings: [
      post('resource.tokens', `provider:${args.provider}`, '+tokens', -args.promptTokens, { model: args.model, phase: 'prompt' }),
      post('resource.tokens', `project:${projectId}`, '+tokens', +args.promptTokens, { model: args.model, phase: 'prompt' }),
    ],
  });
}

export function modelCompletion(args: {
  taskId: string; agentId?: string; runId: string; provider: string; model: string;
  completionTokens: number; wallMs: number; exchangeId: string; responseText?: string;
  costMoney?: number; payload?: Record<string, unknown>;
}): void {
  const postings: Posting[] = [
    post('resource.tokens', `provider:${args.provider}`, '+tokens', -args.completionTokens, { model: args.model, phase: 'completion' }),
    post('resource.tokens', `project:${projectId}`, '+tokens', +args.completionTokens, { model: args.model, phase: 'completion' }),
    post('truth.time', `agent:${args.agentId ?? AGENT}`, 'ms', -args.wallMs, { kind: 'wall' }),
    post('truth.time', `project:${projectId}`, 'ms', +args.wallMs, { kind: 'wall' }),
  ];
  if (args.costMoney !== undefined) {
    postings.push(
      post('truth.money', `vendor:${args.provider}`, '$', -args.costMoney, { model: args.model }),
      post('truth.money', `project:${projectId}`, '$', +args.costMoney, { model: args.model }),
    );
  }
  emit({
    kind: 'model_completion',
    taskId: args.taskId, agentId: args.agentId ?? AGENT, runId: args.runId,
    idempotencyKey: `${args.exchangeId}:completion`,
    payload: {
      ...(args.payload ?? {}),
      provider: args.provider, model: args.model,
      completion_tokens: args.completionTokens, wall_ms: args.wallMs,
      phase: 'completion', exchange_id: args.exchangeId,
      ...(args.responseText !== undefined && { response_text: args.responseText }),
    },
    postings,
  });
}

export function toolEnd(args: {
  taskId: string; agentId?: string; runId: string; toolName: string; toolUseId: string;
  ok: boolean; durationMs: number; resultBytes?: number; errorMessage?: string;
  iteration?: number; payload?: Record<string, unknown>;
}): void {
  emit({
    kind: 'tool_end',
    taskId: args.taskId, agentId: args.agentId ?? AGENT, runId: args.runId,
    payload: {
      ...(args.payload ?? {}),
      tool_name: args.toolName, tool_use_id: args.toolUseId, ok: args.ok,
      ...(args.resultBytes !== undefined && { result_bytes: args.resultBytes }),
      ...(args.errorMessage !== undefined && { error_message: args.errorMessage }),
      ...(args.iteration !== undefined && { iteration: args.iteration }),
    },
    postings: [
      post('truth.time', `agent:${args.agentId ?? AGENT}`, 'ms', -args.durationMs, { kind: 'tool' }),
      post('truth.time', `project:${projectId}`, 'ms', +args.durationMs, { kind: 'tool' }),
    ],
  });
}

export function streamError(args: {
  taskId: string; agentId?: string; runId: string; errorKind: string; message: string;
  iteration?: number; model?: string; payload?: Record<string, unknown>;
}): void {
  emit({
    kind: 'stream_error',
    taskId: args.taskId, agentId: args.agentId ?? AGENT, runId: args.runId,
    payload: {
      ...(args.payload ?? {}),
      error_kind: args.errorKind, message: args.message,
      ...(args.iteration !== undefined && { iteration: args.iteration }),
      ...(args.model !== undefined && { model: args.model }),
    },
  });
}

export async function flushSession(session: Session): Promise<void> {
  if (isLoggingDisabled()) return;
  if (session.events.length === 0 && session.postings.length === 0) return;
  const dir = path.join(baseLogDir, 'controllog');
  await mkdir(dir, { recursive: true });
  if (session.events.length) {
    await appendFile(
      path.join(dir, 'events.jsonl'),
      session.events.map(e => JSON.stringify(e)).join('\n') + '\n',
    );
  }
  if (session.postings.length) {
    await appendFile(
      path.join(dir, 'postings.jsonl'),
      session.postings.map(p => JSON.stringify(p)).join('\n') + '\n',
    );
  }
}
