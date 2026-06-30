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

  it('rejects duckdb.sql wrapped in Malloy and steers to submit_sql (when fallback enabled)', async () => {
    const d = deps({ allowSqlFallback: true });
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

  it('omits submit_sql by default (Malloy-only) and exposes it only when the fallback is enabled', () => {
    // Default (SQL prohibited): submit_sql is absent; submit_answer is present and
    // its description must not steer to the absent tool.
    const offSchemas = buildToolSchemas(deps());
    expect(offSchemas.map((t) => t.name)).not.toContain('submit_sql');
    expect(offSchemas.map((t) => t.name)).toContain('submit_answer');
    const offSubmit = offSchemas.find((t) => t.name === 'submit_answer')!;
    expect(offSubmit.description).not.toContain('submit_sql');
    // Opt-in arm: submit_sql exposed; submit_answer keeps the SQL-path hint.
    const onSchemas = buildToolSchemas(deps({ allowSqlFallback: true }));
    expect(onSchemas.map((t) => t.name)).toContain('submit_sql');
    const onSubmit = onSchemas.find((t) => t.name === 'submit_answer')!;
    expect(onSubmit.description).toContain('duckdb.sql'); // on-arm keeps the SQL-path hint
  });

  it('duckdb.sql reject does NOT name submit_sql in the default (Malloy-only) arm', async () => {
    const off = await dispatchTool(deps(), 'run_malloy', { source: 'run: duckdb.sql("""select 1""") -> { select: x }' });
    expect(off.isError).toBe(true);
    expect(off.content).not.toContain('submit_sql');
    expect(off.content).toContain('submit_answer');
  });
});

describe('answer-shape one-shot soft-warn (both submit paths)', () => {
  it('first submit with a shape issue warns + does NOT latch; resubmit latches', async () => {
    const d = deps({ runtime: runtimeReturning([{ pct: 0.114862 }]), question: 'What percentage of transactions are fraudulent?', guidelines: 'Round to 6 decimals.' });
    const first = await dispatchTool(d, 'submit_answer', { source: 'run: x -> { aggregate: pct }' });
    expect(first.isError).toBe(false);
    expect(first.content).toContain('NOT YET RECORDED');
    expect(d.state.submitted).toBe(false);
    expect(d.state.shapeWarned).toBe(true);
    // resubmit (even the same answer) latches — the soft-warn never hard-blocks.
    const second = await dispatchTool(d, 'submit_answer', { source: 'run: x -> { aggregate: pct }' });
    expect(second.isError).toBe(false);
    expect(d.state.submitted).toBe(true);
  });

  it('a clean-shaped answer latches on the first submit (no warning)', async () => {
    const d = deps({ runtime: runtimeReturning([{ pct: 11.486208 }]), question: 'What percentage of transactions are fraudulent?' });
    const r = await dispatchTool(d, 'submit_answer', { source: 'run: x -> { aggregate: pct }' });
    expect(d.state.submitted).toBe(true);
    expect(r.content).toContain('Submitted');
  });

  it('an answer submitted with no question/guideline context is never warned', async () => {
    // deps() has no question/guidelines → linter is a no-op even on an odd shape.
    const d = deps({ runtime: runtimeReturning([{ pct: 0.5 }]) });
    await dispatchTool(d, 'submit_answer', { source: 'run: x -> { aggregate: pct }' });
    expect(d.state.submitted).toBe(true);
  });

  it('warns on the submit_sql path too, then latches on resubmit', async () => {
    const client = { callTool: async () => ({ structuredContent: { rows: [[0.62]] } }) } as unknown as ToolDeps['client'];
    const d = deps({ client, allowSqlFallback: true, database: 'agentic_malloy', question: 'What percentage of x are fraudulent?', guidelines: 'a percentage' });
    const first = await dispatchTool(d, 'submit_sql', { sql: 'select 0.62' });
    expect(first.content).toContain('NOT YET RECORDED');
    expect(d.state.submitted).toBe(false);
    const second = await dispatchTool(d, 'submit_sql', { sql: 'select 0.62' });
    expect(d.state.submitted).toBe(true);
    expect(d.state.answerKind).toBe('sql');
  });
});
