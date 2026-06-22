# PK / FK / Join-Cardinality Discovery — Minimal Cheap Subset

> A **fast, computationally cheap candidate-generator** for inferring **primary keys**, **foreign keys**, and
> **join cardinality** (`join_one` / `join_many` / `join_cross`) from DuckDB/MotherDuck tables, to auto-generate a
> Malloy model. This is the cheap path: catalog metadata + approximate (HLL) distinct counts + sampling + name/type
> heuristics only. **No *expensive* scans** — no exact distinct, sort, or hash-dedup over whole tables. (Single-pass
> *streaming* scans for HLL aggregates and reservoir sampling are allowed and cheap — see "Hard efficiency rules".)

## Hard efficiency rules (obeyed by every technique below)

- **Forbidden:** exact `count(DISTINCT col)`, full `EXCEPT` / anti-join containment over whole tables, multi-column
  exact distinct over whole tables, sort-based dedup — i.e. any *exact* O(n) pass that must read every row to *prove*
  a fact (large hash-distinct, sort, anti-join).
- **Allowed:** catalog metadata (zero scan); `approx_count_distinct` (HLL); `USING SAMPLE n` / `RESERVOIR` for any
  cross-table check; `min`/`max` range checks; name/type heuristics and `jaro_winkler_similarity` / `levenshtein`
  (free); `count(*)` and row counts (cheap from DuckDB metadata).
- **A single *streaming* scan is allowed and is not "a full table scan" in the forbidden sense.** The Step 1 profile
  is exactly one `SEQ_SCAN` (O(1) state), and reservoir sampling streams all rows but keeps only a fixed reservoir —
  both verified by `EXPLAIN`/`EXPLAIN ANALYZE`. What's forbidden is the *expensive* exact O(n) work (distinct hash,
  sort, anti-join), not the read itself.

**Framing:** a PK is a single-column near-unique, null-free key; a FK is a near-containment `child.fk ⊆ parent.pk`
where the parent is near-unique. We confirm uniqueness *approximately* and containment *by sampling* — never exactly.
⚠️ A PK has distinct ≈ row count (the *highest* cardinality); never pick a key by *minimizing* distinct values.

---

## The pipeline (catalog → PK → FK → cardinality → emit)

### Step 0 · Catalog first (free, authoritative, zero scan)

| Technique | How to identify if it could help | How to implement (approximate only) | Required data |
|-----------|----------------------------------|-------------------------------------|---------------|
| **Declared PK / UNIQUE / NOT NULL** | Table came from an RDBMS / dbt / Iceberg / `CREATE TABLE` with constraints | `SELECT constraint_type, constraint_column_names FROM duckdb_constraints() WHERE constraint_type IN ('PRIMARY KEY','UNIQUE','NOT NULL')` — take PK directly; UNIQUE+NOT NULL = candidate key | Catalog only |
| **Declared FOREIGN KEY** | Same — gives child/parent + direction for free | `SELECT constraint_column_names, referenced_table, referenced_column_names FROM duckdb_constraints() WHERE constraint_type='FOREIGN KEY'` | Catalog only |

If declared constraints exist, **use them and skip the inference for that table.** Parquet/CSV imports usually
declare nothing → fall through to the profiling steps. Row count per table is cheap: `SELECT count(*) FROM t`.

### Step 1 · One-pass profile (single cheap scan per table)

Compute, per column, exactly the key-detection fields PK/FK scoring needs — `approx_unique` (HLL), `count` (table row
count), `null_percentage`, `column_type`, and `min`/`max` (for the FK range pre-filter in Step 3) — in **one
sequential scan**. We hand-build this instead of `SUMMARIZE` to avoid SUMMARIZE's expensive approximate quantile
(q25/q50/q75), `avg`, and `std` computation, which PK/FK detection never uses: the query below pulls only the
key-detection fields in a single approximate pass.

The query is generic — `COLUMNS(*)` expands to every column, so the **only thing you change per table is the table
name** (in two places: the scan and the `information_schema.columns` filter). Replace `schema` / `table` below.

```sql
-- per-column approximate uniqueness + null-freeness + min/max, ONE scan (no quantiles/avg/std):
WITH agg AS MATERIALIZED (                                  -- MATERIALIZED ⇒ scan the table exactly once
  SELECT
    count(*)                            AS total_rows,      -- table row count (the "count" column)
    approx_count_distinct(COLUMNS(*))   AS "au_\0",         -- HLL distinct per column (NOT count(DISTINCT))
    count(COLUMNS(*))                    AS "nn_\0",         -- non-null count per column
    min(COLUMNS(*))::VARCHAR             AS "mn_\0",         -- min per column (FK out-of-range pre-filter)
    max(COLUMNS(*))::VARCHAR             AS "mx_\0"          -- max per column (FK out-of-range pre-filter)
  FROM schema.table                                         -- <<< change table here (1 of 2)
),
-- reshape the single wide aggregate row to long format (one row per column) — no extra table scans:
au AS (UNPIVOT (SELECT COLUMNS('au_.*') FROM agg) ON COLUMNS(*) INTO NAME k VALUE approx_unique),
nn AS (UNPIVOT (SELECT COLUMNS('nn_.*') FROM agg) ON COLUMNS(*) INTO NAME k VALUE non_null),
mn AS (UNPIVOT (SELECT COLUMNS('mn_.*') FROM agg) ON COLUMNS(*) INTO NAME k VALUE "min"),
mx AS (UNPIVOT (SELECT COLUMNS('mx_.*') FROM agg) ON COLUMNS(*) INTO NAME k VALUE "max"),
types AS (                                                  -- column_type + position from the catalog (zero scan)
  SELECT column_name, data_type AS column_type, ordinal_position
  FROM information_schema.columns
  WHERE table_schema = 'schema' AND table_name = 'table'    -- <<< change table here (2 of 2)
)
SELECT
  t.column_name,
  t.column_type,
  au.approx_unique,
  (SELECT total_rows FROM agg)                                            AS "count",
  100.0 * ((SELECT total_rows FROM agg) - nn.non_null)
        / (SELECT total_rows FROM agg)                                    AS null_percentage,
  au.approx_unique::DOUBLE / (SELECT total_rows FROM agg)                 AS approx_unique_ratio,
  mn."min",                                                               -- Step 3 range pre-filter
  mx."max"                                                                -- Step 3 range pre-filter
FROM types t
JOIN au ON au.k = 'au_' || t.column_name
JOIN nn ON nn.k = 'nn_' || t.column_name
JOIN mn ON mn.k = 'mn_' || t.column_name
JOIN mx ON mx.k = 'mx_' || t.column_name
ORDER BY t.ordinal_position;
```

This returns one row per column with `column_name`, `column_type`, `approx_unique`, `count`, `null_percentage`,
`approx_unique_ratio`, `min`, `max`. `EXPLAIN` confirms exactly one `SEQ_SCAN` of the table — the `MATERIALIZED`
aggregate is computed once and every `UNPIVOT`/join reads the resulting single row. `approx_unique` and
`null_percentage` match `SUMMARIZE` exactly; we simply skip the quantile/avg/std work SUMMARIZE also does.

Cache the result; every later step reads these numbers instead of re-scanning.

### Step 2 · PK candidates (approximate single-column uniqueness, scored)

| Technique | How to identify if it could help | How to implement (approximate only) | Required data |
|-----------|----------------------------------|-------------------------------------|---------------|
| **Approx-unique + null-free gate** | The atomic "could this be the key" test | From the Step 1 profile: keep columns with `approx_unique_ratio ≥ 0.99` **AND** `null_percentage = 0`. (`approx_unique` is HLL, so use a band, not `= count`.) | Step 1 profile row |
| **Name-pattern score** | Columns named like keys | Reward `id`, `{table}_id`, suffix `_id/_key/_no/_nr/_pk` via regex / `jaro_winkler_similarity(col, table\|\|'_id')` | Column names |
| **Position score** | No declared PK; PK is often first | Reward low `ordinal_position` (from `duckdb_columns()` / `information_schema.columns`) | Catalog |
| **Type preference** | Choosing among unique columns | Prefer INT/BIGINT/UUID > VARCHAR; reject DATE/TIME/DECIMAL-money/free-text even if unique | Catalog (types) |

Blend into one additive score (e.g. `50·is_approx_unique_nullfree + 20·name + 15·type + 15·position`), pick the
single highest-scoring candidate per table as the PK; others become alternate keys. **Fallback:** if no column
clears the bar, synthesize a deterministic surrogate `md5(concat_ws('|', <stable cols>))` and treat it as the PK
(composite/synthetic keys emit `on`, not `with`).

### Step 3 · FK candidates (metadata pairs → sampled overlap confirm)

Generate cheap candidate pairs from metadata, prune hard, then confirm containment **by sampling the child against
the parent** — never a full anti-join.

| Technique | How to identify if it could help | How to implement (approximate only) | Required data |
|-----------|----------------------------------|-------------------------------------|---------------|
| **Type-compatible + name-similar pairs** | First gate — which pairs to even test | Pair child col → parent col where types compatible (char↔varchar, int widths) AND names match: suffix-strip `_id/_key/_fk`, `{singular}_id`, or `jaro_winkler_similarity(child_col, parent_table) > 0.8`; skip self-pairs | Catalog only |
| **Parent-side-is-a-key requirement** | A FK must reference a (near-)unique parent | Require parent column's `approx_unique_ratio ≈ 1.0` (reuse Step 1 / it's a PK candidate). Kills the bulk of accidental pairs | Step 1 profile (cached) |
| **Tiny-domain prune** | Booleans / status enums fan out into spurious pairs | Drop child cols with `approx_count_distinct(child) < ~20` | HLL on one column |
| **Min/max out-of-range pre-filter** | Cheap refutation with no join | If `child.min < parent.min OR child.max > parent.max` (from the Step 1 profile's `min`/`max`), reject — child can't be contained | Cached min/max |
| **Sampled value-overlap confirm** | The actual containment test, done cheaply | Sample child distinct values, test membership in parent (query below). Accept if `coverage ≥ ~0.95` | Sample of child + indexed parent lookup |

```sql
-- Sampled containment: do most sampled child keys exist in the parent? (no full EXCEPT / anti-join)
WITH child_sample AS (
  SELECT DISTINCT fk FROM child USING SAMPLE 200 ROWS (reservoir)   -- bounded, cheap
)
SELECT avg( (fk IN (SELECT pk FROM parent))::INT ) AS coverage      -- fraction of sampled keys found in parent
FROM child_sample WHERE fk IS NOT NULL;
```

**Verified cheap (`EXPLAIN ANALYZE`, 10M-row table):** `USING SAMPLE … (reservoir)` is pushed *below* the `DISTINCT`,
so the dedup runs over the ~200 sampled rows (`HASH_GROUP_BY` input = 200), **not** the full table — the expensive
O(n) hash-distinct is never built. It is one cheap streaming scan + a tiny distinct (~10–25 ms on a 10M-child /
2M-parent test). Forcing distinct-first (`SELECT * FROM (SELECT DISTINCT fk FROM child) USING SAMPLE …`) instead
feeds ~2M rows into the aggregate (~5× slower) — so keep `SAMPLE` on the base table, not around a sub-distinct.

A sample can disprove containment (any miss lowers coverage) and *suggest* it; it cannot prove it. That's
acceptable — this stage proposes candidates. **Dedup:** one parent per child FK column — keep the highest-scoring.

### Step 4 · Cardinality → `join_one` / `join_many` / `join_cross`

Decide the keyword from **approximate** uniqueness of each join column plus a **sampled** max-rows-per-key estimate.

| Technique | How to identify if it could help | How to implement (approximate only) | Required data |
|-----------|----------------------------------|-------------------------------------|---------------|
| **Two-sided approx uniqueness** | Core keyword decision | Compare each side's `approx_unique_ratio` (≈1.0 ⇒ "one" side) → decision table below | Cached Step 1 profile |
| **Sampled max-rows-per-key** | Want fan-out degree, not just yes/no | `SELECT max(n) FROM (SELECT fk, count(*) n FROM child USING SAMPLE 5% GROUP BY fk)` — `max≈1` ⇒ unique side | 5% sample |
| **Bridge / junction detection** | Small table with two FK cols, neither alone unique | If a table has two confirmed FK columns and neither is approx-unique → model as **two `join_one`s through the bridge**, never one `join_many` | Two FK results + per-col approx ratio |

**Malloy semantics:** `join_one:` = joined table has one row per declaring-source row (covers N:1 FK + 1:1), lives in
the **FK-holding** source pointing at the parent; `join_many:` = many rows per declaring row, lives in the **parent**;
`join_cross:` = cartesian (rare). `with <fk>` requires the parent to declare a single-column `primary_key:`; composite
keys must use `on … and …`. Joins are left-outer, so FK nulls are safe.

#### Decision table — (approx-uniqueness each side) → keyword + declaring source + direction

Notation: **C** = child (holds `fk`); **P** = parent (key `pk`). "approx-unique" = `approx_unique_ratio ≈ 1.0`.

| `C.fk` approx-unique? | `P.pk` approx-unique? | sampled overlap `C.fk ⊆ P.pk`? | shape | Cardinality | Malloy keyword | Declared **in** | Form |
|:---:|:---:|:---:|---|:---:|---|---|---|
| no | yes | yes | `fk` looks like FK, `P` is key | **N:1** (most common) | `join_one:` | **C** (FK holder) | `join_one: P with fk` (P single-col PK) else `on fk = P.pk` |
| yes | yes | yes | both keys, same grain | **1:1** | `join_one:` | either (root at fact source) | `with` or `on` |
| yes | no | yes (reversed) | `P.pk` is the FK side | **1:N** | `join_many:` | **P** ("one" side) | `join_many: C on C.fk = pk` |
| no | no | both sides overlap into a bridge; neither unique | junction table (two FKs) | **N:M** | two × `join_one:` | the **bridge** | `join_one: A with fk_a` + `join_one: B with fk_b` |
| no | no | no overlap either way | intentional combinatorial | (cartesian) | `join_cross:` | base | `join_cross: other` (rare) |
| — | yes | yes; `fk` references own table | self-reference (`mgr_id→id`) | N:1 self-join | `join_one:` + alias | the table | `join_one: manager is employees with mgr_id` |
| — | yes (×2) | two FKs → same P | role-played (origin/dest → airports) | two N:1 | two × `join_one:` + aliases | C | `join_one: origin is airports with origin_code` + `… is airports with dest_code` |

**Generator default:** root each source at its own table; for every confirmed FK emit a `join_one:` in the
FK-holding source toward the (approximately-unique) parent. This yields correct symmetric aggregates everywhere and
rarely needs `join_many`.

#### `join_one` vs `join_many` — which to default to under ambiguity

Both keywords compile to the **same LEFT OUTER join**; the keyword only tells Malloy whether the join **fans out**
(which sets aggregate locality). The raw joined rows are identical — only `sum`/`avg`/`count` differ. The choice
matters because of an **asymmetric failure mode**:

- `join_one` on a *truly* one-to-many rel → **silent fan-trap double-counting** (Malloy does *not* auto-error; you'd
  only catch it via `joined_count > source_count`). Dangerous and quiet.
- `join_many` on a *truly* many-to-one rel → **still correct** (symmetric-aggregate dedup becomes a no-op), just pays
  a performance tax. Safe but slow.

So favoring `join_many` under genuine ambiguity is a defensible *correctness-over-performance* instinct — **but it is
NOT a free superset of `join_one`:**
- Symmetric aggregation needs a **usable key on the joined ("many") source** to dedupe fan-out → no PK ⇒
  `Primary key required for join` (you must hand-write a full-composite-key `on`).
- It is **direction-specific**: `join_one` lives in the FK-holder pointing at the parent (and may use `with`);
  `join_many` lives in the parent pointing at children (via `on`). You can't swap it in at the same site.
- It forces **locality-qualified aggregates**: a bare `sum(joined.x)` across `join_many` is an **error** — must write
  `join_name.field.sum()`. (`min`/`max`/`count-distinct` are symmetric, no qualifier needed.)
- On real fan-out it adds a per-row hash + DISTINCT to every asymmetric aggregate.

**Default rule (keyed off the cheap signals above):**

| Parent `approx_unique_ratio` | Sampled `max-rows-per-key` | Decision |
|---|---|---|
| ≥ 0.99 (confirmed unique) | ≈ 1 | **`join_one`** — correct **and** the cheaper plan; don't pay the dedup tax |
| < 0.99 (measured duplication) | > 1 | **`join_many`** (declared in the "one" side) — correctness over performance |
| gray band (just under 0.99 / sample inconclusive) | ~1 but uncertain | prefer the **loud** option `join_many` **only if** the joined source has a usable `primary_key`; **else** emit `join_one` + record a low-confidence caveat for the verification loop |

A confirmed-unique parent makes `join_one` both correct *and* the cheaper plan — there's no correctness to buy by
upgrading, so do **not** blanket-default to `join_many`. Only the genuine gray band benefits from "favor the loud
failure," and only when a key exists to make `join_many` legal at all.

### Step 5 · Emit Malloy

```malloy
source: customers is duckdb.table('customers') extend {
  primary_key: id
}
source: orders is duckdb.table('orders') extend {
  primary_key: id
  join_one: customers with customer_id           -- N:1, customers.id is the approx-unique PK
  -- composite / synthetic key → use `on`:
  -- join_one: shipments on warehouse_id = shipments.warehouse_id and sku = shipments.sku
}
```

---

## Accuracy tradeoffs (honest)

This is a **fast candidate-generator, not a prover.** Be explicit about where it can be wrong:

- **Approximate distinct counts can't prove uniqueness.** HLL (`approx_unique` / `approx_count_distinct`) carries
  ~1–2% error, so a near-unique column with a handful of true duplicates can read as 1.0 (false PK), and a genuine
  key can dip just under the 0.99 band (missed PK). Near-unique is precisely the worst case.
- **Sampled overlap can both miss and over-claim.** A 200-row child sample can pass containment while rare orphan
  keys outside the sample violate it (over-claim), or fail because the sample happened to catch the only orphans
  (miss). Coverage is an estimate, not the true inclusion dependency.
- **Name/type heuristics are priors, not facts** — synonym keys (`cust`↔`customers`) are missed; coincidental name
  matches are over-claimed.

The safety net is downstream: the **Malloy compiler** rejects structurally invalid joins, an optional **LLM
adjudication** pass can confirm each proposed join + direction from the compact evidence (names, types, coverage %,
row counts, sample values). Default to **high precision**: when a candidate is borderline, prefer to emit
no join rather than a wrong one.
