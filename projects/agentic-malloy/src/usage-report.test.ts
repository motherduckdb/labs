import { describe, it, expect } from 'vitest';
import { computeUsageReport, type UsageRow } from './usage-report.js';
import { buildLayerIndex } from './miss-analysis.js';

// Tiny layer: source `s` with one view `v`, so referencedViews can resolve `s -> v`.
const INDEX = buildLayerIndex({
  't.malloy': 'source: s is duckdb.sql("""SELECT 1 as x""") extend {\n  view: v is { group_by: x }\n}',
});

const AUTH_SRC = 'x'.repeat(40); // authored-malloy per-query source
const VIEW_SRC = 'run: s -> v + { limit: 1 }'; // references view v on source s
const SQL_SRC = 'z'.repeat(51); // raw authored SQL (in compiled_sql for sql answers)

function sampleRows(): UsageRow[] {
  return [
    { answer_kind: 'authored-malloy', malloy_source: AUTH_SRC, compiled_sql: 'y'.repeat(200), is_correct: true, tool_calls: 5, prompt_tokens: 100, completion_tokens: 10, cached_tokens: 80, cache_write_tokens: 20, cost_usd: 0.01 },
    { answer_kind: 'view-selection', malloy_source: VIEW_SRC, compiled_sql: 'q'.repeat(60), is_correct: true, tool_calls: 6, prompt_tokens: 200, completion_tokens: 20, cached_tokens: 100, cache_write_tokens: 0, cost_usd: 0.02 },
    { answer_kind: 'sql', malloy_source: null, compiled_sql: SQL_SRC, is_correct: false, tool_calls: 3, prompt_tokens: 50, completion_tokens: 5, cached_tokens: 50, cache_write_tokens: 0, cost_usd: 0.005 },
    { answer_kind: null, malloy_source: null, compiled_sql: null, is_correct: false, tool_calls: 1, prompt_tokens: 30, completion_tokens: 0, cached_tokens: 0, cache_write_tokens: 0, cost_usd: 0.001 },
  ];
}

describe('computeUsageReport', () => {
  const r = computeUsageReport(sampleRows(), { centralLayerChars: 5000, layerIndex: INDEX, contextChars: { skill: 4000, primer: 2000, glossary: 2000 } });

  it('counts tasks, accuracy, and per-kind split', () => {
    expect(r.n).toBe(4);
    expect(r.accuracy).toBe(50); // 2/4
    const byKind = Object.fromEntries(r.byKind.map((k) => [k.kind, k]));
    expect(byKind['authored-malloy'].n).toBe(1);
    expect(byKind['view-selection'].n).toBe(1);
    expect(byKind['sql'].n).toBe(1);
    expect(byKind['none'].n).toBe(1);
    expect(byKind['sql'].accuracy).toBe(0);
    expect(byKind['authored-malloy'].accuracy).toBe(100);
  });

  it('computes share-of-logic from authored Malloy vs authored SQL chars', () => {
    expect(r.shareOfLogic.malloyChars).toBe(AUTH_SRC.length + VIEW_SRC.length); // Malloy answers' malloy_source
    expect(r.shareOfLogic.sqlChars).toBe(SQL_SRC.length); // sql answer's compiled_sql only
    const expected = (AUTH_SRC.length + VIEW_SRC.length) / (AUTH_SRC.length + VIEW_SRC.length + SQL_SRC.length);
    expect(r.shareOfLogic.ratio).toBeCloseTo(expected, 5);
  });

  it('null share-of-logic ratio when no authored logic', () => {
    const none = computeUsageReport([{ answer_kind: null, malloy_source: null, compiled_sql: null }], { centralLayerChars: 1 });
    expect(none.shareOfLogic.ratio).toBeNull();
  });

  it('central-vs-per-query: per-query Malloy size + Malloy→SQL expansion', () => {
    expect(r.centralVsPerQuery.centralLayerChars).toBe(5000);
    expect(r.centralVsPerQuery.perQueryMalloyMeanChars).toBe(Math.round((AUTH_SRC.length + VIEW_SRC.length) / 2));
    // expansion = mean(200/40, 60/len(VIEW_SRC))
    expect(r.centralVsPerQuery.malloyToSqlExpansion).toBeCloseTo((200 / AUTH_SRC.length + 60 / VIEW_SRC.length) / 2, 5);
  });

  it('view utilization resolves referenced views against the index', () => {
    expect(r.viewUtilization).toBeDefined();
    expect(r.viewUtilization!.totalViews).toBe(1);
    expect(r.viewUtilization!.usedViews).toBe(1);
    expect(r.viewUtilization!.utilizationPct).toBe(100);
    expect(r.viewUtilization!.topViews[0]).toMatchObject({ view: 'v', count: 1 });
  });

  it('token + cost aggregates with cache hit rate', () => {
    expect(r.tokens.totalPrompt).toBe(380);
    expect(r.tokens.totalCached).toBe(230);
    expect(r.tokens.cacheHitRate).toBeCloseTo((230 / 380) * 100, 5);
    expect(r.tokens.totalCost).toBeCloseTo(0.036, 5);
    expect(r.tokens.meanCostPerTask).toBeCloseTo(0.009, 5);
  });

  it('context breakdown present only when contextChars given; omitted otherwise', () => {
    expect(r.context!.skillTok).toBe(1000); // 4000 chars / 4
    expect(r.context!.totalTok).toBe(2000); // (4000+2000+2000)/4
    const noCtx = computeUsageReport(sampleRows(), { centralLayerChars: 1 });
    expect(noCtx.context).toBeUndefined();
    expect(noCtx.viewUtilization).toBeUndefined();
  });
});
