/**
 * malloy-source — dependency-light PURE analysis of Malloy MODEL source text.
 * Shared by `layer-build` (the 2A.3 deterministic build gates) and `malloy-store`
 * (the 3.1 list_views aggregation tag). No runtime, no DB, no dataset facts — only
 * name/structure heuristics over the source string — so it is task-general and unit
 * testable without credentials.
 *
 * Two jobs:
 *  - resolve a VIEW's ranking aggregation (avg/sum/min/max/count) by following its
 *    order_by / aggregate measure to that measure's definition;
 *  - three GATES that flag general modeling defects a layer build should not ship:
 *    (1) an incomplete aggregation set (avg/min/max without a sum + count),
 *    (2) a hardcoded VALUES universe for a column whose domain is data-derivable,
 *    (3) a view NAMED for an extremum/total that actually ranks by an AVERAGE.
 */

export type AggMode = 'avg' | 'sum' | 'min' | 'max' | 'count';

export interface GateFinding {
  code: 'aggregation_set_incomplete' | 'hardcoded_derivable_domain' | 'name_vs_aggregation';
  message: string;
}

const VIEW_DEF_RE = /\bview:\s*([A-Za-z_][A-Za-z0-9_]*)\s+is\s*\{/g;
const MEASURE_DEF_RE = /\bmeasure:\s*([A-Za-z_][A-Za-z0-9_]*)\s+is\s+([^\n]+)/g;
const EXTREMUM_NAME_RE = /(most_expensive|least_expensive|cheapest|priciest|highest|lowest|max|min|top|bottom)/i;

/** The aggregation modes an expression applies — both the path form (`x.avg()`)
 *  and the function form (`avg(x)`). Returns the set actually present. Pure. */
export function aggregationModesOf(expr: string): Set<AggMode> {
  const modes = new Set<AggMode>();
  for (const m of ['avg', 'sum', 'min', 'max', 'count'] as AggMode[]) {
    // `.avg()` / `.avg (` path form, or `avg(` function form.
    if (new RegExp(`\\.\\s*${m}\\s*\\(|\\b${m}\\s*\\(`, 'i').test(expr)) modes.add(m);
  }
  return modes;
}

/** Extract the {...} block that starts at the brace index `open` (balanced). Pure. */
function bracedBlock(body: string, open: number): string {
  let depth = 0;
  for (let i = open; i < body.length; i++) {
    const c = body[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return body.slice(open, i + 1);
    }
  }
  return body.slice(open);
}

/** name -> defining expression for every `measure:` in the body. Pure. */
function measureExprs(body: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const mm of body.matchAll(MEASURE_DEF_RE)) m.set(mm[1], mm[2].trim());
  return m;
}

/** Names of all views in the body whose name implies an extremum/ranking. Pure. */
export function extremumViewNames(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(new RegExp(VIEW_DEF_RE))) {
    if (EXTREMUM_NAME_RE.test(m[1])) out.push(m[1]);
  }
  return out;
}

/** Find the view block by name (or null). Pure. */
function viewBlock(body: string, view: string): string | null {
  const re = new RegExp(`\\bview:\\s*${view.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+is\\s*\\{`);
  const m = re.exec(body);
  if (!m) return null;
  return bracedBlock(body, m.index + m[0].length - 1);
}

/**
 * The aggregation a NAMED view ranks/aggregates by: follow its first `order_by`
 * term that resolves to a measure (else its first `aggregate:` measure) to that
 * measure's definition, and return the dominant mode. Returns null when it can't
 * be confidently resolved (caller emits no tag / no flag rather than guess). Pure.
 */
export function viewRankingAggregation(body: string, view: string): AggMode | null {
  const block = viewBlock(body, view);
  if (!block) return null;
  const measures = measureExprs(body);
  const dominant = (name: string): AggMode | null => {
    const expr = measures.get(name);
    if (!expr) return null;
    const modes = aggregationModesOf(expr);
    for (const m of ['avg', 'sum', 'max', 'min', 'count'] as AggMode[]) if (modes.has(m)) return m;
    return null;
  };
  // 1. the first order_by term that names a measure (the ranking key).
  const ob = block.match(/\border_by:\s*([^\n}]+)/);
  if (ob) {
    for (const term of ob[1].split(',')) {
      const id = term.trim().match(/^([A-Za-z_]\w*)/)?.[1];
      if (id) {
        const mode = dominant(id);
        if (mode) return mode;
      }
    }
  }
  // 2. fall back to the first aggregate: measure.
  const ag = block.match(/\baggregate:\s*([^\n}]+)/);
  if (ag) {
    for (const term of ag[1].split(',')) {
      const id = term.trim().match(/^([A-Za-z_]\w*)/)?.[1];
      if (id) {
        const mode = dominant(id);
        if (mode) return mode;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 2A.3 — the three deterministic build GATES (general; over source text only).
// ---------------------------------------------------------------------------

/** GATE 1 — aggregation-set completeness. A base quantity measured with
 *  avg/min/max but no sum (or a source exposing avg/min/max with no count of its
 *  rows) is incomplete: it forces the answering agent into the only mode present.
 *  Flags the base(s) missing a sum, and a missing count. Pure. */
export function auditAggregationSetCompleteness(body: string): GateFinding[] {
  const byBase = new Map<string, Set<AggMode>>();
  let hasCount = false;
  // path form: `<base>.avg()` etc.
  for (const m of body.matchAll(/([A-Za-z_][\w.]*)\.\s*(avg|sum|min|max|count)\s*\(\s*\)/g)) {
    const base = m[1];
    const mode = m[2].toLowerCase() as AggMode;
    if (mode === 'count') { hasCount = true; continue; }
    const s = byBase.get(base) ?? new Set<AggMode>();
    s.add(mode);
    byBase.set(base, s);
  }
  // function form: `avg(<base>)`, `count()` / `count(x)`.
  for (const m of body.matchAll(/\b(avg|sum|min|max|count)\s*\(\s*([A-Za-z_][\w.]*)?\s*\)/g)) {
    const mode = m[1].toLowerCase() as AggMode;
    const base = m[2];
    if (mode === 'count') { hasCount = true; continue; }
    if (!base) continue;
    const s = byBase.get(base) ?? new Set<AggMode>();
    s.add(mode);
    byBase.set(base, s);
  }
  // Skip NON-ADDITIVE quantities — a ratio/rate/average/count/share is not
  // meaningfully summed, so don't demand a sum of it (general, name-based; avoids
  // nudging the builder to author nonsense like sum-of-a-ratio).
  const NON_ADDITIVE = /(^|_)(ratio|rate|avg|average|mean|pct|percent|count|share|fraction|proportion)(_|$)/i;
  const missingSum: string[] = [];
  let anyExtremaMode = false;
  for (const [base, modes] of byBase) {
    if (NON_ADDITIVE.test(base)) continue; // ratios/counts/averages aren't summed
    if (modes.has('avg') || modes.has('min') || modes.has('max')) {
      anyExtremaMode = true;
      if (!modes.has('sum')) missingSum.push(base);
    }
  }
  const findings: GateFinding[] = [];
  if (missingSum.length) {
    findings.push({
      code: 'aggregation_set_incomplete',
      message: `Incomplete aggregation set: ${missingSum.map((b) => `\`${b}\``).join(', ')} ${missingSum.length === 1 ? 'is' : 'are'} measured with avg/min/max but NO sum. Expose the full standard set (sum, avg, min, max) of each per-row quantity so the caller can pick the right mode (a "total a transaction incurs" needs the SUM, not an average).`,
    });
  }
  if (anyExtremaMode && !hasCount) {
    findings.push({
      code: 'aggregation_set_incomplete',
      message: `This source exposes avg/min/max measures but no \`count()\` of its rows — add a count so group sizes are inspectable.`,
    });
  }
  return findings;
}

/** GATE 2 — no hardcoded derivable domain. A `(VALUES (...)) … CROSS JOIN`
 *  universe inside a `duckdb.sql(...)` source whose body ALSO matches list
 *  membership (`list_contains`) over a column proves the column is a LIST whose
 *  domain is data-derivable (`SELECT DISTINCT UNNEST(col)`). Hardcoding it drifts
 *  from the data (zero-row codes, missing codes). Pure. */
export function auditHardcodedDerivableDomain(body: string): GateFinding[] {
  // Universe columns enumerated by a hardcoded `(VALUES (...)) AS alias(col)` literal.
  // This catches BOTH the inline c3 pattern (VALUES cross-joined in one duckdb.sql)
  // AND the cleaner isolated-source pattern (a tiny `<col>_universe is duckdb.sql(
  // "SELECT * FROM (VALUES …) AS t(col)")` source matched via Malloy joins elsewhere).
  const findings: GateFinding[] = [];
  const seen = new Set<string>();
  for (const m of body.matchAll(/\(\s*VALUES\b[\s\S]{0,4000}?\)\s*AS\s+\w+\s*\(\s*([A-Za-z_]\w*)\s*\)/gi)) {
    const col = m[1];
    if (seen.has(col)) continue;
    // The enumerated column is matched against a LIST column via list_contains →
    // its domain is data-derivable (DISTINCT UNNEST). A VALUES set NOT used in a
    // list match (e.g. a static lookup) is left alone.
    if (!new RegExp(`list_contains[^)]*\\b${col}\\b`, 'i').test(body)) continue;
    seen.add(col);
    findings.push({
      code: 'hardcoded_derivable_domain',
      message: `Hardcoded universe: \`${col}\` is enumerated by a literal \`(VALUES (...))\` set but matched with \`list_contains\`, so its domain is data-derivable. Derive it instead — \`SELECT DISTINCT UNNEST(<list col>) FROM <base>\` — so it can't drift from the data (a hardcoded set can include a value present in zero rules, or miss one).`,
    });
  }
  return findings;
}

/** GATE 3 — name-vs-aggregation mismatch. A view named for an extremum/total
 *  (most_expensive / cheapest / highest / …) that ranks by an AVERAGE measure is
 *  almost certainly the wrong measure for the question its name implies. Pure. */
export function auditNameVsAggregation(body: string): GateFinding[] {
  const findings: GateFinding[] = [];
  for (const view of extremumViewNames(body)) {
    if (viewRankingAggregation(body, view) === 'avg') {
      findings.push({
        code: 'name_vs_aggregation',
        message: `View \`${view}\` is named for an extremum/total but ranks groups by an AVERAGE measure. A name implying "most/least/cheapest/highest" must rank by a true total or extremum, not an average over the rule population — expose/rank the SUM (or min/max), or rename the view to reflect that it ranks an average.`,
      });
    }
  }
  return findings;
}

/** Run all three build gates over one model file's source. Pure. */
export function layerSourceGate(body: string): GateFinding[] {
  return [
    ...auditAggregationSetCompleteness(body),
    ...auditHardcodedDerivableDomain(body),
    ...auditNameVsAggregation(body),
  ];
}
