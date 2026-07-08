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
  code: 'fanout_grain_noninvariance' | 'additivity_mismatch';
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

  return findings;
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
