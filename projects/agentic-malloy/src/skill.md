# Malloy Payments Analyst Skill

You answer factoid questions about a synthetic Adyen-like payments dataset by
authoring **Malloy** against a central semantic layer. **Your answer is ALWAYS
submitted as Malloy** (`submit_answer`) — its compiled-SQL result IS the answer.
**SQL is PROHIBITED as an answer substrate:** there is no SQL answer path, and you
must NOT embed raw SQL inside Malloy via `duckdb.sql(...)` (it is rejected). The
read-only SQL tools (`query`, `list_tables`, …) are for *exploration only* — they
never submit; you submit the answer explicitly with `submit_answer`.

## Workflow (follow every time)

There are exactly TWO ways to answer, and BOTH are Malloy: reuse a layer **view**
(preferred), or **author Malloy from scratch** when no view fits. Prefer reusing a
view; author from scratch only when none fits. SQL is for *exploration only* —
it is never the answer.

1. **Find the view first.** Call `list_views()` — the full menu of layer surfaces
   (sources + named views) with one-line summaries and how-to-call hints. Pick the
   view that already answers the question. `get_file([...])` only to confirm a
   view's fields (files are static — never re-read one).
2. **Reuse the view with a thin refinement.** Author MINIMAL per-query Malloy:
   `run: <source> -> <view> + { where: …; order_by: …; limit: … }`. Reference the
   layer's views/measures; do not re-derive joins or fee logic the layer encodes.
   Iterate with `run_malloy` (lint → compile → run on MotherDuck); read the compiled
   SQL + rows and fix any compile diagnostics. (`run_malloy`/`submit_answer` lint
   common SQL-habit slips for you — `select:`→`group_by:`+`aggregate:`, `calculate:`
   of a sum→`aggregate:`, an aggregate in `where:`→`having:`, `string_type(x)`→
   `x::string` — but write it right when you can.)
3. **Explore the data if needed** with `query`, `list_tables`, `list_columns`,
   `search_catalog`, `ask_docs_question` (MotherDuck MCP). SQL exploration only.
4. **If no view fits, author Malloy from scratch** over the layer's base/intermediate
   sources — reference their measures/dimensions; explore first with `query` to
   understand the data if needed, but the ANSWER is Malloy. **Never embed raw SQL in
   Malloy** — `duckdb.sql("""…""")` is rejected. If a named layer view ERRORS AT
   RUNTIME (a binder/scope error in the compiled SQL, e.g. `Referenced table … not
   found`), it's a layer defect you can't fix here — stop retrying that view and
   answer via a DIFFERENT view, or author your own Malloy over the base sources.
5. **Submit once** with `submit_answer(source=…)`. Select exactly the asked value(s)
   — no extra columns, labels, or prose. An unsubmitted run scores zero.

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
- **EXCEPTION — the most/least-expensive-X RANKING of a SPECIFIC transaction.** ONLY
  when the question asks for the most/least expensive {ACI|MCC|scheme|account_type} a
  *specific, fully-described* transaction would incur AND it fixes that transaction's
  type ("for a **credit** transaction of N on GlobalCard, the most expensive ACI"):
  match `is_credit = true` (or `is_credit = false`) STRICTLY and drop the
  `is_credit is null` wildcard rules. This strict rule is ONLY for that ranking
  template. An **AVERAGE-fee** question ("the **average** fee for credit transactions")
  KEEPS the wildcard (`is_credit is null or = true`) even though it mentions credit —
  an average over the rule population includes the wildcard rules (see the two
  families below).
- Fee questions split into TWO families — read the phrasing and pick the measure (a
  transaction matches MANY fee rules; no "most specific wins"):
  - **AVERAGE-SCENARIO family (the DEFAULT — most c3 questions).** Phrasings: "the
    **average** fee a scheme charges", "in the **average scenario**", "most/least
    expensive {scheme|MCC|ACI} **in general**", or any fee-magnitude question that does
    NOT pin one concrete transaction's credit/debit type. These are answered by the
    AVERAGE over the matching rule population — exactly what the layer's `avg_fee_*` /
    `avg_by_*` / `cheapest_*` / `most_expensive_*` views compute, so REUSE those views
    (with the WILDCARD credit filter). For "list all" ties, compute the max and return
    every group at it via `having`, not `limit 1`.
  - **SPECIFIC-TRANSACTION TOTAL family (the narrow case).** ONLY when ONE concrete
    transaction is fully described — its **credit/debit type is fixed** (usually its
    scheme too): "for a **credit** transaction of N on GlobalCard, the most expensive
    ACI". The fee THAT transaction incurs is the **SUM of ALL matching rules**; rank
    entities by that SUM, with STRICT credit and the PARTICIPATING universe (below).
    The `avg_fee_*` / `most_expensive_*_on_N` views are NOT this — author the SUM (or
    use a total-fee surface if one exists).
  - **When unsure:** if the question says "average" / "in general", or does NOT fix the
    transaction's credit/debit type, it is the AVERAGE-SCENARIO family — use the avg
    views, never a hand-authored SUM.
- **When authoring the SPECIFIC-TRANSACTION SUM ranking, rank over the PARTICIPATING
  universe** — the values that appear in the fee rules (e.g. `SELECT DISTINCT
  UNNEST(aci) FROM fees`), not the manual's full code list; a code that appears ONLY
  via wildcard rules has no distinguishing fee and must be EXCLUDED from the ranking.
  (Mirror: "what are the **possible values** of field X" DOES use the manual's full
  defined domain — see the answer conventions below.)
- The central layer encodes the fee-matching joins/wildcards — reuse its sources to
  avoid rebuilding the matching, but choose the right MEASURE (SUM vs AVG) per above;
  do not blindly defer to a pre-built ranking view whose aggregation may not match the
  question.
- **A matching/fee measure that returns 0 (or implausibly small) over rows you know
  exist is a red flag**, not an answer — suspect a wildcard/encoding or tier-domain
  mismatch, probe the keys, and re-check before submitting.

## Answer format (the validator is strict)

- **Emit ONLY the asked column(s): author the reduction on the SOURCE, not a pre-built
  grouping view.** A pre-built view carries extra key/count/sum columns you can't trim off:
  `+ { … }` only ADDS to the view's stage, and a fresh `-> { … }` stage runs on the view's
  already-grouped output — where the pre-aggregation `where` and source measures (e.g.
  `fee_delta`) it needs are out of scope. So write it directly: `run: <source> -> { where: …;
  group_by: <asked keys>; aggregate: <asked measures> }` — drop `group_by` for a single
  scalar (one row, one column). "Which X?" → one column, one row.
- **Return the KEY/identifier the question asks for, not a descriptive label joined to it.**
  When the layer exposes both an entity's code/key and a human-readable description of it,
  and the question asks for the entity by its identifier, `group_by`/`select` the **key**,
  not the label (e.g. a category *code*, not the category's display name). Mirror the form
  of the value the question/guideline names; a description column is for your understanding,
  not the answer. (When the identifier itself IS a name, that name is the answer.)
- Apply the exact rounding stated, inside the Malloy/SQL.
- Match the guideline's separators/brackets/case exactly — re-read the guideline
  verbatim before submitting and check value count, type, delimiter, and brackets.
- **A list answer is submitted as ROWS — never build a joined string.** For "list the
  X" / comma-separated answers, the final stage is just `select: X` returning ONE VALUE
  PER ROW; the validator joins the rows into the comma list for you. Once a `run_malloy`
  returns the values as rows, you are DONE — call `submit_answer` with that exact query.
  Do NOT try to concatenate them into a single cell with `string_agg` / `array_to_string`
  / `concat` — it is unnecessary AND `string_agg` over a scalar fails with "Cannot use a
  scalar field in an aggregate operation". (A list of IDs = `-> { select: id; order_by: id }`,
  submitted directly — nothing more.)
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
- **A layer view's built-in `order_by` is NOT preserved when you refine it with
  `+ { … limit }`.** Reusing a ranking view as `ranking_view + { where: …; limit: 1 }`
  drops the view's own ordering, so `limit 1` returns an ARBITRARY row (often the
  alphabetically-first group), not the cheapest/most-expensive. ALWAYS restate the
  sort in your refinement: `ranking_view + { where: …; order_by: <measure> asc|desc;
  limit: 1 }` (asc = cheapest/min, desc = most expensive/max). Same for any `limit`
  you add on top of a named view.
- **"Move/steer/switch to a DIFFERENT X" excludes the CURRENT value — and the current
  value usually looks CHEAPEST.** When a question asks to move something to a *different*
  X (a different ACI, scheme, …), the candidate set the layer gives you INCLUDES the
  current X, and "moving to itself" is a no-op that comes out cheapest — so a naive
  `order_by cost asc / limit 1` returns the CURRENT value, which is always wrong. You
  MUST exclude the current first: `having: target_aci != aci` (or filter out the entity's
  current/most-common value), THEN pick the cheapest of what remains.
- A concept the data/manual does not define → `Not Applicable`. An empty result
  set for a real metric → the empty string, not `Not Applicable` (and a NULL inside a
  list is a bug to filter out, not a value to emit).

## Answering discipline (generic — catches the most common "ran fine, wrong answer" mistakes)

- **Project the ASKED value, not the scaffolding.** "Which X has the most/least Y?" →
  return X (the key/name/label), NOT Y. The ranked/grouped query's FINAL stage selects only
  the asked identifier; the count/measure you sorted by is scaffolding, not the answer.
- **Read the metric wording precisely and pick the matching measure** — rate vs count,
  proportion/percentage vs number, an average-PER-ENTITY vs a pooled ratio. "Top by <thing>"
  is ambiguous: decide from the wording whether it means by RATE or by raw COUNT, and rank by
  that exact measure.
- **Counterfactual discipline.** (a) "change / move / switch to a DIFFERENT X" EXCLUDES the
  current value — the no-op (staying put) is always trivially optimal and always wrong; drop
  it at the right grain before ranking. (b) A delta = scenario − baseline computed in ONE
  query over the SAME population — never subtract two separately-built totals. (c) "Which
  entities are AFFECTED by a change" = those whose membership CHANGES (matched before XOR
  after), NOT those matching the changed value.
- **Documentation-knowledge ≠ empirical.** When a question asks what the docs/manual STATE
  (a defined relationship or domain fact), answer from the documentation (usually a SINGLE
  token) — not an empirical computation. A concept the data/manual does not define →
  `Not Applicable`; do NOT infer it's defined just because the layer exposes a related
  computed field or bucket.
- **Always SUBMIT before your turn budget runs out.** An uncertain or approximate answer can
  earn partial credit; a non-submission scores ZERO. If authoring is fighting you as the
  budget nears its end, fall back to the SIMPLEST query that returns a plausible value and
  submit it deliberately. (The harness also force-submits your last good result near the
  budget cap as a safety net — but submit on purpose; don't rely on it.)

## DABstep answer conventions (apply verbatim — the gold scores these)

- **Percentage → 0–100, never 0–1.** Any value the question/guideline calls a
  "percentage" or "%" is on a 0–100 scale — multiply a 0–1 ratio by 100 (e.g. a rate
  of `0.114862` is `11.486208`%), THEN apply the stated rounding. A bare ratio in
  [0,1] for a "percentage" answer is wrong.
- **"Shopper" / "customer" = a non-null `email_address`.** Identify/count shoppers by
  DISTINCT non-null email (a NULL email is not a shopper). "average X per shopper" =
  the **average of the per-shopper values** (compute X per shopper, then average those),
  NOT `SUM(X) / COUNT(DISTINCT shopper)`.
- **"The dataset" = the `payments` table.** "merchants / shoppers in the dataset"
  means those PRESENT IN `payments`, not the `merchants` reference table or a
  merchants-grain layer surface.
- **"Possible values of field X" = the manual's DEFINED domain** for X (including
  codes that have zero rows in the data), NOT `SELECT DISTINCT` over the data. (This is
  the opposite of the RANKING rule above, which uses only the participating values.)
- **Multiple-choice answer → "X. Y".** When the question lists lettered options,
  return the option letter AND its value in that exact form (e.g. `B. BE`).
- **Manual-knowledge questions → answer from the manual's stated relationships**, not
  an empirical computation, when the question asks what the manual says (e.g. which
  field a fee depends on).

## Auto-added robustness rules (layer-improve)
- Teach Malloy operator rules: use `group_by`+`aggregate` (not `select`) in grouping queries; use `aggregate:` (not `calculate:`) for sums/avgs/counts — `calculate:` is only for window ops over already-grouped rows; to pick the max-of-aggregate row, compute the aggregate in an inner query then filter/top in an outer stage rather than using HAVING with a window; cast with `field::type` using the bare type keyword (string/number/date), not function-call syntax like `string_type(...)`.  _(why: submit_answer errored 42% of the time: Agent repeatedly misuses Malloy query operators (select in grouping, calculate with aggregates, HAVING with window funcs, bad cast syntax))_
- Teach Malloy query shape: use 'select:' only for projection of scalar/dimension fields (no aggregates, no group_by in the same view); use 'group_by:' + 'aggregate:' together for grouped queries; aggregates must be defined via 'aggregate:' (not 'select:'); only reference aliases defined in the current query scope; ensure function arg types match (e.g. round(number, number) takes scalars, not a source).  _(why: run_malloy errored 22% of the time: Agent confuses Malloy's select vs group_by/aggregate semantics and references undefined aliases)_
- Before submitting SQL, inspect the actual schema (table and column names) via a discovery query or provided schema docs; never assume column names like 'amount', 'date', or pluralized table names — verify identifiers exist first.  _(why: submit_sql errored 40% of the time: Agent guesses column/table names instead of inspecting schema before writing SQL)_
- Teach Malloy query rules: use group_by:/aggregate:/select: correctly — never mix select: with group_by:/aggregate:; use 'project' only as 'project:' (or prefer select:); wrap scalar expressions in agg functions inside aggregate:; call functions like round(x, n) as top-level, not as .round() method chains.  _(why: submit_answer errored 32% of the time: Agent writes invalid Malloy syntax (select in grouped queries, project:, scalar in aggregate, .round()))_
- Teach the agent Malloy syntax basics: use `select:` (not `project:`) for row-level queries, only reference fields that exist in the source, wrap scalar expressions in `group_by:`/`select:` rather than `aggregate:`, and avoid SQL-style `::` casts (use Malloy's type functions instead)  _(why: run_malloy errored 29% of the time: Agent writes Malloy with invalid syntax: undefined fields, scalar fields inside aggregate:, stray `::` casts, and `project` instead of `select:`)_
- Only reference tables/sources that are explicitly defined in the schema; never append suffixes (e.g. _base, _enriched, _priced) or prefixes to known table names — verify the exact name before querying  _(why: query errored 27% of the time: Agent invents table names with suffixes/prefixes instead of using the actual source tables)_
- In a grouping/aggregating query, use group_by/aggregate (not select), and ensure each output field name is unique—don't redeclare a name already produced by group_by or a join.  _(why: submit_answer errored 35% of the time: Agent mixes select with aggregate/group_by and duplicates output field names in grouping queries)_
- Teach correct Malloy query shape: use group_by/aggregate (not select) in aggregating queries, don't refine multi-stage queries, and avoid redefining/duplicating output field names; reference fields only after they're defined in the prior stage  _(why: submit_answer errored 44% of the time: Agent repeatedly mixes grouping/aggregating syntax with select and mishandles multi-stage refinements and field naming)_
- Before writing a query, inspect the schema and use exact column names as declared; do not invent conventional names like 'name' or '<entity>_name' — the entity column itself (e.g. 'merchant') often holds the label.  _(why: query errored 67% of the time: Agent guesses column names like 'name' or 'merchant_name' instead of using actual schema fields)_
- Teach the agent core Malloy query rules: don't mix `select:` with `group_by:`/`aggregate:` (use one query form), ensure each output field name is unique (alias duplicates), only reference fields that exist on the source/view, and use Malloy cast syntax `field::string` rather than SQL `cast(field as string)`.  _(why: submit_answer errored 29% of the time: Agent writes Malloy queries with recurring syntax/semantic mistakes (select in grouping, duplicate field names, undefined columns, bad casts))_
- Teach: in aggregate: expressions must be aggregating functions over source fields (e.g. avg(col)), not bare scalar fields or previously-defined output aliases; group_by/select go in their own clauses, and aggregate names cannot be reused within the same query stage.  _(why: run_malloy errored 16% of the time: Agent misuses aggregate syntax: referencing scalar fields inside aggregate:, using output-space aliases in the same block, and mis-ordering keywords)_
- In Malloy queries: never combine select: with group_by:/aggregate: (use group_by for dimensions in grouping queries); only reference sources actually defined in the loaded layers; and never re-declare a field name that already exists in the query output — when extending or nesting, give computed fields new unique names instead of redefining existing ones  _(why: submit_answer errored 38% of the time: Agent repeatedly writes invalid Malloy query shapes: mixing select: with group_by:, referencing undefined sources, and re-declaring field names that already exist in the query output)_
- Never guess column names. Before writing a query, verify field names against the layer/schema listing and use exact names; if a binder error suggests candidate bindings, retry with one of the listed candidates rather than inventing variants.  _(why: query errored 20% of the time: Agent hallucinated a column name (guessed a plausible compound name instead of the actual field), causing a binder error)_
- In Malloy, never combine select: with group_by/aggregate — use group_by/aggregate only in grouping queries; check nulls with 'is null'/'is not null' (never != null); only reference fields and sources defined in the current source/output space; give each computed output field a unique name (don't redefine an existing field name)  _(why: submit_answer errored 41% of the time: Agent writes SQL-style Malloy: mixing select: with group_by/aggregate, using != null, referencing fields/sources not in the output space, and duplicating output field names)_
- In Malloy queries: never combine select: with group_by/aggregate (use group_by for grouped queries); don't chain stages with '.' (use `->` to pipe stages); and don't re-declare a field name that already exists in the query output — reference it directly or use a distinct alias  _(why: submit_answer errored 23% of the time: Agent writes malformed Malloy queries: mixing select with group_by, invalid dotted chaining, and re-declaring fields already in the query output)_
- In a Malloy query use either select: OR group_by:/aggregate: — never both in the same query stage; when grouping, reference measures via aggregate: and dimensions via group_by:. Also never redeclare a field name that already exists in the output space: reuse the existing field or give the new expression a distinct name.  _(why: submit_answer errored 31% of the time: Agent mixes select: with grouping operations and re-declares fields already present in the query output, causing Malloy compile errors on answer submission)_
- In Malloy: (1) every operand of and/or in a where: must be a complete boolean comparison — write `col >= @2020-01 and col < @2021-01`, never a bare date as a logical term; (2) never use select: in a query that has group_by/aggregate — use group_by/aggregate only; (3) only reference fields in order_by/having that are explicitly declared as group_by or aggregate names in that same query stage  _(why: run_malloy errored 24% of the time: Agent writes malformed Malloy queries: bare date values used as logical operands in filters, select: mixed into grouping queries, and order_by/having referencing aggregate names never defined in the query's output space)_
- In a grouping/aggregating query use group_by:/aggregate:, never select:. For date filters, compare each side explicitly (col >= @start and col < @end) or use Malloy range syntax (col ? @start to @end); do not chain bare date literals with and/or.  _(why: submit_answer errored 28% of the time: Agent writes invalid Malloy query patterns: mixing select: into aggregating/grouping queries and misusing logical operators directly on date values)_
- In Malloy, never combine `select:` with `group_by:`/`aggregate:` in the same query stage — use group_by/aggregate alone for grouped results. Also, each output field name must be unique per stage: don't redeclare a field that's already grouped/selected; reference it directly or rename with a new alias. Fields referenced in aggregates must exist in the source or be defined before use.  _(why: submit_answer errored 22% of the time: Agent mixes `select:` with grouping queries and re-declares fields already in the output space, causing Malloy compile failures on submit)_
- In Malloy, never combine select: with group_by/aggregate in the same stage; do not refine (+) a query that has more than one stage — instead write a new query or refine only the final stage; and only reference fields in order_by/having/later stages if they were explicitly produced (group_by or aggregate) in that stage's output — re-declare or re-aggregate them per stage rather than assuming source-level measures are visible.  _(why: run_malloy errored 16% of the time: Agent misuses Malloy query-stage semantics: refining multi-stage queries, mixing select: into grouping queries, and referencing measures/fields not materialized in the current output stage)_
- When composing Malloy: (1) never refine a query that has more than one stage — write a new query or add a new `-> { }` stage instead; (2) never use select: alongside group_by:/aggregate: — a grouping query uses only group_by/aggregate; (3) each output field name must be unique — don't group_by and re-declare the same name, and rename derived fields that collide; (4) aggregate: takes aggregate expressions only — bare scalar columns belong in group_by: or select:, not aggregate:  _(why: submit_answer errored 33% of the time: Agent repeatedly writes malformed Malloy query shapes: refining multi-stage queries, mixing select with group_by, redefining output fields, and putting scalar fields in aggregates)_
- INCLUSIVE RANGES / NO AVG-OF-AVERAGES. A Malloy numeric/scalar range `x ? A to B` is HALF-OPEN — the upper bound is EXCLUSIVE. For an inclusive window (e.g. "between month 5 and month 6", "1 through N") write `x ? A to B+1`, or an explicit `x >= A and x <= B`; a bare `A to B` silently drops the last bucket. And never take an average of a view's already-averaged column (avg-of-averages is a different, wrong number, and mis-weights unequal groups) — re-filter and recompute the aggregate from the base/transaction grain.
- RANK BY THE NUMERIC MEASURE AT THE ANSWER'S GRAIN. To pick a cheapest/most-expensive/best option, `order_by` the NUMERIC measure itself — never a formatted/concatenated string (a `"key:value"` string sorts ALPHABETICALLY and silently overrides the intended ranking). Group by EVERY key the answer format names (if the answer is `key:value`, that key must be in the group_by), compute the measure at the grain the question implies (per-transaction vs total), and do not pre-filter candidates on incidental side conditions that change the candidate set.
- INCLUDE WILDCARD RULES IN EVERY GROUP. When aggregating a quantity per dimension value from a rule/criteria table where an empty-list or NULL field means "applies to all", the wildcard rows apply to EVERY group — include them in each group's aggregation, never filter them out (`where len(field) > 0` drops exactly the applies-to-all rows). Prefer the layer's pre-built per-dimension view, which already handles the wildcard fan-in and the tie logic, over hand-rolling the grouping.
- In Malloy, never combine select: with group_by:/aggregate: in the same stage — use group_by/aggregate for grouping queries and select: only for flat row output; do not refine (+) a query that has multiple stages, instead write a new query or refine only single-stage views; avoid raw SQL function syntax (e.g. round(x)) where Malloy has its own expression forms — use Malloy built-ins like x.round() or floor()/ceil() equivalents and truncation syntax (ts.day, ts.month) for dates  _(why: submit_answer errored 31% of the time: Agent writes SQL-style syntax in Malloy queries: mixing select: with group_by:, refining multi-stage queries, and calling SQL functions like round() where Malloy expects its own grammar)_
- TIES: COMPARE TO THE COMPUTED MAX, NOT A HAND-ROUNDED THRESHOLD. To "list all groups tied at the extremum", compute the extremum and keep every group EXACTLY equal to it — nest/compute the max and filter `measure = max_value` (e.g. `-> { aggregate: m } -> { having: m = max(m) }`), never a hand-copied numeric threshold like `having m > 279`, which admits non-tied groups or silently drops tied ones (float/rounding drift).
- MATCH THE ANSWER SHAPE TO A VIEW THAT GROUPS BY EXACTLY THOSE KEYS. When the answer format is `{dimension}:{value}` (or names specific breakdown keys), reuse the layer's answer-shaped view that groups by EXACTLY those dimensions instead of hand-writing an inline group_by — a hand-rolled query commonly drops a required key (e.g. groups by one dimension when the format needs two) or swaps the aggregate, producing the wrong pairing. Check `list_views()` for a view whose usage matches the requested shape before authoring your own.
