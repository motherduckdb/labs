/**
 * run-log — read the controllog a previous eval emitted (results/controllog/
 * events.jsonl) and reconstruct, per run, the evidence layer-improve's deeper
 * triage needs:
 *   - which controllog run a results JSONL corresponds to (correlateRun), since
 *     the JSONL itself records no run_id — we match evaluation_result events by
 *     (task_id, submitted Malloy / predicted answer);
 *   - the per-task TOOL TRACE (the manner-of-failure evidence): the ordered tool
 *     calls, their args, and ok/error status (taskTrace);
 *   - run-level TOOL-ERROR rates for the meta-analysis (toolErrorStats).
 *
 * Everything here is pure over already-parsed events so it is unit-testable
 * without a live controllog; loadControllog is the thin IO wrapper.
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_CONTROLLOG_DIR = path.join(REPO_ROOT, 'results', 'controllog');

export interface ControllogEvent {
  kind?: string;
  run_id?: string | null;
  actor_task_id?: string | null;
  payload_json?: Record<string, unknown>;
}

/** Parse an events.jsonl text blob (one JSON event per line). Pure. */
export function parseEvents(text: string): ControllogEvent[] {
  return text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l) as ControllogEvent;
      } catch {
        return null;
      }
    })
    .filter((e): e is ControllogEvent => e !== null);
}

export async function loadControllog(dir = DEFAULT_CONTROLLOG_DIR): Promise<ControllogEvent[]> {
  const file = path.join(dir, 'events.jsonl');
  if (!existsSync(file)) return [];
  return parseEvents(await readFile(file, 'utf8'));
}

export interface RunCorrelation {
  runId: string | null;
  matched: number;
  total: number;
}

/**
 * Find the controllog run_id whose evaluation_result events best match the
 * results-JSONL rows, by (task_id, malloy_source) — falling back to
 * (task_id, predicted_answer) for non-submissions. Returns the best run plus how
 * many of the file's rows it covers, so the caller can decide whether the trace
 * is trustworthy (a low match → fall back to JSONL-only evidence). Pure.
 */
export function correlateRun(
  events: ControllogEvent[],
  rows: Array<{ task_id: string | number; malloy_source?: string | null; predicted_answer?: unknown }>,
): RunCorrelation {
  const rowKey = (taskId: string, malloy: string | null | undefined, pred: unknown) =>
    malloy ? `m:${taskId}:${malloy}` : `p:${taskId}:${String(pred ?? '')}`;
  const want = new Set(rows.map((r) => rowKey(String(r.task_id), r.malloy_source ?? null, r.predicted_answer)));

  const perRun = new Map<string, Set<string>>(); // run_id -> matched row keys
  for (const e of events) {
    if (e.kind !== 'evaluation_result' || !e.run_id) continue;
    const p = e.payload_json ?? {};
    const taskId = String(p.question_id ?? e.actor_task_id ?? '');
    const k = rowKey(taskId, (p.malloy_source as string | null) ?? null, p.predicted_result);
    if (want.has(k)) {
      const s = perRun.get(e.run_id) ?? new Set<string>();
      s.add(k);
      perRun.set(e.run_id, s);
    }
  }
  let runId: string | null = null;
  let matched = 0;
  for (const [rid, s] of perRun) {
    if (s.size > matched) {
      matched = s.size;
      runId = rid;
    }
  }
  return { runId, matched, total: rows.length };
}

export interface ToolStep {
  name: string;
  ok: boolean;
  args?: unknown;
  output?: string;
}

export interface TaskTrace {
  taskId: string;
  steps: ToolStep[];
  /** the agent navigated the layer (list_malloy_files / get_file). */
  exploredLayer: boolean;
  runMalloyErrors: number;
  submitErrors: number;
  toolCalls: number;
}

/** Reconstruct one task's tool trace for a run by joining tool_call args to
 *  tool_result status/output via call_id. Pure. */
export function taskTrace(events: ControllogEvent[], runId: string, taskId: string): TaskTrace {
  const argsByCall = new Map<string, { name: string; args: unknown }>();
  for (const e of events) {
    if (e.kind === 'tool_call' && e.run_id === runId && String(e.actor_task_id) === taskId) {
      const p = e.payload_json ?? {};
      argsByCall.set(String(p.call_id), { name: String(p.name), args: p.arguments });
    }
  }
  const steps: ToolStep[] = [];
  let runMalloyErrors = 0;
  let submitErrors = 0;
  let exploredLayer = false;
  for (const e of events) {
    if (e.kind !== 'tool_result' || e.run_id !== runId || String(e.actor_task_id) !== taskId) continue;
    const p = e.payload_json ?? {};
    const name = String(p.name);
    const ok = p.status === 'ok';
    const call = argsByCall.get(String(p.call_id));
    steps.push({ name, ok, args: call?.args, output: p.output !== undefined ? String(p.output) : undefined });
    if (name === 'list_malloy_files' || name === 'get_file') exploredLayer = true;
    if (!ok && name === 'run_malloy') runMalloyErrors++;
    if (!ok && name === 'submit_answer') submitErrors++;
  }
  return { taskId, steps, exploredLayer, runMalloyErrors, submitErrors, toolCalls: steps.length };
}

export interface ToolErrorStat {
  tool: string;
  calls: number;
  errors: number;
  rate: number; // 0..1
  /** distinct sample error outputs (deduped, trimmed). */
  samples: string[];
  flagged: boolean; // rate > threshold AND calls >= minCalls
}

/**
 * Per-tool error rate across a whole run (the meta-analysis input). A tool is
 * flagged when its error rate exceeds `threshold` (default 15%) and it was
 * called at least `minCalls` times (so a 1-of-2 fluke isn't flagged). Pure.
 */
export function toolErrorStats(
  events: ControllogEvent[],
  runId: string,
  opts: { threshold?: number; minCalls?: number; maxSamples?: number } = {},
): ToolErrorStat[] {
  const threshold = opts.threshold ?? 0.15;
  const minCalls = opts.minCalls ?? 5;
  const maxSamples = opts.maxSamples ?? 4;
  const calls = new Map<string, number>();
  const errors = new Map<string, number>();
  const samples = new Map<string, Set<string>>();
  for (const e of events) {
    if (e.kind !== 'tool_result' || e.run_id !== runId) continue;
    const p = e.payload_json ?? {};
    const name = String(p.name);
    calls.set(name, (calls.get(name) ?? 0) + 1);
    if (p.status !== 'ok') {
      errors.set(name, (errors.get(name) ?? 0) + 1);
      const set = samples.get(name) ?? new Set<string>();
      if (set.size < maxSamples && p.output !== undefined) set.add(String(p.output).slice(0, 240));
      samples.set(name, set);
    }
  }
  const out: ToolErrorStat[] = [];
  for (const [tool, n] of calls) {
    const err = errors.get(tool) ?? 0;
    const rate = n ? err / n : 0;
    out.push({ tool, calls: n, errors: err, rate, samples: [...(samples.get(tool) ?? [])], flagged: rate > threshold && n >= minCalls });
  }
  out.sort((a, b) => b.rate - a.rate || b.calls - a.calls);
  return out;
}

export type AnswerShapeKind = 'none' | 'scalar' | 'list' | 'bracketed-list';

export interface AnswerShape {
  kind: AnswerShapeKind;
  count: number; // number of comma-separated items (1 for a scalar)
}

/** Coarse shape of a predicted answer string — feeds over/under-specification
 *  reasoning WITHOUT the gold answer (it's the agent's own output). Pure. */
export function answerShape(predicted: unknown): AnswerShape {
  if (predicted === null || predicted === undefined || String(predicted).trim() === '') return { kind: 'none', count: 0 };
  const s = String(predicted).trim();
  const bracketed = /^\[.*\]$/.test(s);
  const inner = bracketed ? s.slice(1, -1) : s;
  const items = inner.split(',').map((x) => x.trim()).filter(Boolean);
  if (bracketed) return { kind: 'bracketed-list', count: items.length };
  if (items.length > 1) return { kind: 'list', count: items.length };
  return { kind: 'scalar', count: 1 };
}
