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
  code:
    | 'extra_columns'
    | 'list_extra_columns'
    | 'percentage_ratio'
    | 'limit_drops_ties'
    | 'null_in_list'
    | 'boolean_expected_numeric'
    | 'letter_expected_numeric'
    | 'hardcoded_threshold_literal'
    | 'undeduped_list';
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
// A yes/no (or true/false) boolean-answer guideline — "answer yes or no", "yes/no".
const BOOLEAN_RE = /\b(yes\s*(\/|or)\s*no|no\s*(\/|or)\s*yes|true\s*(\/|or)\s*false)\b/i;
// A single-letter / single-code answer guideline ("just a letter", "the letter",
// "one letter"). The determiner set (just/single/only/exactly/a/the/one) keeps it to
// answer-format phrasing rather than any incidental mention of the word "letter".
const LETTER_RE = /\b(just|single|only|exactly|a|the|one)\s+(?:the\s+|one\s+|a\s+|capital\s+|single\s+)?letter\b/i;
// A hard-copied DECIMAL literal in a where:/having: comparison — a pasted extremum
// threshold. Requires a decimal point so it never fires on `= 1` ids/flags.
const HARDCODED_THRESHOLD_RE = /\b(where|having)\b[^\n]*?[=<>]=?\s*-?\d+\.\d+/i;

/** Is `v` a real number strictly inside (0,1) (a likely 0–1 ratio for a percentage)? */
function isNumericIn01(v: unknown): boolean {
  if (v === null || v === undefined || typeof v === 'boolean') return false;
  if (String(v).trim() === '') return false;
  const n = typeof v === 'bigint' ? Number(v) : Number(v);
  return Number.isFinite(n) && Math.abs(n) > 0 && Math.abs(n) < 1;
}

/** Is `v` a plain numeric scalar (not a boolean, not empty)? Used to catch a number
 *  returned where the guideline asks for a boolean / a letter. */
function isNumericCell(v: unknown): boolean {
  if (v === null || v === undefined || typeof v === 'boolean') return false;
  const s = String(v).trim();
  return s !== '' && Number.isFinite(Number(s));
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

  // A single scalar cell, if that is the answer shape (used by checks 5 & 6).
  const scalarCell = rows.length === 1 && (rows[0]?.length ?? 0) === 1 ? rows[0][0] : undefined;

  // 5. the guideline asks for yes/no (a boolean) but a NUMBER was returned — the agent
  //    computed the statistic and forgot to compare it to the threshold + emit the verdict.
  if (BOOLEAN_RE.test(text) && isNumericCell(scalarCell)) {
    out.push({ code: 'boolean_expected_numeric', message: `The guideline asks for a yes/no answer but the result is the number ${String(scalarCell)} — compare your computed value to the threshold stated in the question and emit the boolean (e.g. \`pick 'yes' when <value> > <threshold> else 'no'\`).` });
  }

  // 6. the guideline asks for a single letter/code but a NUMBER was returned — you likely
  //    projected the measure you ranked by instead of its key.
  if (LETTER_RE.test(text) && isNumericCell(scalarCell)) {
    out.push({ code: 'letter_expected_numeric', message: `The guideline asks for a letter/code but the result is the number ${String(scalarCell)} — you likely projected the measure you ranked by; select its KEY (the letter/code), not the value.` });
  }

  // 7. a "list all / ties" question whose source hard-copies a decimal threshold into a
  //    where:/having: comparison — a pasted literal is fragile to rounding/float drift and
  //    silently drops rows exactly at the extremum.
  if (LIST_ALL_RE.test(text) && HARDCODED_THRESHOLD_RE.test(source)) {
    out.push({ code: 'hardcoded_threshold_literal', message: `The query filters on a hard-copied decimal threshold (\`where/having … = <literal>\`) for a "list all / ties" answer — a pasted number is fragile to rounding/float drift and silently drops rows exactly at the extremum. Compute the extremum in one stage and keep every row equal to it in the next (\`-> { aggregate: m } -> { having: m = max(m) }\`), never compare to a copied number.` });
  }

  // 8. a list answer that REPEATS a value in its key column — a projection over
  //    unaggregated rows duplicates the asked value; needs a group_by / DISTINCT on the key.
  if (listy && rows.length > 1) {
    const keys = rows.map((r) => (r?.length ? String(r[0]) : '')).filter((s) => s !== '');
    const dupes = keys.length - new Set(keys).size;
    if (dupes > 0) {
      out.push({ code: 'undeduped_list', message: `The list answer repeats ${dupes} value(s) — a projection over unaggregated rows duplicates; add \`group_by\`/DISTINCT on the single asked key so each value appears once.` });
    }
  }

  return out;
}
