/**
 * Tool surface for the Malloy agent:
 *   - MCP exploration tools (query/list_tables/list_columns/search_catalog/
 *     ask_docs_question) — SQL exploration on MotherDuck, never the final answer.
 *   - Malloy layer tools (list_malloy_files, get_file, malloy_lint, run_malloy).
 *   - submit_answer — the scored path: lint -> compile -> execute on MotherDuck.
 *
 * All Malloy execution of compiled SQL happens on MotherDuck via MCP (all-MD
 * substrate); Malloy only COMPILES against the local DuckDB. submit_answer
 * latches finalRows (positional, for score.py) only on success.
 */
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ALLOWED_TOOLS, callMcpTool, runSqlPositional } from './mcp-client.js';
import type { MalloyRuntime } from './malloy-runtime.js';
import type { MalloyStore } from './malloy-store.js';
import { lintMalloy } from './linter.js';
import type { ToolSchema } from './llm-client.js';

export interface RunState {
  submitted: boolean;
  finalMalloy?: string;
  finalCompiledSql?: string;
  finalRows?: unknown[][];
  filesRead: string[];
  lintFixesTotal: number;
}

export function newRunState(): RunState {
  return { submitted: false, filesRead: [], lintFixesTotal: 0 };
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

export async function dispatchTool(deps: ToolDeps, name: string, args: Record<string, unknown>): Promise<DispatchResult> {
  const { client, runtime, store, symbols, state, database } = deps;

  // MCP exploration tools.
  if (ALLOWED_TOOLS.has(name)) {
    const res = await callMcpTool(client, name, args);
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
    const c = await runtime.compile(fixedSrc);
    if (!c.ok) return { content: fmtDiagnostics(c.diagnostics), isError: true };
    try {
      const rows = await runSqlPositional(client, c.sql!, database);
      const note = fixes.length ? `[lint applied: ${fixes.join('; ')}]\n` : '';
      return { content: `${note}${rowsToText(rows.slice(0, 50))}`, isError: false };
    } catch (e) {
      return { content: `Execution error on MotherDuck: ${e instanceof Error ? e.message : String(e)}`, isError: true };
    }
  }

  if (name === 'submit_answer') {
    if (state.submitted) return { content: 'ERROR: answer already submitted', isError: true };
    const { fixedSrc, fixes } = lintMalloy(String(args.source ?? ''), symbols);
    state.lintFixesTotal += fixes.length;
    const c = await runtime.compile(fixedSrc);
    if (!c.ok) return { content: fmtDiagnostics(c.diagnostics) + '\nThe answer was NOT recorded — fix and resubmit.', isError: true };
    try {
      const rows = await runSqlPositional(client, c.sql!, database);
      state.submitted = true;
      state.finalMalloy = fixedSrc;
      state.finalCompiledSql = c.sql!;
      state.finalRows = rows;
      return { content: `Submitted. ${rows.length} row(s).`, isError: false };
    } catch (e) {
      return {
        content: `Compiled SQL failed on MotherDuck: ${e instanceof Error ? e.message : String(e)}\nThe answer was NOT recorded — fix and resubmit.`,
        isError: true,
      };
    }
  }

  return { content: `Unknown tool: ${name}`, isError: true };
}
