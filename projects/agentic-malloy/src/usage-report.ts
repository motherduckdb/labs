/**
 * usage-report: substrate-value metrics over a completed eval run (the per-question
 * results JSONL). Answers "is the Malloy layer earning its keep" — how much answer
 * logic the agent authored as Malloy vs raw SQL, how thin the per-query Malloy is
 * against the reusable central layer, which layer views actually get reused, and the
 * answer-time context-token breakdown. Pure (no I/O) so it is unit-testable; the CLI
 * (`cmdUsageReport`) does the file/store loading and calls these.
 */
import { referencedViews, type LayerIndex } from './miss-analysis.js';

/** A results-JSONL row (loosely typed — only the fields the report reads). */
export interface UsageRow {
  answer_kind?: string | null;
  malloy_source?: string | null;
  compiled_sql?: string | null;
  is_correct?: boolean;
  tool_calls?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  cached_tokens?: number;
  cache_write_tokens?: number;
  cost_usd?: number;
}

export interface UsageReportCtx {
  centralLayerChars: number;
  /** Enables the view-utilization section (omit to skip it). */
  layerIndex?: LayerIndex;
  /** Answer-time prefix composition, in chars (skill + primer + glossary). */
  contextChars?: { skill: number; primer: number; glossary: number };
}

export interface KindStat {
  kind: string;
  n: number;
  pct: number;
  accuracy: number; // 0–100
  meanTools: number;
  meanPromptTokens: number;
  meanCost: number;
}
export interface UsageReport {
  n: number;
  accuracy: number; // 0–100
  byKind: KindStat[];
  shareOfLogic: { malloyChars: number; sqlChars: number; ratio: number | null }; // ratio 0–1, null if no authored logic
  centralVsPerQuery: {
    centralLayerChars: number;
    perQueryMalloyMeanChars: number;
    perQueryMalloyMedianChars: number;
    malloyToSqlExpansion: number | null; // mean compiled_sql.len / malloy_source.len over Malloy answers
  };
  viewUtilization?: {
    totalViews: number;
    usedViews: number;
    utilizationPct: number;
    topViews: Array<{ view: string; source: string; count: number }>;
  };
  context?: { skillTok: number; primerTok: number; glossaryTok: number; centralLayerTok: number; totalTok: number };
  tokens: {
    totalPrompt: number;
    totalCompletion: number;
    totalCached: number;
    totalCacheWrite: number;
    cacheHitRate: number; // 0–100
    totalCost: number;
    meanCostPerTask: number;
  };
}

const MALLOY_KINDS = new Set(['view-selection', 'authored-malloy']);
const KIND_ORDER = ['view-selection', 'authored-malloy', 'sql', 'none'];
const TOK = (chars: number) => Math.round(chars / 4); // ~4 chars/token (approx)

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const kindOf = (r: UsageRow) => r.answer_kind || 'none';

export function computeUsageReport(rows: UsageRow[], ctx: UsageReportCtx): UsageReport {
  const n = rows.length;
  const num = (x: number | undefined) => x || 0;
  const accuracy = n ? (rows.filter((r) => r.is_correct).length / n) * 100 : 0;

  // Per-kind economics.
  const groups = new Map<string, UsageRow[]>();
  for (const r of rows) (groups.get(kindOf(r)) ?? groups.set(kindOf(r), []).get(kindOf(r))!).push(r);
  const byKind: KindStat[] = [...groups.entries()]
    .map(([kind, rs]) => ({
      kind,
      n: rs.length,
      pct: n ? (rs.length / n) * 100 : 0,
      accuracy: rs.length ? (rs.filter((r) => r.is_correct).length / rs.length) * 100 : 0,
      meanTools: mean(rs.map((r) => num(r.tool_calls))),
      meanPromptTokens: mean(rs.map((r) => num(r.prompt_tokens))),
      meanCost: mean(rs.map((r) => num(r.cost_usd))),
    }))
    .sort((a, b) => (KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)) || b.n - a.n);

  // Share-of-logic: authored Malloy chars vs authored SQL chars (compiled SQL of
  // Malloy answers is machine-generated, NOT authored logic — excluded here).
  const malloyRows = rows.filter((r) => MALLOY_KINDS.has(kindOf(r)) && r.malloy_source);
  const sqlRows = rows.filter((r) => kindOf(r) === 'sql' && r.compiled_sql);
  const malloyChars = malloyRows.reduce((a, r) => a + (r.malloy_source?.length ?? 0), 0);
  const sqlChars = sqlRows.reduce((a, r) => a + (r.compiled_sql?.length ?? 0), 0);
  const denom = malloyChars + sqlChars;

  // Central layer vs per-query authored Malloy; Malloy→SQL expansion.
  const perQ = malloyRows.map((r) => r.malloy_source!.length);
  const expansions = malloyRows
    .filter((r) => r.compiled_sql && r.malloy_source!.length > 0)
    .map((r) => r.compiled_sql!.length / r.malloy_source!.length);

  const report: UsageReport = {
    n,
    accuracy,
    byKind,
    shareOfLogic: { malloyChars, sqlChars, ratio: denom ? malloyChars / denom : null },
    centralVsPerQuery: {
      centralLayerChars: ctx.centralLayerChars,
      perQueryMalloyMeanChars: Math.round(mean(perQ)),
      perQueryMalloyMedianChars: median(perQ),
      malloyToSqlExpansion: expansions.length ? mean(expansions) : null,
    },
    tokens: {
      totalPrompt: rows.reduce((a, r) => a + num(r.prompt_tokens), 0),
      totalCompletion: rows.reduce((a, r) => a + num(r.completion_tokens), 0),
      totalCached: rows.reduce((a, r) => a + num(r.cached_tokens), 0),
      totalCacheWrite: rows.reduce((a, r) => a + num(r.cache_write_tokens), 0),
      cacheHitRate: 0,
      totalCost: rows.reduce((a, r) => a + num(r.cost_usd), 0),
      meanCostPerTask: 0,
    },
  };
  report.tokens.cacheHitRate = report.tokens.totalPrompt ? (report.tokens.totalCached / report.tokens.totalPrompt) * 100 : 0;
  report.tokens.meanCostPerTask = n ? report.tokens.totalCost / n : 0;

  // View utilization (which layer views actually get reused).
  if (ctx.layerIndex) {
    const totalViews = [...ctx.layerIndex.viewsBySource.values()].reduce((a, s) => a + s.size, 0);
    const counts = new Map<string, { view: string; source: string; count: number }>();
    for (const r of malloyRows) {
      for (const { source, view } of referencedViews(r.malloy_source!, ctx.layerIndex)) {
        const key = `${source}.${view}`;
        (counts.get(key) ?? counts.set(key, { view, source, count: 0 }).get(key)!).count++;
      }
    }
    const topViews = [...counts.values()].sort((a, b) => b.count - a.count).slice(0, 10);
    report.viewUtilization = {
      totalViews,
      usedViews: counts.size,
      utilizationPct: totalViews ? (counts.size / totalViews) * 100 : 0,
      topViews,
    };
  }

  // Answer-time context-token breakdown (the static prefix the prompt re-sends).
  if (ctx.contextChars) {
    const c = ctx.contextChars;
    const skillTok = TOK(c.skill), primerTok = TOK(c.primer), glossaryTok = TOK(c.glossary), centralLayerTok = TOK(ctx.centralLayerChars);
    report.context = { skillTok, primerTok, glossaryTok, centralLayerTok, totalTok: skillTok + primerTok + glossaryTok };
  }

  return report;
}

export function formatUsageReport(r: UsageReport, label?: string): string {
  const L: string[] = [];
  const pct = (x: number) => `${x.toFixed(0)}%`;
  if (label) L.push(label);
  L.push(`tasks: ${r.n}   accuracy: ${r.accuracy.toFixed(1)}%`);
  L.push('');
  L.push('answer-path economics:');
  L.push(`  ${'kind'.padEnd(16)}${'n'.padStart(5)}${'%'.padStart(6)}${'acc'.padStart(6)}${'meanTools'.padStart(11)}${'meanPromptTok'.padStart(15)}${'meanCost'.padStart(10)}`);
  for (const k of r.byKind)
    L.push(`  ${k.kind.padEnd(16)}${String(k.n).padStart(5)}${pct(k.pct).padStart(6)}${pct(k.accuracy).padStart(6)}${k.meanTools.toFixed(1).padStart(11)}${Math.round(k.meanPromptTokens).toLocaleString().padStart(15)}${('$' + k.meanCost.toFixed(4)).padStart(10)}`);
  L.push('');
  const sl = r.shareOfLogic;
  L.push(`share-of-logic (authored Malloy / authored Malloy+SQL): ${sl.ratio == null ? 'n/a' : pct(sl.ratio * 100)}`);
  L.push(`  authored Malloy: ${sl.malloyChars.toLocaleString()} chars   authored SQL: ${sl.sqlChars.toLocaleString()} chars`);
  const cv = r.centralVsPerQuery;
  L.push(`central layer: ${cv.centralLayerChars.toLocaleString()} chars   per-query Malloy: mean ${cv.perQueryMalloyMeanChars.toLocaleString()} / median ${cv.perQueryMalloyMedianChars.toLocaleString()} chars`
    + (cv.malloyToSqlExpansion != null ? `   Malloy→SQL ×${cv.malloyToSqlExpansion.toFixed(1)}` : ''));
  if (r.viewUtilization) {
    const v = r.viewUtilization;
    L.push('');
    L.push(`view utilization: ${v.usedViews}/${v.totalViews} views used (${pct(v.utilizationPct)})`);
    if (v.topViews.length) L.push('  top: ' + v.topViews.map((t) => `${t.view}×${t.count}`).join(', '));
  }
  if (r.context) {
    const c = r.context;
    L.push('');
    L.push(`answer-time context (~tokens): skill ${c.skillTok.toLocaleString()} · primer ${c.primerTok.toLocaleString()} · glossary ${c.glossaryTok.toLocaleString()} = ${c.totalTok.toLocaleString()} prose prefix  (central layer ${c.centralLayerTok.toLocaleString()}, read on demand)`);
  }
  const t = r.tokens;
  L.push('');
  L.push(`tokens: prompt ${t.totalPrompt.toLocaleString()} (cache hit ${pct(t.cacheHitRate)}) · completion ${t.totalCompletion.toLocaleString()}   cost: $${t.totalCost.toFixed(2)} ($${t.meanCostPerTask.toFixed(4)}/task)`);
  return L.join('\n');
}
