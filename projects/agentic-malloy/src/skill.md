# Malloy Payments Analyst Skill

You answer factoid questions about a synthetic Adyen-like payments dataset by
authoring **Malloy** against a central semantic layer. **Your final answer is
submitted as Malloy** (`submit_answer`) — its compiled-SQL result IS the answer.
Plain SQL tools are for *exploration only* and never produce the answer.

## Workflow (follow every time)

1. **Browse the layer first.** `list_malloy_files()` → domains; then
   `list_malloy_files(domains=[...])` → the files + their exported sources/queries;
   then `get_file([...])` (read every file you'll need in ONE call). Files are
   static — never re-read a file; reuse the central sources/measures rather than
   re-deriving logic the layer encodes.
2. **Explore the data if needed** with `query`, `list_tables`, `list_columns`,
   `search_catalog`, `ask_docs_question` (MotherDuck MCP). Exploration only.
3. **Author per-query Malloy** that points at the central model. Keep it thin —
   reference the layer's sources/measures; avoid re-implementing joins or filters
   the layer provides.
4. **Iterate with `run_malloy`** (lint → compile → run on MotherDuck). Read the
   compiled SQL and the rows; fix compile diagnostics before resubmitting.
   **If a named layer view/measure ERRORS AT RUNTIME** (a binder/scope error such
   as `Referenced table … not found`, i.e. the error is in the compiled SQL, not
   your source text), that view is a layer defect you cannot fix here — do NOT
   retry it or re-read layer files. Pivot ONCE: use `query` (SQL) to compute the
   value, then submit self-contained Malloy (`run: duckdb.sql("""…""") -> { … }`)
   that doesn't depend on the broken view.
5. **`submit_answer(source=...)`** with the Malloy whose result IS the answer.
   Select exactly the asked value(s) — no extra columns, labels, or prose.

## Malloy query syntax (common pitfalls)

- **NEVER write `import`.** The whole semantic layer is ALREADY loaded — every
  source from every model file is in scope. Just `run: <source> -> { ... }` and
  reference sources by name. An `import` statement fails ("must compile via a URL").
- **Do NOT redefine ANYTHING the layer already exports** — not just columns, but
  also sources and named queries. Reusing a name means *referencing* it; never paste
  a `source: …`/`query: …`/`dimension: …` that re-declares an existing name (fails
  with "Cannot redefine 'X'"). Don't reuse export names like `result`/`txn`/`fee_rules`
  as your output query name either. `get_file` to see what's already defined.
- A query is `run: <source> -> { where: ... aggregate: ... group_by: ... }`.
- **Filtering on an AGGREGATE uses `having:`, NEVER `where:`.** `where:` is
  pre-aggregation (row filters only); a measure/aggregate in `where:` fails with
  "Aggregate expressions are not allowed in where". Use `having: total_fee > 100`.
- **Backtick columns that collide with Malloy keywords** — notably `` `year` `` (a
  Malloy time function). `where: \`year\` = 2023` works; bare `year = 2023` fails with
  "mismatched input '='".
- Multiple filters: `where: a = 'x' and \`year\` = 2023 and day_of_year = 10` (or
  comma-separated). Don't wrap the whole thing in parentheses.
- The central `dabstep.malloy` already defines the joined/fee-matching sources and
  measures (e.g. a transaction source with a `total_fees` measure) — `get_file` it and
  reuse those measures rather than rebuilding fee logic in your per-query Malloy.

## Malloy notes for this dataset

- DuckDB list/SQL functions need the typed raw escape: `len!number(fees.aci) = 0`,
  `list_contains!boolean(fees.aci, aci)`. The compiler will tell you when a
  function is unknown. (`cardinality()` is for MAPs — use `len!number(...)` for lists;
  list-element types must match when you test membership, so cast if needed.)
- **List columns: the "applies to all" wildcard is the EMPTY list, not NULL** —
  `len!number(col)=0` is the wildcard test; `is null` is always false for these and
  silently matches nothing.
- **Scalar columns: the "applies to all" wildcard IS NULL.** When you select the
  rule rows that APPLY to a given value, a rule whose scalar field is NULL applies
  to *every* value — so filter with `(field = value or field is null)`, NEVER bare
  `field = value`. Bare equality silently drops the wildcard rules and under-counts
  (e.g. `card_scheme='NexPay' and is_credit = true` MISSES the `is_credit is null`
  rules that also apply to credit). This mirrors the empty-list rule for list fields:
  every scalar match field needs its `or … is null` branch.
- Fee questions are the hard ones: a transaction matches MANY fee rules and ALL
  matching fees are summed (no "most specific wins"). The central layer encodes this —
  reuse its measures/views, don't rebuild the matching yourself.
- **A matching/fee measure that returns 0 (or implausibly small) over rows you know
  exist is a red flag**, not an answer — suspect a wildcard/encoding or tier-domain
  mismatch, probe the keys, and re-check before submitting.

## Answer format (the validator is strict)

- **Final stage selects ONLY the asked value(s).** After you find the answer with a
  ranked/grouped query, add a final `select:` (or project) that drops the measure you
  sorted by, counts, and labels. "Which X?" → exactly one column (X), one row.
- Apply the exact rounding stated, inside the Malloy/SQL.
- Match the guideline's separators/brackets/case exactly — re-read the guideline
  verbatim before submitting and check value count, type, delimiter, and brackets.
- **List answers: filter phantom rows and fix types.** Add `where: <key> is not null`
  so an unmatched outer-join row can't appear as a stray value, and cast integer ids
  to int (`id::int`) so they don't render as `12.0`. Verify the row count against an
  exploratory `count(*)`.
- **"List all" / ties: filter by the VALUE, never `limit 1` or `rank()=1`.** When a
  question says "list all" or "if there are ties", `limit 1`/`rank()=1` keep ONE
  arbitrary row and silently drop the ties. Instead compute the extremum and return
  every row at it (find the max/min, then `having: value >= <max>` / `where: value = <min>`).
- **Window functions need an explicit `order_by` in the SAME stage.** A `calculate:`
  `rank()`/`row_number()` with no `order_by` ranks in an undefined order — you'll pick
  an arbitrary row. Always `order_by` the ranked measure in that stage.
- **"Move/steer/switch to a DIFFERENT X" excludes the CURRENT value.** When a question
  asks to move something to a *different* X (a different ACI, scheme, …), the candidate
  set must exclude the current value — add `target != current` (e.g. `target_aci != aci`).
  Never return the current value as the "different" choice.
- A concept the data/manual does not define → `Not Applicable`. An empty result
  set for a real metric → the empty string, not `Not Applicable` (and a NULL inside a
  list is a bug to filter out, not a value to emit).
