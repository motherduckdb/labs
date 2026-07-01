/**
 * answer-shape — deterministic, GENERAL pre-submit warnings on a candidate answer.
 * This is the easy-convention discipline the baseline's SKILL encodes, enforced
 * substrate-independently and — crucially — on BOTH submit paths (the raw-SQL path
 * otherwise bypasses all format discipline, which drove the new-harness easy
 * regressions).
 *
 * ADVISORY only: the caller surfaces these as a ONE-SHOT warning so the agent can
 * reconsider/resubmit; it never hard-blocks a submission (a resubmit always records).
 *
 * Every check is triggered by GUIDELINE/QUESTION WORDING + the value SHAPE — never a
 * dataset fact, never the gold answer. With no question/guidelines context the checks
 * are no-ops, so an exploratory or context-free submit is never spuriously warned.
 */

export interface ShapeWarning {
  code: 'extra_columns' | 'list_extra_columns' | 'percentage_ratio' | 'limit_drops_ties' | 'null_in_list';
  message: string;
}

// Single-value intent ("which X?", "what is the …", "how many/much", "name the", and
// the MODAL form "what <thing> would/does/will … (pay|be|cost)?" — e.g. "what delta
// would Crossfit_Hanna pay") vs. a multi-value / per-group hint ("for each", "by …",
// "per …", "list/breakdown"). The modal form previously slipped through, so a scalar
// answer built by refining a grouping view leaked its key/measure columns UN-warned.
const SINGLE_VALUE_RE = /\bwhich\b|\bwhat (is|was|are|were) the\b|\bwhat\b[^\n]{0,40}?\b(would|will|does|did|should|could)\b|\bhow (many|much)\b|\bname the\b/i;
const MULTI_HINT_RE = /\bfor each\b|\bby each\b|\bper\b|\bbreakdown\b|\bgroup(ed)? by\b|\beach\b/i;
// A "[key: value, …]" list guideline (e.g. "[grouping_i: amount_i, ]") wants exactly TWO
// columns per row — the group key, then the one asked measure. >2 columns means a wide
// grouping view's extra count/sum measures are leaking into each list element.
const KV_LIST_RE = /\[[^\]\n]*:[^\]\n]*\]/;
const PERCENT_RE = /percentage|percent\b|\bpct\b|%/i;
const LIST_ALL_RE = /\blist all\b|\bif there are ties\b|\ball\b[\s\S]{0,40}?\b(that|which)\b|comma[- ]separated|\blist (the|all|every)\b/i;
// `limit: 1` (Malloy, with colon), `limit 1`/`LIMIT 1` (SQL), `rank()=1`, `top 1`.
// The `1\b` boundary avoids false-matching `limit 10` / `limit: 100`.
const LIMIT1_RE = /\blimit\s*:?\s*1\b|\brank\s*\(\s*\)\s*=\s*1\b|\brow_number\s*\(\s*\)\s*=\s*1\b|\btop\s+1\b/i;

/** Is `v` a real number strictly inside (0,1) (a likely 0–1 ratio for a percentage)? */
function isNumericIn01(v: unknown): boolean {
  if (v === null || v === undefined || typeof v === 'boolean') return false;
  if (String(v).trim() === '') return false;
  const n = typeof v === 'bigint' ? Number(v) : Number(v);
  return Number.isFinite(n) && Math.abs(n) > 0 && Math.abs(n) < 1;
}

export function answerShapeWarnings(opts: {
  question?: string | null;
  guidelines?: string | null;
  source?: string | null;
  /** result column names (Malloy answers); omit for raw-SQL (count inferred from rows). */
  columns?: string[];
  /** positional result rows (BigInt-safe cells fine). */
  rows?: unknown[][];
}): ShapeWarning[] {
  const text = `${opts.question ?? ''}\n${opts.guidelines ?? ''}`;
  if (text.trim() === '') return []; // no wording to trigger on → never warn
  const cols = opts.columns ?? [];
  const rows = opts.rows ?? [];
  const source = opts.source ?? '';
  const out: ShapeWarning[] = [];

  // 1. >1 output column when the wording asks for a single value (the key+measure
  //    dump: "Ecommerce,49642" for "Ecommerce"). Column count works for both the
  //    Malloy path (named cols) and the SQL path (inferred from the first row).
  const ncols = cols.length || (rows[0]?.length ?? 0);
  if (ncols > 1 && SINGLE_VALUE_RE.test(text) && !MULTI_HINT_RE.test(text)) {
    const colNote = cols.length ? ` (${cols.join(', ')})` : '';
    out.push({ code: 'extra_columns', message: `The result has ${ncols} columns${colNote} but the question asks for a single value — return ONLY the asked value (drop the key/measure you grouped or sorted by).` });
  }

  // 1b. a "[key: value]" list guideline but >2 columns per row — a grouping view's extra
  //     measures (count, sum) leaking into each list element. Distinct from check 1,
  //     which deliberately skips the per-group ("grouped by"/"for each") answers this hits.
  if (KV_LIST_RE.test(text) && ncols > 2) {
    const colNote = cols.length ? ` (${cols.join(', ')})` : '';
    out.push({ code: 'list_extra_columns', message: `The guideline wants a [key: value] list — exactly TWO columns (the group key, then the asked measure) — but the result has ${ncols} columns${colNote}. Return only those two: group by the key and aggregate only that measure (drop the count/sum you grouped by).` });
  }

  // 2. a single numeric scalar in (0,1) when the answer is a "percentage" (the ×100
  //    slip: 0.114862 for 11.486208).
  if (PERCENT_RE.test(text) && rows.length === 1 && (rows[0]?.length ?? 0) === 1 && isNumericIn01(rows[0][0])) {
    out.push({ code: 'percentage_ratio', message: `The answer ${String(rows[0][0])} is a ratio in (0,1) but the question asks for a percentage — percentages are 0–100; multiply by 100 (then apply the stated rounding)?` });
  }

  // 3. limit 1 / rank()=1 / top 1 in the source on a "list all" / ties question —
  //    keeps one arbitrary row and silently drops the ties.
  if (LIMIT1_RE.test(source) && LIST_ALL_RE.test(text)) {
    out.push({ code: 'limit_drops_ties', message: `The query uses limit 1 / rank()=1, but the question asks to list all / handle ties — that keeps ONE arbitrary row and drops the ties; compute the extremum, then return every row at it.` });
  }

  // 4. a NULL/empty cell in a multi-row or explicitly-list answer — usually a phantom
  //    unmatched-join row leaking into the list.
  const listy = rows.length > 1 || LIST_ALL_RE.test(text);
  if (listy && rows.some((r) => r.some((c) => c === null || c === undefined))) {
    out.push({ code: 'null_in_list', message: `The list answer contains a NULL/empty cell — usually a phantom unmatched-join row; filter it out (\`… is not null\`) so it doesn't appear as a stray list value.` });
  }

  return out;
}
