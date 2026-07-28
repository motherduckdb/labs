/**
 * Slim controllog emitter — writes spec-compatible rows that the labs
 * `controllog` Python package can upload to MotherDuck and `controllog-viz`
 * can render. This is intentionally NOT the heavy mdw-turbo port: it only
 * emits, it does not upload.
 *
 * Schema follows docs/spec-v1.1.md exactly — including the `truth.money` /
 * `truth.time` account names (the mdw-turbo port diverged to `resource.*`,
 * which breaks controllog-viz cost/latency rollups; we do NOT repeat that).
 *
 * Storage: Postgres (`controllog_events` / `controllog_postings`,
 * migrations/002_modal.sql), not JSONL on local disk. On Fly, one always-on
 * process appended lines to `logs/controllog/{events,postings}.jsonl` and line
 * order carried a turn's grouping implicitly. On Modal there is no durable
 * local disk — Modal Volumes resolve two containers appending to the same file
 * concurrently as last-write-wins, silently dropping whichever turn's flush
 * lost — so appends became inserts, and the grouping that line-adjacency used
 * to give for free is now explicit: every row carries `session_id` (already
 * generated per turn as `Session.id`, but never persisted before) and an
 * `ordinal` (this row's position within the session's own event/posting list,
 * assigned at flush time). The row shapes are otherwise unchanged field-for-
 * field from the old JSONL records, and in turn from the DuckDB DDL in the
 * labs `controllog` package (src/controllog/motherduck.py::_ensure_schema) —
 * that alignment is what lets the existing Python uploader and
 * controllog-viz keep working off a plain `select`, so don't rename columns
 * here without updating those too.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Pool } from 'pg';
import { getPool } from '../store/pg';
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
const als = new AsyncLocalStorage<Session>();

/**
 * `logDir` is vestigial — kept so `main.ts`'s existing `cl.init('quackbot',
 * 'logs')` call keeps compiling untouched (call sites outside this module are
 * off-limits for this change). There is no log directory any more: flushes go
 * straight to Postgres. Accepting and ignoring the argument is cheaper than
 * making every caller aware that the parameter died.
 */
export function init(project: string, _logDir?: string): void {
  projectId = project;
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

/**
 * Build a parameterized multi-row `INSERT … ON CONFLICT DO NOTHING`.
 *
 * `table`/`columns`/`conflictColumn` are compile-time constants owned by this
 * module, never request data, so interpolating them directly into the SQL
 * string is fine — only the row values travel as bound `$n` parameters.
 * One round-trip per table per flush, however many rows a turn produced,
 * rather than a query per row.
 */
function buildBatchInsert(
  table: string,
  columns: string[],
  rows: unknown[][],
  conflictColumn: string,
): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const valueGroups = rows.map(row => {
    const placeholders = row.map(value => {
      params.push(value);
      return `$${params.length}`;
    });
    return `(${placeholders.join(', ')})`;
  });
  const sql = `insert into ${table} (${columns.join(', ')}) values ${valueGroups.join(', ')} on conflict (${conflictColumn}) do nothing`;
  return { sql, params };
}

const EVENT_COLUMNS = [
  'event_id', 'session_id', 'ordinal', 'event_time', 'ingest_time', 'kind',
  'actor_agent_id', 'actor_task_id', 'project_id', 'run_id', 'source',
  'idempotency_key', 'payload_json',
];

const POSTING_COLUMNS = [
  'posting_id', 'event_id', 'session_id', 'ordinal', 'account_type',
  'account_id', 'unit', 'delta_numeric', 'dims_json',
];

/**
 * `ordinal` is this row's index within `session.events` / `session.postings`
 * at flush time — i.e. emission order, the same order line-adjacency used to
 * carry implicitly in the old JSONL. Assigning it here rather than tracking a
 * counter on `Session` keeps `emit()` unaware that Postgres exists at all.
 */
async function insertEvents(pool: Pool, session: Session): Promise<void> {
  const rows = session.events.map((e, ordinal) => [
    e.event_id, session.id, ordinal, e.event_time, e.ingest_time, e.kind,
    e.actor_agent_id, e.actor_task_id, e.project_id, e.run_id, e.source,
    e.idempotency_key, JSON.stringify(e.payload_json),
  ]);
  const { sql, params } = buildBatchInsert('controllog_events', EVENT_COLUMNS, rows, 'event_id');
  await pool.query(sql, params);
}

async function insertPostings(pool: Pool, session: Session): Promise<void> {
  const rows = session.postings.map((p, ordinal) => [
    p.posting_id, p.event_id, session.id, ordinal, p.account_type,
    p.account_id, p.unit, p.delta_numeric, JSON.stringify(p.dims_json),
  ]);
  const { sql, params } = buildBatchInsert('controllog_postings', POSTING_COLUMNS, rows, 'posting_id');
  await pool.query(sql, params);
}

/**
 * Flush one turn's buffered events/postings to Postgres.
 *
 * Telemetry must never be able to fail a user's turn. On Fly, a write failure
 * threw out of `flushSession`, and it was the *caller's* job (handlers.ts
 * wraps this call in its own try/catch) to keep that from losing the turn.
 * That call-site safety net still exists, but it shouldn't be the only one —
 * a future caller that omits it (e.g. `src/worker.ts`, not written yet) would
 * otherwise crash a turn on nothing more than a controllog outage. So the
 * swallow now lives here too: every DB error is caught and logged, never
 * thrown. Belt AND suspenders, deliberately.
 *
 * Events and postings are two independent inserts with independent
 * try/catches, not one transaction, so a failure in one cannot take the other
 * down with it — matching the "no FK, on purpose" note on
 * `controllog_postings` in migrations/002_modal.sql: a posting that outlives a
 * failed event insert is a logging artefact worth keeping, not a reason to
 * lose the rest of the session's rows.
 */
export async function flushSession(session: Session): Promise<void> {
  if (isLoggingDisabled()) return;
  if (session.events.length === 0 && session.postings.length === 0) return;
  const pool = getPool();
  if (session.events.length) {
    try {
      await insertEvents(pool, session);
    } catch (err) {
      console.warn('[quackbot] controllog events flush failed:', err);
    }
  }
  if (session.postings.length) {
    try {
      await insertPostings(pool, session);
    } catch (err) {
      console.warn('[quackbot] controllog postings flush failed:', err);
    }
  }
}
