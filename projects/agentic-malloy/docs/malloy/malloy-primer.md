# Malloy Primer (compact) — writing Malloy over DuckDB/MotherDuck

Malloy is a semantic modeling language compiling to SQL: define reusable **sources** (table + dimensions/measures/joins/views), then **queries** that compose. Aggregates stay correct across joins because each join declares cardinality. It is NOT SQL — use the idioms below.

When modeling tables in Malloy make individual files in the form <tablename>_base.malloy.
In these files make sources of the same name.
These tables shouldn't have any join logic in them but should contain measures and dimensions.  
You can then make <source>.malloy for interesting tables to querys with join logic and views for the common queries.

## SQL → Malloy gotchas (the things to get right)
- **NEVER write `import`.** When the model is provided pre-loaded, every source is already in scope — just `run: <source> -> { ... }`. An `import` line always fails, and when it is the FIRST line the compiler mis-reports it as `mismatched input '='` on a later (innocent) line — if you see that error, delete any `import` first.
- **List/array columns**: test emptiness with `len!number(col) = 0`, NEVER `is null` (an empty list is not NULL, so `is null` silently matches nothing). Membership is `list_contains!boolean(col, x)` and the element type must match the list's element type (cast if needed). There is no native list-membership operator, and `cardinality()` is for MAPs — use `len!number`.
- `is` names things, NEVER `as`. Equality is `=`, NEVER `==`.
- Logical `and` / `or` / `not` — NEVER `&&` / `||` / `!`.
- `count()` (no `count(*)`); `count(expr)` is ALREADY distinct (don't write `count(distinct x)`).
- Pattern match `~` / `!~` (LIKE-style `%` `_` wildcards), NOT `LIKE`. Regex: `name ~ r'^Z'`.
- String literals use SINGLE quotes `'CA'`. Backticks quote reserved-word/special identifiers: `` `year` ``, `` `month` ``, `` `source` ``, `` `select` ``, `` `Airport Name` ``.
- Cast with `::` (`distance::string`), safe cast `:::`. NOT SQL `CAST(...)`.
- Branch with `pick ... when ... else ...`, NOT `CASE`.
- `concat(a, ' ', b)`, NOT `a || b`.
- Date/time literals start with `@`: `@2003`, `@2004-Q1`, `@2019-03`, `@2017-01-01 10:53`. A coarse literal IS a range (`@2003` = whole year).
- Truncate via `.timeframe`: `.year` `.month` `.quarter` `.week` `.day` `.hour` (result is a range from that boundary). Constant `now`.
- Apply/match operator `?`: `state ? 'CA' | 'NY'` (replaces `IN(...)`), `height ? > 5 & < 10`, `dep_time ? @2003`, `dep_time ? @2003 to @2005`.
- Comments: `//` line, `/* ... */` block. `#` is a renderer ANNOTATION (`# bar_chart`), NOT a comment.
- `limit:` lives INSIDE the query block; never append a trailing `LIMIT`. `order_by:` references the output name, not an ordinal.

## Sources (the model)
```malloy
source: airports is duckdb.table('flights.main.airports') extend {
  primary_key: code
  dimension: full_name is concat(faa_region, ' / ', city)   // scalar, no aggregates
  measure:   airport_count is count()                        // aggregate
  measure:   avg_elevation is elevation.avg()
  view:      by_state is { group_by: state; aggregate: airport_count }  // reusable query
}
```
- Source names are lowercase. `dimension:` = scalar; `measure:` = aggregate. One source per table, rooted at its own table.
- Connection is `duckdb`; table path fully qualified with EXACT casing: `duckdb.table('db.schema.TABLE')`. Reserved-word table: `duckdb.table('db.schema."order"')`.

## Joins
```malloy
source: order_items is duckdb.table('ecomm.main.order_items') extend {
  join_one: users with user_id                              // FK form: target needs primary_key
  join_one: inventory on inventory_item_id = inventory.id   // explicit-condition form
}
```
- `join_one` = many-to-one (FK→PK); `join_many` = one-to-many; `join_cross` = cartesian. Left-outer by default.
- `with <fk>` = shorthand for `on <fk> = target.<primary_key>` (prefer when target has a `primary_key`); else use `on <local> = target.<col>`.
- Cardinality is REQUIRED and load-bearing — it tells Malloy whether the join fans out rows; it is the key input to aggregate correctness.
- Role-play: join the same target twice with distinct names, access via dot path:
  ```malloy
  join_one: orig is airports with origin
  join_one: dest is airports with destination   // orig.full_name, dest.full_name
  ```
- ORDER MATTERS: define a source BEFORE any source that references it (dim/leaf tables first, fact tables last). `primary_key`/`on` column casing must match the table.

## Queries
```malloy
run: airports -> {
  where:     fac_type = 'HELIPORT'   // row filter (PRE-aggregation)
  group_by:  state
  aggregate: airport_count
  having:    airport_count > 100     // filter on aggregates (POST-aggregation)
  order_by:  airport_count desc
  limit:     10
}
```
- `run:` executes; `query: name is ...` names a top-level query; `view:` names one on a source. `->` pipelines stages (each stage queries the previous output).
- A stage is EITHER **reduce** (`group_by:` + `aggregate:`) OR **project** (`select:`). NEVER mix `select:` with `group_by:`/`aggregate:`.
- `calculate:` = window functions over the grouped result (e.g. `calculate: r is rank()`).
- Filtered aggregate (replaces `COUNT(CASE WHEN)`): `aggregate: ca is count() { where: state = 'CA' }`. Percent-of-total via `all()`: `pct is count() / all(count())`.
- `nest:` embeds an aggregating subquery per group (or reference a saved view by name).

## Aggregate locality (correctness across joins)
- **Symmetric** (`count`, `min`, `max`, distinct `count(x)`): always safe in plain form.
- **Asymmetric** (`sum`, `avg`) across a join: plain `sum(x)` warns/errs — specify locality:
  - `source.sum(x)` / `source.avg(x)` — compute at THIS source.
  - `join.field.sum()` / `join.avg(join.field)` — compute at the joined source.
  Different localities give different (all correct) numbers; choose deliberately. You cannot push an asymmetric aggregate forward across `join_many`/`join_cross` — compute it at the joined source.

