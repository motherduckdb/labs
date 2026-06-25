import { describe, expect, it } from 'vitest';
import { buildToolSchemas, dispatchTool, newRunState, type ToolDeps } from './tools.js';
import type { MalloyRuntime } from './malloy-runtime.js';

function runtimeReturning(rows: Record<string, unknown>[], ok = true): MalloyRuntime {
  return {
    run: async () => (ok ? { ok: true, sql: 'select 1', rows } : { ok: false, diagnostics: [{ message: 'local failed' }] }),
  } as unknown as MalloyRuntime;
}

function deps(overrides: Partial<ToolDeps> = {}): ToolDeps {
  return {
    client: {} as ToolDeps['client'],
    runtime: runtimeReturning([{ a: 1, b: 'x' }]),
    localRuntime: runtimeReturning([{ a: 1, b: 'x' }]),
    store: {} as ToolDeps['store'],
    symbols: new Set<string>(),
    mcpTools: [],
    state: newRunState(),
    ...overrides,
  };
}

describe('submit_answer translation diagnostic', () => {
  it('records true when the local and MotherDuck rowsets match', async () => {
    const d = deps();
    const result = await dispatchTool(d, 'submit_answer', { source: 'run: x -> { aggregate: n }' });

    expect(result.isError).toBe(false);
    expect(d.state.translationMatch).toBe(true);
  });

  it('records false when the local row shape differs from the scored rows', async () => {
    const d = deps({ localRuntime: runtimeReturning([{ b: 'x', a: 1 }]) });
    const result = await dispatchTool(d, 'submit_answer', { source: 'run: x -> { aggregate: n }' });

    expect(result.isError).toBe(false);
    expect(d.state.translationMatch).toBe(false);
  });

  it('leaves the diagnostic null when the warning-only local run fails', async () => {
    const d = deps({ localRuntime: runtimeReturning([], false) });
    const result = await dispatchTool(d, 'submit_answer', { source: 'run: x -> { aggregate: n }' });

    expect(result.isError).toBe(false);
    expect(d.state.translationMatch).toBeNull();
  });
});

describe('answer_kind + SQL fallback', () => {
  it('tags a view-referencing Malloy answer as view-selection', async () => {
    const d = deps({ viewNames: new Set(['cheapest_aci_on_100']) });
    await dispatchTool(d, 'submit_answer', { source: 'run: c3 -> cheapest_aci_on_100 + { limit: 1 }' });
    expect(d.state.answerKind).toBe('view-selection');
  });

  it('tags a from-scratch Malloy answer as authored-malloy', async () => {
    const d = deps({ viewNames: new Set(['cheapest_aci_on_100']) });
    await dispatchTool(d, 'submit_answer', { source: 'run: payments_base -> { aggregate: n is count() }' });
    expect(d.state.answerKind).toBe('authored-malloy');
  });

  it('rejects duckdb.sql wrapped in Malloy and steers to submit_sql', async () => {
    const d = deps();
    const run = await dispatchTool(d, 'run_malloy', { source: 'run: duckdb.sql("""select 1""") -> { select: x }' });
    expect(run.isError).toBe(true);
    expect(run.content).toContain('submit_sql');
    const sub = await dispatchTool(d, 'submit_answer', { source: 'run: duckdb.sql("""select 1""") -> { select: x }' });
    expect(sub.isError).toBe(true);
    expect(d.state.submitted).toBe(false);
  });

  it('submit_sql executes on MotherDuck, latches rows + sql, tags sql', async () => {
    const client = { callTool: async () => ({ structuredContent: { rows: [['Visa']] } }) } as unknown as ToolDeps['client'];
    const d = deps({ client, allowSqlFallback: true, database: 'agentic_malloy' });
    const result = await dispatchTool(d, 'submit_sql', { sql: 'select card_scheme from x limit 1' });
    expect(result.isError).toBe(false);
    expect(d.state.submitted).toBe(true);
    expect(d.state.answerKind).toBe('sql');
    expect(d.state.finalCompiledSql).toBe('select card_scheme from x limit 1');
    expect(d.state.finalRows).toEqual([['Visa']]);
    expect(d.state.finalMalloy).toBeUndefined();
  });

  it('submit_sql is rejected when SQL fallback is disabled', async () => {
    const d = deps({ allowSqlFallback: false });
    const result = await dispatchTool(d, 'submit_sql', { sql: 'select 1' });
    expect(result.isError).toBe(true);
    expect(d.state.submitted).toBe(false);
  });

  it('list_views returns the store catalog', async () => {
    const d = deps({ store: { listViews: () => 'CATALOG-LINE' } as unknown as ToolDeps['store'] });
    const result = await dispatchTool(d, 'list_views', {});
    expect(result.isError).toBe(false);
    expect(result.content).toBe('CATALOG-LINE');
  });

  it('exposes submit_sql by default but omits it when SQL fallback is disabled', () => {
    expect(buildToolSchemas(deps()).map((t) => t.name)).toContain('submit_sql');
    const offNames = buildToolSchemas(deps({ allowSqlFallback: false })).map((t) => t.name);
    expect(offNames).not.toContain('submit_sql');
    expect(offNames).toContain('submit_answer'); // Malloy path still present
  });
});
