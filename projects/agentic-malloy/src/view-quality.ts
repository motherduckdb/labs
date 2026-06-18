/**
 * view-quality — closed-book "does this view MEAN what its name claims?" smells.
 *
 * The build's P0 gate proves a view EXECUTES; it does not prove the view is
 * meaningful. A view named like a ranking that returns the same value for ~every
 * group (e.g. a per-MCC fee that folds in wildcard/"applies-to-all" rows, so
 * 727/769 MCCs tie at the max) compiles, runs, and is WRONG — a "ranking that
 * does not rank." These heuristics catch that class from a view's OWN output, with
 * NO gold answer and NO dataset knowledge — so they work for any dataset and are
 * shared by `layer-build` (gate authored views) and `layer-improve` (triage which
 * misses are really a wrong-grain LAYER defect vs. an answering-agent slip).
 *
 * Smells are ADVISORY: a flag means "this view probably doesn't compute what its
 * name implies — look again," not a certainty. Callers nudge once / corroborate
 * with other evidence rather than hard-failing on a single smell.
 */
export interface Smell {
  code: 'all_null' | 'all_zero' | 'zero_variance' | 'extreme_tie';
  column: string;
  message: string;
}

function toNum(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'bigint') return Number(v);
  return null;
}

/**
 * Inspect a view's executed rows for degeneracy smells. Pure.
 *
 *  - all_null      : a column is entirely NULL (computes nothing).
 *  - all_zero      : a numeric column is 0 for every row (a measure that never fires).
 *  - zero_variance : a numeric column is identical across all rows (does not
 *                    discriminate between groups — usually the wrong grain).
 *  - extreme_tie   : > `tieFraction` of rows share the MAX (or MIN) of a numeric
 *                    column — a "ranking that does not rank" (the wildcard-grain bug).
 *
 * `minRows` guards against judging tiny groupings (a 5-row scheme ranking is not
 * degenerate just because schemes are few). Only numeric columns are judged for
 * zero/variance/tie; any column is judged for all-null.
 */
export function viewQualitySmells(
  rows: Array<Record<string, unknown>>,
  opts: { minRows?: number; tieFraction?: number } = {},
): Smell[] {
  const minRows = opts.minRows ?? 8;
  const tieFraction = opts.tieFraction ?? 0.5;
  const smells: Smell[] = [];
  if (rows.length < minRows) return smells; // too few rows to judge meaningfully
  const cols = Object.keys(rows[0] ?? {});
  for (const c of cols) {
    const raw = rows.map((r) => r[c]);
    const nonNull = raw.filter((v) => v !== null && v !== undefined);
    if (nonNull.length === 0) {
      smells.push({ code: 'all_null', column: c, message: `column "${c}" is NULL for all ${rows.length} rows — computes nothing` });
      continue;
    }
    const nums = nonNull.map(toNum);
    const isNumeric = nums.every((n) => n !== null) && nums.length === nonNull.length;
    if (!isNumeric) continue; // only numeric columns get the zero/variance/tie checks
    const ns = nums as number[];
    if (ns.every((n) => n === 0)) {
      smells.push({ code: 'all_zero', column: c, message: `measure "${c}" is 0 for every row — it never fires (suspect a broken match/filter)` });
      continue;
    }
    // The variance/tie smells target MEASURES (a ranking that doesn't rank). A
    // group-by KEY / numeric DIMENSION (mcc code, year, month, an id) is integer
    // and legitimately repeats or is constant — judging it over-triggers. Without
    // field-kind metadata, use a robust proxy: only continuous (non-integer)
    // columns get these checks. Aggregates that matter here (avg/sum/rate/fee) are
    // floats; all-zero (a never-firing integer count) is still caught above.
    const isContinuous = ns.some((n) => !Number.isInteger(n));
    if (!isContinuous) continue;
    const distinct = new Set(ns);
    if (distinct.size === 1) {
      smells.push({ code: 'zero_variance', column: c, message: `"${c}" is identical (${ns[0]}) across all ${ns.length} rows — it does not discriminate between groups (suspect wrong grain)` });
      continue;
    }
    const max = Math.max(...ns);
    const min = Math.min(...ns);
    const atMax = ns.filter((n) => n === max).length;
    const atMin = ns.filter((n) => n === min).length;
    if (atMax / ns.length > tieFraction) {
      smells.push({ code: 'extreme_tie', column: c, message: `${atMax}/${ns.length} rows tie at the MAX of "${c}" (${max}) — a ranking that does not rank (suspect the grain folds in non-discriminating / wildcard rows)` });
    } else if (atMin / ns.length > tieFraction) {
      smells.push({ code: 'extreme_tie', column: c, message: `${atMin}/${ns.length} rows tie at the MIN of "${c}" (${min}) — a ranking that does not rank (suspect wrong grain)` });
    }
  }
  return smells;
}

/** One-line summary of the worst smells, for a diagnostic/send-back message. */
export function smellSummary(viewLabel: string, smells: Smell[]): string {
  if (!smells.length) return '';
  return `View \`${viewLabel}\` looks DEGENERATE (it executes but probably doesn't compute what its name implies):\n` +
    smells.map((s) => `  - ${s.message}`).join('\n');
}
