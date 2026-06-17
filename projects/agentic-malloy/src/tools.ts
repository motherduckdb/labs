/**
 * Tool surface for the Malloy agent:
 *   - MCP exploration tools (query/list_tables/list_columns/search_catalog/
 *     ask_docs_question) — SQL exploration on MotherDuck, never the final answer.
 *   - Malloy layer tools (list_malloy_files, get_file, malloy_lint, run_malloy).
 *   - submit_answer — the scored path: lint -> Malloy run on MotherDuck.
 *
 * Malloy runs via its NATIVE runtime connected to MotherDuck (the runtime
 * compiles AND executes there) — same engine, no local→MotherDuck SQL skew.
 * submit_answer latches finalRows (positional, for score.py) only on success.
 */
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ALLOWED_TOOLS, callMcpTool } from './mcp-client.js';
import type { MalloyRuntime } from './malloy-runtime.js';
import type { MalloyStore } from './malloy-store.js';
import { lintMalloy } from './linter.js';
import type { ToolSchema } from './llm-client.js';

export interface RunState {
  submitted: boolean;
  finalMalloy?: string;
  finalCompiledSql?: string;
  finalRows?: unknown[][];
  /** Did the local-DuckDB run of the compiled query match the MotherDuck result?
   *  Warning diagnostic only (DuckDB/MotherDuck skew detector); null = couldn't check. */
  translationMatch?: boolean | null;
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
  store: MalloyStore;
  symbols: Set<string>;
  database?: string;
  mcpTools: ToolSchema[];
  state: RunState;
}

export interface DispatchResult {
  content: string;
  isError: boolean;
}

const MALLOY_TOOL_SCHEMAS: ToolSchema[] = [
  {
    name: 'list_malloy_files',
    description:
      'Browse the Malloy semantic layer. No args -> the model domains. domains=[...] -> the files in those domains with their exported sources/queries.',
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
      'Submit the Malloy whose compiled-SQL result IS the answer. Compiles + executes on MotherDuck; latches only on success. Call exactly once. An unsubmitted run scores zero.',
    input_schema: { type: 'object', properties: { source: { type: 'string' } }, required: ['source'] },
  },
];

export function buildToolSchemas(deps: ToolDeps): ToolSchema[] {
  return [...deps.mcpTools, ...MALLOY_TOOL_SCHEMAS];
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

  if (name === 'list_malloy_files') {
    const domains = Array.isArray(args.domains) ? (args.domains as string[]) : undefined;
    return { content: store.listFiles(domains), isError: false };
  }

  if (name === 'get_file') {
    const files = Array.isArray(args.files) ? (args.files as string[]) : [];
    for (const f of files) if (!state.filesRead.includes(f)) state.filesRead.push(f);
    return { content: store.getFile(files), isError: false };
  }

  if (name === 'malloy_lint') {
    const { fixedSrc, fixes } = lintMalloy(String(args.source ?? ''), symbols);
    state.lintFixesTotal += fixes.length;
    const c = await runtime.compile(fixedSrc);
    if (!c.ok) return { content: fmtDiagnostics(c.diagnostics), isError: true };
    const note = fixes.length ? `[lint applied: ${fixes.join('; ')}]\n` : '';
    return { content: `${note}Compiled SQL:\n${c.sql}`, isError: false };
  }

  if (name === 'run_malloy') {
    const { fixedSrc, fixes } = lintMalloy(String(args.source ?? ''), symbols);
    state.lintFixesTotal += fixes.length;
    // Run via Malloy's native runtime (connected to MotherDuck for eval) — compile
    // and execute on the SAME engine, so no cross-engine SQL skew.
    const r = await runtime.run(fixedSrc, 50);
    if (!r.ok) return { content: fmtDiagnostics(r.diagnostics), isError: true };
    const cols = r.rows!.length ? Object.keys(r.rows![0]) : [];
    const arrays = r.rows!.map((o) => cols.map((cn) => o[cn]));
    const note = fixes.length ? `[lint applied: ${fixes.join('; ')}]\n` : '';
    return { content: `${note}${rowsToText(arrays, cols)}`, isError: false };
  }

  if (name === 'submit_answer') {
    if (state.submitted) return { content: 'ERROR: answer already submitted', isError: true };
    const { fixedSrc, fixes } = lintMalloy(String(args.source ?? ''), symbols);
    state.lintFixesTotal += fixes.length;
    // Run via Malloy's native runtime (MotherDuck for eval) — same engine for
    // compile + execute, so the generated SQL always binds. The scored answer
    // must return ALL rows: a 50-row cap silently truncates list answers (a
    // 155-id answer was being cut to 50). Use a large explicit cap.
    const r = await runtime.run(fixedSrc, ANSWER_ROW_LIMIT);
    if (!r.ok) return { content: fmtDiagnostics(r.diagnostics) + '\nThe answer was NOT recorded — fix and resubmit.', isError: true };
    const cols = r.rows!.length ? Object.keys(r.rows![0]) : [];
    state.submitted = true;
    state.finalMalloy = fixedSrc;
    state.finalCompiledSql = r.sql;
    state.finalRows = r.rows!.map((o) => cols.map((cn) => jsonSafeCell(o[cn]))); // positional for score.py (BigInt-safe)
    state.translationMatch = null; // executed locally; MotherDuck cross-check deferred (engine skew known)
    return { content: `Submitted. ${r.rows!.length} row(s).`, isError: false };
  }

  return { content: `Unknown tool: ${name}`, isError: true };
}
