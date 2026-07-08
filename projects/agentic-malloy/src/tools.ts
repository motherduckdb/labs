/**
 * Tool surface for the Malloy agent:
 *   - MCP exploration tools (query/list_tables/list_columns/search_catalog) —
 *     SQL exploration on MotherDuck, never the final answer.
 *   - Malloy layer tools (list_malloy_files, get_file, malloy_lint, run_malloy).
 *   - submit_answer — the scored path: lint -> Malloy run on MotherDuck.
 *
 * Malloy runs via its NATIVE runtime connected to MotherDuck (the runtime
 * compiles AND executes there). submit_answer latches finalRows (positional, for
 * score.py) only on success, then optionally runs the same Malloy locally as a
 * warning-only translation diagnostic.
 */
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ALLOWED_TOOLS, callMcpTool, runSqlPositional } from './mcp-client.js';
import type { MalloyRuntime } from './malloy-runtime.js';
import type { MalloyStore } from './malloy-store.js';
import { lintMalloy, detectRawSqlInMalloy, type FieldKind } from './linter.js';
import { answerShapeWarnings, type ShapeWarning } from './answer-shape.js';
import type { ToolSchema } from './llm-client.js';

/** How the scored answer was produced — instrumentation for the experiment:
 *   - 'view-selection': Malloy that reuses a named layer view (the goal path)
 *   - 'authored-malloy': Malloy authored from scratch (no named view referenced)
 *   - 'sql': raw SQL submitted via submit_sql (the fallback) */
export type AnswerKind = 'view-selection' | 'authored-malloy' | 'sql';

export interface RunState {
  submitted: boolean;
  finalMalloy?: string;
  finalCompiledSql?: string;
  finalRows?: unknown[][];
  /** Did the local-DuckDB run of the compiled query match the MotherDuck result?
   *  Warning diagnostic only (DuckDB/MotherDuck skew detector); null = couldn't check. */
  translationMatch?: boolean | null;
  /** How the submitted answer was produced (set on submit_answer/submit_sql). */
  answerKind?: AnswerKind;
  /** The pre-submit answer-shape linter has warned once this task (one-shot soft
   *  warn): a first submit with a shape warning is NOT latched (the agent may
   *  reconsider/resubmit); any subsequent submit latches unconditionally. */
  shapeWarned?: boolean;
  /** The most recent SUCCESSFUL run_malloy result (compiled + ran + returned rows),
   *  captured so the budget-guard can auto-submit a best-effort answer when the agent
   *  never submits on its own. (Undefined until the first successful run_malloy.) */
  lastGoodRun?: { malloy: string; compiledSql: string; rows: unknown[][] };
  filesRead: string[];
  lintFixesTotal: number;
}

export function newRunState(): RunState {
  return { submitted: false, filesRead: [], lintFixesTotal: 0 };
}

// The scored answer must not be row-capped (Malloy/exploration default is 50).
// Large enough to cover any factoid list answer (and the full largest table).
const ANSWER_ROW_LIMIT = 1_000_000;

/** MotherDuck/DuckDB returns counts and other integers as JS BigInt, which
 *  JSON.stringify cannot serialize (it throws) — breaking the score-client and
 *  results-JSONL writes. Convert BigInt to a plain number when it fits a safe
 *  integer (every DABstep count/sum does), else to a string. Leaves all other
 *  cell types untouched. */
function jsonSafeCell(v: unknown): unknown {
  if (typeof v === 'bigint') return v >= -9007199254740991n && v <= 9007199254740991n ? Number(v) : v.toString();
  return v;
}

export interface ToolDeps {
  client: Client;
  runtime: MalloyRuntime;
  localRuntime?: MalloyRuntime;
  store: MalloyStore;
  symbols: Set<string>;
  /** Compiled field-kind map (measure/dimension/view) — drives the linter's
   *  select: → group_by:/aggregate: split. */
  kinds?: Map<string, FieldKind>;
  /** Names of the layer's named views — used to tag a Malloy answer as
   *  view-selection vs authored-from-scratch. */
  viewNames?: Set<string>;
  /** SQL is prohibited as an answer substrate by DEFAULT: submit_sql is dropped +
   *  rejected unless this is explicitly `true`. Pass true to opt into the SQL arm. */
  allowSqlFallback?: boolean;
  database?: string;
  /** the task's question + answer guidelines — feed the pre-submit answer-shape
   *  linter (its checks are no-ops when both are absent). */
  question?: string | null;
  guidelines?: string | null;
  mcpTools: ToolSchema[];
  state: RunState;
}

export interface DispatchResult {
  content: string;
  isError: boolean;
}

const MALLOY_TOOL_SCHEMAS: ToolSchema[] = [
  {
    name: 'list_views',
    description:
      'START HERE. One flat catalog of every layer surface (sources + named views) with a one-line summary and how-to-call hint. Find the view that answers the question, then reuse it with a thin `+ { where:/order_by:/limit: }` refinement instead of authoring Malloy from scratch.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'list_malloy_files',
    description:
      'Browse the Malloy semantic layer by domain (use list_views first for the full menu). No args -> the model domains. domains=[...] -> the files in those domains with their exported sources/queries.',
    input_schema: { type: 'object', properties: { domains: { type: 'array', items: { type: 'string' } } } },
  },
  {
    name: 'get_file',
    description: 'Return the full Malloy source of named model files (e.g. ["fees_base.malloy"]). Read these before writing per-query Malloy.',
    input_schema: { type: 'object', properties: { files: { type: 'array', items: { type: 'string' } } }, required: ['files'] },
  },
  {
    name: 'malloy_lint',
    description: 'Compile a Malloy snippet to SQL WITHOUT executing it. Returns the compiled SQL on success, or compiler diagnostics on failure.',
    input_schema: { type: 'object', properties: { source: { type: 'string' } }, required: ['source'] },
  },
  {
    name: 'run_malloy',
    description: 'Lint + compile Malloy, then execute the compiled SQL on MotherDuck and return up to 50 rows. Use to iterate toward the answer.',
    input_schema: { type: 'object', properties: { source: { type: 'string' } }, required: ['source'] },
  },
  {
    name: 'submit_answer',
    description:
      'Submit the Malloy whose compiled-SQL result IS the answer. Compiles + executes on MotherDuck; latches only on success. Submit once when ready — but a pre-submit answer-shape check may return a one-time warning; if so, fix the issue or call submit again to confirm, and it records then. An unsubmitted run scores zero. (Raw SQL wrapped in `duckdb.sql(...)` is NOT a Malloy answer — use submit_sql for that.)',
    input_schema: { type: 'object', properties: { source: { type: 'string' } }, required: ['source'] },
  },
  {
    name: 'submit_sql',
    description:
      'Fallback answer path: submit raw DuckDB SQL whose result IS the answer, when no layer view fits and authoring Malloy is fighting you. Executes on MotherDuck; latches only on success. Submit once when ready — but a pre-submit answer-shape check may return a one-time warning; if so, fix the issue or call submit again to confirm, and it records then. Select ONLY the asked value(s).',
    input_schema: { type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'] },
  },
];

// submit_answer's description names submit_sql (correct when the fallback is on). When
// it's off, swap in a Malloy-only description so no model-visible string points at the
// (now absent) tool.
const SUBMIT_ANSWER_DESC_MALLOY_ONLY =
  'Submit the Malloy whose compiled-SQL result IS the answer. Compiles + executes on MotherDuck; latches only on success. Submit once when ready — but a pre-submit answer-shape check may return a one-time warning; if so, fix the issue or call submit again to confirm, and it records then. An unsubmitted run scores zero. (Do NOT wrap raw SQL in `duckdb.sql(...)`; this run is Malloy-only.)';

export function buildToolSchemas(deps: ToolDeps): ToolSchema[] {
  // SQL fallback is OFF unless explicitly enabled: drop submit_sql AND rewrite
  // submit_answer's description so no exposed tool steers to the absent path — a
  // clean Malloy-only condition (no rejected-tool / contradicted-prompt mismatch).
  // dispatchTool still guards it.
  if (deps.allowSqlFallback !== true) {
    const malloyOnly = MALLOY_TOOL_SCHEMAS.filter((t) => t.name !== 'submit_sql').map((t) =>
      t.name === 'submit_answer' ? { ...t, description: SUBMIT_ANSWER_DESC_MALLOY_ONLY } : t,
    );
    return [...deps.mcpTools, ...malloyOnly];
  }
  return [...deps.mcpTools, ...MALLOY_TOOL_SCHEMAS];
}

/** Reject the duckdb.sql("""…""")-in-Malloy hack. Steer to submit_sql when the fallback
 *  is on; to the layer (submit_answer) when it's off, so the message never names an
 *  absent tool. */
function rawSqlReject(sqlOn: boolean): string {
  return sqlOn
    ? 'Raw SQL wrapped in Malloy (`duckdb.sql(...)`) is not a Malloy answer. ' +
        'If you need SQL, call `submit_sql` with the SQL whose result IS the answer — it runs on MotherDuck and is scored the same way. ' +
        'Otherwise reuse a layer view (see `list_views`) and submit it via `submit_answer`.'
    : 'Raw SQL wrapped in Malloy (`duckdb.sql(...)`) is not allowed. ' +
        'Answer with the layer — reuse a view (see `list_views`) or author Malloy, and submit it via `submit_answer`.';
}

/** Does the submitted Malloy reference a named layer view? (view-selection vs authored.) */
function referencesView(src: string, viewNames?: Set<string>): boolean {
  if (!viewNames?.size) return false;
  for (const v of viewNames) {
    if (new RegExp(`\\b${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(src)) return true;
  }
  return false;
}

/** The one-shot soft-warn message returned on the FIRST submit that has a shape
 *  warning (NOT latched — the agent may reconsider or resubmit-to-confirm). */
function shapeWarnMessage(warnings: ShapeWarning[]): string {
  return (
    `⚠ NOT YET RECORDED — a pre-submit answer-shape check found ${warnings.length} possible issue(s):\n` +
    warnings.map((w) => `  - ${w.message}`).join('\n') +
    `\nIf the answer is correct as-is, call submit again to confirm and record it; otherwise fix it and resubmit.`
  );
}

/** A terse note appended to a LATCHED submit when warnings were present (so the
 *  shape concern is in the record without blocking the recorded answer). */
function shapeWarnNote(warnings: ShapeWarning[]): string {
  return warnings.length ? ` (answer-shape notes: ${warnings.map((w) => w.code).join(', ')})` : '';
}

function fmtDiagnostics(diags: { message: string }[] | undefined): string {
  if (!diags || !diags.length) return 'compile failed (no diagnostics)';
  return 'Malloy compile error:\n' + diags.map((d) => `  - ${d.message}`).join('\n');
}

function rowsToText(rows: unknown[][], cols?: string[]): string {
  if (!rows.length) return '(no rows)';
  const header = cols ? cols.join(' | ') + '\n' : '';
  return header + rows.map((r) => r.map((v) => String(v)).join(' | ')).join('\n');
}

/** Normalize a cell for cross-engine comparison (numbers by value, else string). */
function normCell(v: unknown): string {
  if (v === null || v === undefined) return '∅';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  const n = Number(v);
  return Number.isFinite(n) && String(v).trim() !== '' ? n.toPrecision(10) : String(v);
}

/** Row/column-shape equality: local (objects) vs MotherDuck (positional). Both come
 *  from the SAME compiled SQL, so column order matches; we compare each row as an
 *  ordered tuple of cells, as a multiset of rows (result order may differ). A row
 *  [1,2] will NOT match [2,1], and column/row counts must agree — not a flat blob. */
function rowsetsMatch(local: Record<string, unknown>[], md: unknown[][]): boolean {
  if (local.length !== md.length) return false;
  const rowKey = (cells: unknown[]) => JSON.stringify(cells.map(normCell));
  const a = local.map((r) => rowKey(Object.values(r))).sort();
  const b = md.map((r) => rowKey(r)).sort();
  // column-count check (first row) — a shape mismatch must fail.
  if (local.length > 0 && Object.values(local[0]).length !== (md[0]?.length ?? -1)) return false;
  return a.every((x, i) => x === b[i]);
}

/**
 * Latch a Malloy answer into the run state — the SINGLE place that populates the
 * scored fields (submitted/finalMalloy/finalCompiledSql/finalRows/answerKind) and
 * runs the warning-only local translation check. Called by both submit_answer (after
 * its one-shot shape-warn gate) and the budget-guard's forced best-effort submit, so
 * answer-shape/translation handling stays consistent across the two entry points.
 */
export async function latchAnswer(
  deps: ToolDeps,
  answer: { malloy: string; compiledSql: string; rows: unknown[][] },
): Promise<void> {
  const { state, localRuntime } = deps;
  state.submitted = true;
  state.finalMalloy = answer.malloy;
  state.finalCompiledSql = answer.compiledSql;
  state.finalRows = answer.rows;
  state.answerKind = referencesView(answer.malloy, deps.viewNames) ? 'view-selection' : 'authored-malloy';
  if (localRuntime) {
    try {
      const local = await localRuntime.run(answer.malloy, ANSWER_ROW_LIMIT);
      state.translationMatch = local.ok ? rowsetsMatch(local.rows ?? [], state.finalRows) : null;
    } catch {
      state.translationMatch = null;
    }
  } else {
    state.translationMatch = null;
  }
}

export async function dispatchTool(deps: ToolDeps, name: string, args: Record<string, unknown>): Promise<DispatchResult> {
  const { client, runtime, store, symbols, state, database } = deps;

  // MCP exploration tools. Inject the database + new_fragments defaults so the
  // model can't omit the production query tool's required fields.
  if (ALLOWED_TOOLS.has(name)) {
    const mcpArgs: Record<string, unknown> = { ...args };
    if (database && mcpArgs.database === undefined) mcpArgs.database = database;
    if (name === 'query' && mcpArgs.new_fragments === undefined) mcpArgs.new_fragments = [];
    const res = await callMcpTool(client, name, mcpArgs);
    return { content: res.text, isError: res.isError };
  }

  if (name === 'list_views') {
    return { content: store.listViews(), isError: false };
  }

  if (name === 'list_malloy_files') {
    const domains = Array.isArray(args.domains) ? (args.domains as string[]) : undefined;
    return { content: store.listFiles(domains), isError: false };
  }

  if (name === 'get_file') {
    const files = Array.isArray(args.files) ? (args.files as string[]) : [];
    // Files are STATIC for a task — re-reading one wastes a turn (and tokens) and
    // never helps (a layer error isn't fixed by re-reading). Serve only files not
    // already read; if all were already provided, return a short stub instead of
    // the full content again.
    const fresh = files.filter((f) => !state.filesRead.includes(f));
    const already = files.filter((f) => state.filesRead.includes(f));
    for (const f of fresh) state.filesRead.push(f);
    if (!fresh.length) {
      return { content: `Already provided earlier this task (files don't change): ${already.join(', ')}. Scroll up; do not re-read.`, isError: false };
    }
    const note = already.length ? `(skipping already-read: ${already.join(', ')})\n` : '';
    return { content: note + store.getFile(fresh), isError: false };
  }

  if (name === 'malloy_lint') {
    const { fixedSrc, fixes } = lintMalloy(String(args.source ?? ''), symbols, deps.kinds);
    state.lintFixesTotal += fixes.length;
    const c = await runtime.compile(fixedSrc);
    if (!c.ok) return { content: fmtDiagnostics(c.diagnostics), isError: true };
    const note = fixes.length ? `[lint applied: ${fixes.join('; ')}]\n` : '';
    return { content: `${note}Compiled SQL:\n${c.sql}`, isError: false };
  }

  if (name === 'run_malloy') {
    if (detectRawSqlInMalloy(String(args.source ?? ''))) return { content: rawSqlReject(deps.allowSqlFallback === true), isError: true };
    const { fixedSrc, fixes } = lintMalloy(String(args.source ?? ''), symbols, deps.kinds);
    state.lintFixesTotal += fixes.length;
    // Run via Malloy's native runtime (connected to MotherDuck for eval) — compile
    // and execute on the SAME engine, so no cross-engine SQL skew.
    const r = await runtime.run(fixedSrc, 50);
    if (!r.ok) return { content: fmtDiagnostics(r.diagnostics), isError: true };
    const cols = r.rows!.length ? Object.keys(r.rows![0]) : [];
    const arrays = r.rows!.map((o) => cols.map((cn) => o[cn]));
    // Capture this as the last-good run_malloy result: if the agent never submits,
    // the budget-guard auto-submits THIS (positional, BigInt-safe) as a best-effort
    // answer (a plausible-but-uncertain answer can earn partial credit; None cannot).
    state.lastGoodRun = { malloy: fixedSrc, compiledSql: r.sql!, rows: arrays.map((row) => row.map(jsonSafeCell)) };
    const note = fixes.length ? `[lint applied: ${fixes.join('; ')}]\n` : '';
    return { content: `${note}${rowsToText(arrays, cols)}`, isError: false };
  }

  if (name === 'submit_answer') {
    if (state.submitted) return { content: 'ERROR: answer already submitted', isError: true };
    if (detectRawSqlInMalloy(String(args.source ?? ''))) return { content: rawSqlReject(deps.allowSqlFallback === true) + '\nThe answer was NOT recorded.', isError: true };
    const { fixedSrc, fixes } = lintMalloy(String(args.source ?? ''), symbols, deps.kinds);
    state.lintFixesTotal += fixes.length;
    // Run via Malloy's native runtime (MotherDuck for eval) — same engine for
    // compile + execute, so the generated SQL always binds. The scored answer
    // must return ALL rows: a 50-row cap silently truncates list answers (a
    // 155-id answer was being cut to 50). Use a large explicit cap.
    const r = await runtime.run(fixedSrc, ANSWER_ROW_LIMIT);
    if (!r.ok) return { content: fmtDiagnostics(r.diagnostics) + '\nThe answer was NOT recorded — fix and resubmit.', isError: true };
    const cols = r.rows!.length ? Object.keys(r.rows![0]) : [];
    const positional = r.rows!.map((o) => cols.map((cn) => jsonSafeCell(o[cn]))); // positional for score.py (BigInt-safe)
    // Pre-submit answer-shape lint (advisory, one-shot): a first submit with a shape
    // warning is NOT latched, so the agent can reconsider/resubmit; the resubmit
    // always records (no non-submission/correctness regression).
    const warnings = answerShapeWarnings({ question: deps.question, guidelines: deps.guidelines, source: fixedSrc, columns: cols, rows: positional });
    if (warnings.length && !state.shapeWarned) {
      state.shapeWarned = true;
      return { content: shapeWarnMessage(warnings), isError: false };
    }
    await latchAnswer(deps, { malloy: fixedSrc, compiledSql: r.sql!, rows: positional });
    return { content: `Submitted. ${r.rows!.length} row(s).${shapeWarnNote(warnings)}`, isError: false };
  }

  if (name === 'submit_sql') {
    if (state.submitted) return { content: 'ERROR: answer already submitted', isError: true };
    if (deps.allowSqlFallback !== true) {
      return { content: 'submit_sql is disabled for this run (SQL is prohibited as an answer substrate — Malloy-only). Author the answer as Malloy and use submit_answer.', isError: true };
    }
    const sql = String(args.sql ?? '').trim();
    if (!sql) return { content: 'ERROR: empty sql', isError: true };
    // Execute on MotherDuck — same substrate + same positional-row shape the
    // scorer expects, so a SQL answer scores identically to a Malloy one.
    let rows: unknown[][];
    try {
      rows = await runSqlPositional(client, sql, database);
    } catch (e) {
      return { content: `SQL error:\n${e instanceof Error ? e.message : String(e)}\nThe answer was NOT recorded — fix and resubmit.`, isError: true };
    }
    const positional = rows.map((r) => (Array.isArray(r) ? r.map(jsonSafeCell) : [jsonSafeCell(r)]));
    // Same one-shot answer-shape lint on the SQL path (it otherwise bypasses ALL
    // format discipline). Column names aren't available from positional SQL rows, so
    // the >1-column check infers the count from the first row.
    const warnings = answerShapeWarnings({ question: deps.question, guidelines: deps.guidelines, source: sql, rows: positional });
    if (warnings.length && !state.shapeWarned) {
      state.shapeWarned = true;
      return { content: shapeWarnMessage(warnings), isError: false };
    }
    state.submitted = true;
    state.finalCompiledSql = sql; // predicted_sql for the scorer
    state.finalRows = positional;
    state.translationMatch = null;
    state.answerKind = 'sql';
    return { content: `Submitted (SQL). ${rows.length} row(s).${shapeWarnNote(warnings)}`, isError: false };
  }

  return { content: `Unknown tool: ${name}`, isError: true };
}
