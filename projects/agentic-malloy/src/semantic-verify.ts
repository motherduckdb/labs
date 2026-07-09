/**
 * semantic-verify — GENERIC, DOMAIN-AGNOSTIC semantic self-verification for the
 * layer-build gate.
 *
 * The build gate proves a view COMPILES and EXECUTES; it does not prove the
 * numbers are RIGHT. A measure that double-counts across a fan-out, or that is
 * not grain-invariant, compiles and runs and ships silently WRONG. These checks
 * run at build time against the local compile DB and surface violations through
 * the SAME quality-findings / re-emit nudge that `view-quality` and the
 * `layerSourceGate` use — so the author is nudged to fix them, once, before the
 * file is accepted.
 *
 * The checks are CONSERVATIVE by construction — a false positive would block a
 * CORRECT build, which is worse than a missed defect. Every check:
 *   - operates only on a source's OWN declared measures (not inherited ones),
 *   - skips whenever it cannot SAFELY determine the base grain / a base key,
 *   - uses a numeric tolerance (never flags floating-point noise),
 *   - never flags a correctly-authored additive measure (validated against the
 *     current committed layer — see semantic-verify.test.ts).
 *
 * IMPORTANT Malloy note (why the trigger is narrow): Malloy's SYMMETRIC
 * aggregates already make the common base-grain sum grain-invariant across a
 * `join_many` — `eur_amount.sum()` on a fanned source returns the correct base
 * total, NOT an inflated one. The residual "clean integer-multiple inflation"
 * defect appears specifically when a BASE-grain column is summed at the JOINED
 * relationship's locality (`joined.sum(base_col)`): that multiplies the base
 * value by the per-base fan-out count. THAT is the pattern check #1 targets, and
 * it confirms the inflation NUMERICALLY (join-locality sum vs base-locality sum
 * of the SAME column) before flagging — so it never fires on a genuinely
 * join-grain quantity (whose two localities agree).
 */
import type { MalloyRuntime } from './malloy-runtime.js';

export interface SemanticFinding {
  // Only the two IMPLEMENTED checks appear here. Monotonicity (a filtered count ≤
  // the unfiltered count) is DEFERRED: in Malloy a filtered aggregate literally
  // counts a subset, so the invariant holds by construction and a check could
  // never fire cleanly — it would add cost with no signal and risk false
  // positives on filters that reach through a join. See the module header + the
  // task report for the rationale.
  code:
    | 'fanout_grain_noninvariance'
    | 'additivity_mismatch'
    | 'parameter_inert'
    | 'identity_delta_nonzero'
    | 'crossjoin_coaggregation';
  source: string;
  measure?: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Pure source parsing (no DB) — enumerate a file's sources + their measures.
// ---------------------------------------------------------------------------

export interface ParsedSource {
  name: string;
  /** the source this one is `is <base> extend {...}` on (bare name, params + projections stripped). */
  base: string | null;
  /** true if this source is parameterized (`##! experimental.parameters` + a signature). */
  parameterized: boolean;
  /**
   * the FULL source declaration text after its name — every `extend { ... }` and
   * `-> { ... }` block up to the next top-level `source:`/`query:` (or EOF). We
   * keep the whole span (not just the first brace block) because the
   * projection-then-extend pattern (`base extend { joins } -> { select } extend {
   * primary_key; measures; views }`) puts the primary_key + measures in the
   * SECOND extend, after the projection.
   */
  body: string;
}

/** Skip a balanced `(...)` beginning at `open` (a param signature); return the
 *  index just past its `)`, or `open` if there is no `(` right there. Pure. */
function skipParens(text: string, open: number): number {
  // allow whitespace before the paren
  let i = open;
  while (i < text.length && /\s/.test(text[i])) i++;
  if (text[i] !== '(') return open;
  let depth = 0;
  for (; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return text.length;
}

/**
 * Parse every `source: <name> ...` declaration in a model file, capturing the
 * base source and the FULL declaration body (all extend/projection blocks). Pure.
 */
export function parseSources(fileText: string): ParsedSource[] {
  const parameterized = /(^|\n)\s*##!\s*experimental\.parameters/.test(fileText);
  const out: ParsedSource[] = [];
  // Top-level `source:` / `query:` starts (used both to anchor a source and to
  // bound the previous one's body).
  const declRe = /(^|\n)[ \t]*(?:source|query):[ \t]*([A-Za-z_]\w*)/g;
  const decls: Array<{ name: string; nameEnd: number; declStart: number; isSource: boolean }> = [];
  let m: RegExpExecArray | null;
  while ((m = declRe.exec(fileText))) {
    const isSource = /source:/.test(m[0]);
    decls.push({ name: m[2], nameEnd: m.index + m[0].length, declStart: m.index + (m[1] ? m[1].length : 0), isSource });
  }
  for (let k = 0; k < decls.length; k++) {
    const d = decls[k];
    if (!d.isSource) continue;
    const end = k + 1 < decls.length ? decls[k + 1].declStart : fileText.length;
    const span = fileText.slice(d.nameEnd, end);
    // Resolve the base source: skip a param signature `(...)`, then read the
    // identifier after `is`.
    let base: string | null = null;
    const afterParams = skipParens(span, 0);
    const isM = span.slice(afterParams).match(/^\s*is\s+([A-Za-z_][\w.]*)/);
    if (isM && !/^duckdb\b/.test(isM[1])) base = isM[1];
    out.push({ name: d.name, base, parameterized, body: span });
  }
  return out;
}

const FANOUT_RE = /\bjoin_many\b|\bjoin_cross\b/;
/** True when a source's body declares a row-multiplying join (fan-out). Pure. */
export function declaresFanOut(body: string): boolean {
  return FANOUT_RE.test(body);
}

/** The `primary_key: X` declared in a body, or null. Pure. */
export function primaryKeyOf(body: string): string | null {
  return body.match(/\bprimary_key:\s*([A-Za-z_]\w*)/)?.[1] ?? null;
}

/**
 * Resolve a source's base grain KEY: its own `primary_key`, else walk the `is
 * <base>` chain to an ancestor that declares one. Returns null when no key can be
 * safely determined (→ the fan-out check skips the source). Pure.
 */
export function resolveBaseKey(name: string, byName: Map<string, ParsedSource>): string | null {
  const seen = new Set<string>();
  let cur: ParsedSource | undefined = byName.get(name);
  while (cur && !seen.has(cur.name)) {
    seen.add(cur.name);
    const pk = primaryKeyOf(cur.body);
    if (pk) return pk;
    cur = cur.base ? byName.get(cur.base) : undefined;
  }
  return null;
}

export interface AdditiveMeasure {
  name: string;
  /** the aggregated inner expression text (what is inside sum(...) / .sum()). */
  inner: string;
  /** the joined relationship the sum is anchored at, e.g. `rules` in `rules.sum(x)`; null for a base-locality sum. */
  joinPath: string | null;
  /** true if the measure carries a `{ where: ... }` filter (base-locality comparison invalid → skip). */
  filtered: boolean;
}

// Generic (NOT domain) tokens whose presence in a measure name signals a
// deliberately match/fan-grain quantity ("the sum over the matched pairs"),
// which is a LEGITIMATE join-locality total and must never be flagged. These are
// GRAIN vocabulary, not dataset nouns — the same spirit as malloy-source.ts's
// non-additive token list (ratio/rate/avg/…).
const MATCH_GRAIN_NAME = /(^|_)(match|matched|matching|pair|pairs|per[_]?match|per[_]?pair|per[_]?rule|weighted|basis|targeted)(_|$)/i;
// Non-additive measure names — a ratio/avg/rate/share is not meaningfully summed,
// so it is never a fan-out inflation candidate (mirrors malloy-source.ts).
const NON_ADDITIVE_NAME = /(^|_)(ratio|rate|avg|average|mean|pct|percent|share|fraction|proportion|per[_]?txn|per[_]?transaction)(_|$)/i;
// A COUNTERFACTUAL/OVERRIDE parameter or column prefix — the param re-prices under a
// changed field rather than scoping the population. Such params are handled by the
// identity counterfactual check (#3b), NOT the filter-scoping inertness check (#3).
const OVERRIDE_PARAM_NAME = /^(alt|override|new|scenario|proposed|cf)_/i;

/**
 * Additive (sum-type) measures declared in a body whose sum is anchored at a
 * JOINED relationship and whose aggregated inner expression is a single BARE
 * column referencing only base/local columns (`joined.sum(base_col)`). These are
 * the fan-out inflation CANDIDATES — a base-grain quantity summed at the join
 * locality. Compound inner expressions, expressions that reference the join path
 * itself, filtered measures, and match/pair/non-additive-named measures are
 * EXCLUDED (conservative — those are legitimately join-grain or non-summable).
 * Pure.
 */
export function fanoutSumCandidates(body: string): AdditiveMeasure[] {
  const out: AdditiveMeasure[] = [];
  // measure: <name> is <path>.sum(<inner>)   — capture path + inner, then the tail
  // for an optional { where: } filter.
  const re = /\bmeasure:\s*([A-Za-z_]\w*)\s+is\s+([A-Za-z_]\w*)\.\s*sum\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const name = m[1];
    const joinPath = m[2];
    // extract the balanced (...) argument of sum(
    const argOpen = m.index + m[0].length - 1;
    let depth = 0;
    let close = -1;
    for (let i = argOpen; i < body.length; i++) {
      if (body[i] === '(') depth++;
      else if (body[i] === ')') {
        depth--;
        if (depth === 0) { close = i; break; }
      }
    }
    if (close < 0) continue;
    const inner = body.slice(argOpen + 1, close).trim();
    // the rest of the measure line, up to a newline, to detect a { where: } filter
    const rest = body.slice(close + 1, body.indexOf('\n', close) < 0 ? body.length : body.indexOf('\n', close));
    const filtered = /\{\s*where:/.test(rest) || /\{\s*where:/.test(body.slice(close + 1, close + 80));
    // inner must be a SINGLE BARE column (identifier, optional `` `quoted` ``) — no
    // operators, no function calls, and NOT prefixed by the join path (a `joined.col`
    // inner is genuinely at the join grain).
    const bare = inner.replace(/`/g, '');
    const isBareColumn = /^[A-Za-z_]\w*$/.test(bare);
    const innerRefsJoin = new RegExp(`\\b${joinPath}\\.`).test(inner);
    if (!isBareColumn || innerRefsJoin) continue;
    if (MATCH_GRAIN_NAME.test(name) || NON_ADDITIVE_NAME.test(name)) continue;
    out.push({ name, inner: bare, joinPath, filtered });
  }
  return out.filter((c) => !c.filtered);
}

/**
 * A low-cardinality DIMENSION declared in the body, usable as the group_by key
 * for the additivity self-consistency probe. We prefer an explicitly declared
 * `dimension:` with a plain name (not a compound expression). Pure.
 */
export function declaredDimensions(body: string): string[] {
  const out: string[] = [];
  // `dimension: <name> is ...` (single) and block `dimension:\n <name> is ...`.
  for (const m of body.matchAll(/\bdimension:\s*([A-Za-z_]\w*)\s+is\b/g)) out.push(m[1]);
  // block form: a `dimension:` followed by several `<name> is` lines before the next keyword.
  return [...new Set(out)];
}

/** Every `measure: <name> is ...` declared in a body (own measures). Pure. */
export function declaredMeasureNames(body: string): string[] {
  return [...new Set([...body.matchAll(/\bmeasure:\s*([A-Za-z_]\w*)\s+is\b/g)].map((m) => m[1]))];
}

/**
 * Measures anchored on a JOINED relationship via an aggregate method —
 * `measure: <name> is <joinPath>.<sum|avg|count|min|max>(...)`. Returns a map from
 * the measure name to the join path it aggregates over. These are the measures
 * whose value can be corrupted when TWO of them (on DIFFERENT join paths) are
 * co-aggregated in one query stage. Pure.
 */
export function joinAnchoredAggMeasures(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of body.matchAll(/\bmeasure:\s*([A-Za-z_]\w*)\s+is\s+([A-Za-z_]\w*)\.\s*(?:sum|avg|count|min|max)\s*\(/g)) {
    if (!out.has(m[1])) out.set(m[1], m[2]);
  }
  return out;
}

/**
 * Measures whose DEFINITION combines two or more other measures by NAME (an
 * arithmetic composition like `x is a - b` / `a + b` / `a / b`). Returns each such
 * measure with the subset of `anchored` measure names it references. A combining
 * measure that references measures anchored on DIFFERENT join paths forces those
 * join_many aggregates to be computed in ONE stage — the co-aggregation hazard.
 * Pure.
 */
export function combiningMeasures(body: string, anchored: Set<string>): Array<{ name: string; refs: string[] }> {
  const out: Array<{ name: string; refs: string[] }> = [];
  // one measure per line: `measure: <name> is <expr up to newline>`
  for (const m of body.matchAll(/\bmeasure:\s*([A-Za-z_]\w*)\s+is\s+([^\n]*)/g)) {
    const name = m[1];
    const expr = m[2];
    const refs = [...new Set([...expr.matchAll(/[A-Za-z_]\w*/g)].map((t) => t[0]))].filter(
      (t) => t !== name && anchored.has(t),
    );
    if (refs.length >= 2) out.push({ name, refs });
  }
  return out;
}

export interface ParsedParam {
  name: string;
  /** the column this param is compared against for equality/membership (a FILTER
   *  param), stripped to its final segment (`fees.scheme` → `scheme`); null if the
   *  param is not used in any narrowing predicate (→ not a filter, skip). */
  compareColumn: string | null;
}

/**
 * Parse a parameterized source's SIGNATURE params and classify which are FILTER
 * params — those referenced in an equality (`col = p` / `p = col`) or membership
 * (`list_contains(col, p)`) predicate in the body. Only filter params (with a
 * determinable compared column) are returned; an arithmetic-only param (e.g. a
 * notional scaler) is deliberately excluded — it changes the result legitimately
 * and is not a "should-scope-but-doesn't" candidate. Pure.
 */
export function parseFilterParams(body: string): ParsedParam[] {
  const open = body.indexOf('(');
  const sigEnd = skipParens(body, 0);
  if (open < 0 || sigEnd <= open + 1) return []; // no signature
  const sig = body.slice(open + 1, sigEnd - 1);
  const rest = body.slice(sigEnd);
  const out: ParsedParam[] = [];
  for (const decl of sig.split(',')) {
    const nm = decl.trim().match(/^([A-Za-z_]\w*)\s*::/);
    if (!nm) continue;
    const name = nm[1];
    // `col = p` or `p = col` (a plain equality, not `==`/`<=`/`>=`)
    const eq = rest.match(new RegExp(`([A-Za-z_][\\w.]*)\\s*(?<![<>=!])=(?![=])\\s*${name}\\b|\\b${name}\\s*(?<![<>=!])=(?![=])\\s*([A-Za-z_][\\w.]*)`));
    // `list_contains(col, p)` (incl. the raw-escape `list_contains!boolean(...)`)
    const lc = rest.match(new RegExp(`list_contains!?\\w*\\(\\s*([A-Za-z_][\\w.]*)\\s*,\\s*${name}\\b`));
    const raw = eq?.[1] || eq?.[2] || lc?.[1] || null;
    out.push({ name, compareColumn: raw ? raw.split('.').pop()! : null });
  }
  return out.filter((p) => p.compareColumn != null);
}

// ---------------------------------------------------------------------------
// Runtime probes — run against the local compile DB via the MalloyRuntime.
// ---------------------------------------------------------------------------

function num(v: unknown): number {
  if (typeof v === 'bigint') return Number(v);
  return typeof v === 'number' ? v : NaN;
}

/** Aggregate one scalar from a run; NaN on failure. */
async function scalar(rt: MalloyRuntime, query: string, field: string, timeoutMs: number): Promise<number> {
  const r = await rt.run(query, 5, timeoutMs);
  if (!r.ok || !r.rows?.length) return NaN;
  return num((r.rows[0] as Record<string, unknown>)[field]);
}

export interface VerifyOptions {
  /** relative tolerance for "equal" (default 1% — well above float noise). */
  tolerance?: number;
  /** per-probe execution budget (ms). */
  timeoutMs?: number;
  /** max distinct group_by values to accept for the additivity probe (default 60). */
  maxDimCardinality?: number;
}

/**
 * Probe ONE source for grain / additivity defects. `runnableName` is how to
 * invoke it (a parameterized source is invoked with `()` so its `is null`
 * defaults apply). Returns findings (possibly empty). Never throws — a probe that
 * cannot run is silently skipped (conservative).
 */
export async function verifySource(
  rt: MalloyRuntime,
  src: ParsedSource,
  byName: Map<string, ParsedSource>,
  opts: VerifyOptions = {},
): Promise<SemanticFinding[]> {
  const tol = opts.tolerance ?? 0.01;
  const timeoutMs = opts.timeoutMs ?? 45_000;
  const maxDim = opts.maxDimCardinality ?? 60;
  const findings: SemanticFinding[] = [];
  const runName = src.parameterized ? `${src.name}()` : src.name;

  // ---- Check #1: fan-out / grain-invariance audit (highest value) ----------
  if (declaresFanOut(src.body)) {
    const baseKey = resolveBaseKey(src.name, byName);
    const candidates = fanoutSumCandidates(src.body);
    if (baseKey && candidates.length) {
      // Confirm the source REALLY fans out (join grain rows > base rows) before
      // judging any measure — otherwise there is nothing to inflate.
      const baseRows = await scalar(rt, `run: ${runName} -> { aggregate: n is count() }`, 'n', timeoutMs);
      for (const c of candidates) {
        // join-locality total (as authored) vs base-locality total of the SAME column.
        const joined = await scalar(rt, `run: ${runName} -> { aggregate: x is ${c.joinPath}.sum(${c.inner}) }`, 'x', timeoutMs);
        const baseLoc = await scalar(rt, `run: ${runName} -> { aggregate: x is ${c.inner}.sum() }`, 'x', timeoutMs);
        if (!Number.isFinite(joined) || !Number.isFinite(baseLoc) || baseLoc === 0) continue; // can't judge
        const ratio = joined / baseLoc;
        // Clean inflation: the join-locality sum materially EXCEEDS the base-locality
        // sum of the same column — the column was multiplied by the per-base fan-out.
        // A correct join-grain sum agrees at both localities (ratio ≈ 1).
        if (ratio > 1 + Math.max(tol, 0.02)) {
          const nearInt = Math.abs(ratio - Math.round(ratio)) < 0.02 && Math.round(ratio) >= 2;
          findings.push({
            code: 'fanout_grain_noninvariance',
            source: src.name,
            measure: c.name,
            message:
              `measure \`${c.name}\` on \`${src.name}\` appears to DOUBLE-COUNT over a fan-out (grain non-invariance): ` +
              `\`${c.joinPath}.sum(${c.inner})\` = ${joined.toPrecision(8)} but the base-grain total of \`${c.inner}\` is ${baseLoc.toPrecision(8)} ` +
              `(${nearInt ? `a clean ${Math.round(ratio)}× inflation` : `${((ratio - 1) * 100).toFixed(1)}% inflation`}). ` +
              `\`${c.inner}\` is a BASE-grain column; summing it at the \`${c.joinPath}\` join locality multiplies it by the match count. ` +
              `FIX: compute \`${c.name}\` at base grain BEFORE the fan-out (\`${c.inner}.sum()\`), or expose it only on a view that first collapses back to one row per \`${baseKey}\`.`,
          });
        }
      }
      void baseRows; // (kept for potential future ratio-vs-fanout corroboration)
    }
  }

  // ---- Check #2: additivity self-consistency -------------------------------
  // For an additive measure M and a low-cardinality dimension D: total(M) must
  // equal SUM over group_by(D) of M. A mismatch beyond tolerance is a grain /
  // additivity defect (the measure is not partition-stable). This is a pure
  // mathematical identity for a correct additive measure, so it NEVER fires on
  // one — the safest possible check.
  {
    const dims = declaredDimensions(src.body);
    // Additive candidates for #2: the SAME fan-out candidates plus base-locality
    // `col.sum()`-style measures declared here. We reuse the fan-out candidates
    // (already conservative) so the additivity probe has a concrete measure/dim.
    const additive = fanoutSumCandidates(src.body);
    if (dims.length && additive.length) {
      // pick the FIRST dimension that is low-cardinality enough to be safe.
      let chosenDim: string | null = null;
      for (const d of dims) {
        const card = await scalar(rt, `run: ${runName} -> { aggregate: n is count(${d}) } -> { aggregate: n2 is count() }`, 'n2', timeoutMs);
        // count of groups: run a group_by and count rows
        const groups = await scalar(rt, `run: ${runName} -> { group_by: ${d} } -> { aggregate: g is count() }`, 'g', timeoutMs);
        void card;
        if (Number.isFinite(groups) && groups >= 2 && groups <= maxDim) { chosenDim = d; break; }
      }
      if (chosenDim) {
        for (const c of additive) {
          const direct = await scalar(rt, `run: ${runName} -> { aggregate: x is ${c.joinPath}.sum(${c.inner}) }`, 'x', timeoutMs);
          const partsRun = await rt.run(`run: ${runName} -> { group_by: ${chosenDim}; aggregate: x is ${c.joinPath}.sum(${c.inner}) }`, 100000, timeoutMs);
          if (!Number.isFinite(direct) || !partsRun.ok || !partsRun.rows) continue;
          const parts = (partsRun.rows as Array<Record<string, unknown>>).reduce((a, r) => a + num(r.x), 0);
          if (!Number.isFinite(parts) || direct === 0) continue;
          if (Math.abs(direct - parts) / Math.abs(direct) > Math.max(tol, 0.005)) {
            findings.push({
              code: 'additivity_mismatch',
              source: src.name,
              measure: c.name,
              message:
                `measure \`${c.name}\` on \`${src.name}\` is NOT additive over \`${chosenDim}\`: ` +
                `total = ${direct.toPrecision(8)} but SUM over group_by(${chosenDim}) = ${parts.toPrecision(8)} ` +
                `(${(Math.abs(direct - parts) / Math.abs(direct) * 100).toFixed(1)}% apart). ` +
                `A sum-type measure must satisfy total(M) = Σ over any partition; a mismatch means the grouping changes the population it aggregates (a grain defect).`,
            });
          }
        }
      }
    }
  }

  // ---- Check #3: parameter fidelity (a declared filter param MUST move the result) -
  // For a parameterized source, a param wired into a narrowing predicate (`col = p`,
  // `list_contains(col, p)`) must actually change the measures it is supposed to
  // scope. We bind the param to two DISTINCT data-drawn values of its compared column
  // and compare each own measure; if the measure is invariant to a param that the
  // COLUMN itself discriminates, the param is declared-but-not-wired into that measure
  // (a caller who scopes by it silently gets the unfiltered aggregate). The
  // "column discriminates the measure" guard makes coincidental equality impossible to
  // flag — the safest possible trigger.
  if (src.parameterized) {
    const filterParams = parseFilterParams(src.body);
    const measures = declaredMeasureNames(src.body);
    for (const p of filterParams) {
      // An OVERRIDE / counterfactual param (`alt_`/`override_`/`new_`/`scenario_`/
      // `proposed_`/`cf_`) is NOT a scoping filter: it re-prices under a changed
      // field, so baseline and neutral measures are SUPPOSED to be invariant to it.
      // Demanding movement here would wrongly push the author to wire the override
      // into baseline measures. Those params are owned by the identity check (#3b).
      if (OVERRIDE_PARAM_NAME.test(p.name)) continue;
      const col = p.compareColumn!;
      // two distinct non-null values of the compared column, drawn from the data
      const vr = await rt.run(`run: ${runName} -> { group_by: ${col}; order_by: ${col}; limit: 3 }`, 3, timeoutMs);
      const vals = (vr.ok && vr.rows ? (vr.rows as Array<Record<string, unknown>>) : [])
        .map((r) => r[col])
        .filter((v) => v !== null && v !== undefined);
      const distinct = [...new Map(vals.map((v) => [String(v), v])).values()].slice(0, 2);
      if (distinct.length < 2) continue; // cannot compare
      for (const meas of measures) {
        // does the column even DISCRIMINATE this measure? (else equality isn't a defect)
        const g = await rt.run(`run: ${runName} -> { group_by: ${col}; aggregate: v is ${meas} }`, 500, timeoutMs);
        if (!g.ok || !g.rows) continue;
        const gv = (g.rows as Array<Record<string, unknown>>).map((r) => num(r.v)).filter(Number.isFinite);
        if (gv.length < 2) continue;
        const hi = Math.max(...gv);
        const lo = Math.min(...gv);
        const spread = (hi - lo) / (Math.max(Math.abs(hi), Math.abs(lo)) || 1);
        if (spread <= Math.max(tol, 0.02)) continue; // measure is genuinely column-independent → not a defect
        const a = await scalar(rt, `run: ${src.name}(${p.name} is ${lit(distinct[0])}) -> { aggregate: v is ${meas} }`, 'v', timeoutMs);
        const b = await scalar(rt, `run: ${src.name}(${p.name} is ${lit(distinct[1])}) -> { aggregate: v is ${meas} }`, 'v', timeoutMs);
        if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
        if (Math.abs(a - b) / (Math.abs(a) || 1e-9) <= tol) {
          findings.push({
            code: 'parameter_inert',
            source: src.name,
            measure: meas,
            message:
              `parameter \`${p.name}\` does NOT change measure \`${meas}\` on \`${src.name}\`: ` +
              `binding it to two distinct \`${col}\` values (${lit(distinct[0])} vs ${lit(distinct[1])}) both give ${a.toPrecision(8)}, ` +
              `yet \`${meas}\` VARIES by \`${col}\` in the data. The parameter is declared in the signature but not wired into this ` +
              `measure's aggregation — a caller scoping by \`${p.name}\` silently gets the UNFILTERED aggregate. ` +
              `FIX: apply \`${p.name}\` in a where:/on:/pick the measure is computed AFTER (not only in the signature).`,
          });
        }
      }
    }
  }

  // ---- Check #3b: identity counterfactual (a NO-OP override ⇒ zero delta) -----------
  // A scenario/override param named `alt_<col>` / `override_<col>` / `new_<col>` /
  // `scenario_<col>` re-prices facts under a changed field. Setting it to a value that
  // some facts ALREADY have, then scoping to exactly those facts, must yield a ~0 delta
  // (nothing changed for them). A non-zero identity delta means the re-match selects a
  // different rule population than baseline — the counterfactual drifts.
  if (src.parameterized) {
    const sigEnd = skipParens(src.body, 0);
    const sig = src.body.indexOf('(') >= 0 ? src.body.slice(src.body.indexOf('(') + 1, sigEnd - 1) : '';
    const sigNames = new Set([...sig.matchAll(/([A-Za-z_]\w*)\s*::/g)].map((m) => m[1]));
    const deltaMeas = declaredMeasureNames(src.body).find((n) => /(delta|change|impact|diff|savings)/i.test(n));
    if (deltaMeas) {
      const seen = new Set<string>();
      for (const m of src.body.matchAll(/\b((?:alt|override|new|scenario|proposed|cf)_[A-Za-z_]\w*)\b/g)) {
        const param = m[1];
        if (!sigNames.has(param) || seen.has(param)) continue;
        seen.add(param);
        const col = param.replace(OVERRIDE_PARAM_NAME, '');
        const vr = await rt.run(`run: ${runName} -> { group_by: ${col}; limit: 1 }`, 1, timeoutMs);
        const v = vr.ok && vr.rows?.[0] ? (vr.rows[0] as Record<string, unknown>)[col] : null;
        if (v === null || v === undefined) continue;
        const d = await scalar(
          rt,
          `run: ${src.name}(${param} is ${lit(v)}) -> { where: ${col} = ${lit(v)}; aggregate: x is ${deltaMeas} }`,
          'x',
          timeoutMs,
        );
        if (Number.isFinite(d) && Math.abs(d) > Math.max(tol, 0.01)) {
          findings.push({
            code: 'identity_delta_nonzero',
            source: src.name,
            measure: deltaMeas,
            message:
              `measure \`${deltaMeas}\` on \`${src.name}\` is non-zero (${d.toPrecision(6)}) for a NO-OP override: ` +
              `setting \`${param}\` to a value equal to a fact's own \`${col}\` should change NOTHING for those facts. ` +
              `A non-zero identity delta means the scenario re-match selects a DIFFERENT rule population than baseline. ` +
              `FIX: the counterfactual must change only the overridden field's matching; every other criterion ` +
              `(including wildcard/default rows) must resolve identically on the baseline and scenario legs.`,
          });
        }
      }
    }
  }

  // ---- Check #4: cross-join co-aggregation stability -------------------------
  // A measure that COMBINES two aggregates anchored on DIFFERENT `join_many`
  // relations (a difference/ratio like `delta is scenario_total - baseline_total`)
  // forces both symmetric aggregates into ONE query stage. Malloy's per-join
  // symmetric aggregates do NOT compose across two live fan-outs: the SQL fans out
  // over relationA × relationB and BOTH sums deflate. Each component is correct
  // ALONE but wrong when co-aggregated — a silently-wrong number. We detect it by
  // comparing a component computed ALONE vs. in the SAME stage as the other
  // component; a material drift proves the composition is corrupt. (This fires even
  // at null params, where the delta itself may be 0 — the COMPONENTS still drift.)
  {
    const anchored = joinAnchoredAggMeasures(src.body);
    if (anchored.size >= 2) {
      const combos = combiningMeasures(src.body, new Set(anchored.keys()));
      let flagged = false;
      for (const combo of combos) {
        if (flagged) break;
        // two referenced components on DIFFERENT join paths
        const seenPath = new Map<string, string>(); // path -> measure name
        for (const r of combo.refs) {
          const p = anchored.get(r)!;
          if (!seenPath.has(p)) seenPath.set(p, r);
        }
        if (seenPath.size < 2) continue;
        const [a, b] = [...seenPath.values()].slice(0, 2);
        const aAlone = await scalar(rt, `run: ${runName} -> { aggregate: ${a} }`, a, timeoutMs);
        const bAlone = await scalar(rt, `run: ${runName} -> { aggregate: ${b} }`, b, timeoutMs);
        if (!Number.isFinite(aAlone) || !Number.isFinite(bAlone)) continue;
        const tog = await rt.run(`run: ${runName} -> { aggregate: ${a}, ${b} }`, 5, timeoutMs);
        if (!tog.ok || !tog.rows?.length) continue;
        const row = tog.rows[0] as Record<string, unknown>;
        const aTog = num(row[a]);
        const bTog = num(row[b]);
        const driftA = aAlone !== 0 && Number.isFinite(aTog) ? Math.abs(aAlone - aTog) / Math.abs(aAlone) : 0;
        const driftB = bAlone !== 0 && Number.isFinite(bTog) ? Math.abs(bAlone - bTog) / Math.abs(bAlone) : 0;
        if (driftA > Math.max(tol, 0.02) || driftB > Math.max(tol, 0.02)) {
          const pa = anchored.get(a)!;
          const pb = anchored.get(b)!;
          findings.push({
            code: 'crossjoin_coaggregation',
            source: src.name,
            measure: combo.name,
            message:
              `measure \`${combo.name}\` on \`${src.name}\` combines \`${a}\` (aggregated over join \`${pa}\`) and ` +
              `\`${b}\` (over join \`${pb}\`) — two DIFFERENT \`join_many\` relations. Co-aggregating them in one stage ` +
              `CORRUPTS both: \`${a}\` = ${aAlone.toPrecision(8)} alone but ${aTog.toPrecision(8)} when computed together with \`${b}\` ` +
              `(${(Math.max(driftA, driftB) * 100).toFixed(1)}% drift). Malloy's per-join symmetric aggregates do not compose across ` +
              `two live fan-outs (the query fans out over \`${pa}\`×\`${pb}\`). FIX: pre-collapse each leg to base grain in its OWN ` +
              `single-\`join_many\` source (\`-> { group_by: <key>; aggregate: ... }\`), then bring each back via \`join_one\` before combining, ` +
              `so no two \`join_many\` are live in the same aggregate.`,
          });
          flagged = true;
        }
      }
    }
  }

  return findings;
}

/** Quote a data value for a Malloy param binding: numbers bare, everything else a
 *  single-quoted string with quotes doubled. Pure. */
function lit(v: unknown): string {
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  if (typeof v === 'boolean') return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
}

/**
 * Verify every source a just-authored FILE introduces (its own `source:`
 * declarations), against the compiled model. Returns findings across all of
 * them. `byNameExtra` lets the caller supply sources from OTHER already-authored
 * files so the base-key chain can be resolved across files. Never throws.
 */
export async function semanticSelfVerify(opts: {
  rt: MalloyRuntime;
  fileText: string;
  /** parsed sources from every model file (for cross-file base-key resolution). */
  allSources?: ParsedSource[];
  verify?: VerifyOptions;
}): Promise<SemanticFinding[]> {
  const own = parseSources(opts.fileText);
  const all = opts.allSources && opts.allSources.length ? opts.allSources : own;
  const byName = new Map<string, ParsedSource>();
  for (const s of all) byName.set(s.name, s);
  for (const s of own) byName.set(s.name, s); // own wins on name clash
  const findings: SemanticFinding[] = [];
  for (const s of own) {
    try {
      findings.push(...(await verifySource(opts.rt, s, byName, opts.verify)));
    } catch {
      /* a probe that throws is skipped — conservative */
    }
  }
  return findings;
}

/** One diagnostic string for the build nudge (mirrors smellSummary / gateDiag). Pure. */
export function semanticFindingSummary(findings: SemanticFinding[]): string {
  if (!findings.length) return '';
  return `Semantic self-verification findings (the layer COMPILES + EXECUTES but a measure returns WRONG numbers — fix them):\n` +
    findings.map((f) => `  - ${f.message}`).join('\n');
}
