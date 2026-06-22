# The Complementary Malloy Linter — only what the compiler does badly or not at all

> **Goal:** a small, deterministic **pre-pass** that runs *before* `@malloydata/malloy`, not a re-implementation of
> it. The compiler is the linter for semantics; this layer only fills the gaps. (The full rule catalog lives in
> `01-linter-error-cases.md` — this document is the curated subset worth actually building.)

## The dividing line

The compiler (`Malloy.compile({ …, noThrowOnError: true })` → `model.problems: LogMessage[]`) already does deep
semantic analysis well: every problem has a stable `code`, and many carry a `replacement` string that is a
ready-made auto-fix. **Don't reproduce that.** A rule belongs in *this* linter only if it is **deterministic** (no
semantic judgment) **and** at least one of:

1. **Compiler can't deduce the fix.** It can tell *something* is wrong but not the *right answer* — the correct
   *order* of sources, the correct *casing* of an identifier, the right *alias* for a duplicate join. (Catalog or
   whole-file structure is needed, which a single error message doesn't carry.)
2. **Compiler's error is unhelpful or misleading.** The message points at the wrong place or is cryptic — most
   notably a Malloy keyword used as a column name, which aborts the *entire* parse far from the real cause.
3. **The fix is so trivial that a compile round-trip is overkill.** A one-line text/catalog rewrite (casing,
   backticking) applied in a pre-pass removes a whole generate→compile→re-prompt iteration.

If a rule needs to understand aggregate-vs-scalar context, join cardinality semantics, type inference, or query
structure — **it is the compiler's job, leave it out** (see "Deferred" at the bottom).

---

## Group 1 — Algorithmic / structural (the compiler cannot deduce the right answer)

| Rule | How to detect | How to fix | Why complementary |
|------|---------------|------------|-------------------|
| **Source dependency reordering** | Single-pass symbol table: record each `source:`/`query:` name + its line, and each `import` line. Flag any reference (join target, `import`, base source) whose definition appears *later* than its use. Connection refs (`duckdb.table/sql`) are exempt. | **Topologically sort** the statements (Kahn's algorithm over the join-dependency graph; imports first, then leaf/dimension sources before fact sources) and re-emit in that order. | ① The compiler only says `"X is not defined"` — it has no way to know the *correct* order; the fix is a trivial graph sort the linter can do exactly. **The single highest-value rule.** [REPO: `mgTopoSortSources`] |
| **Join cycle detection & break** | After building the dependency graph, any nodes left unsorted by Kahn's form a cycle (mutual joins, e.g. reversible 1:1). | Comment out the back-edge join with a `// CYCLE:` note (or surface it as a hard error for the user). | ① The compiler can't auto-resolve a circular reference; the linter detects and breaks it deterministically. [REPO + `omni-to-malloy.js`] |

**Reordering algorithm (the load-bearing one):**
```
build graph: for each source S, for each join target T that is also an in-file source, edge S → T (S depends on T)
Kahn's: queue all nodes with in-degree 0; pop → append to order → decrement dependents; repeat
emit: imports, then sources in `order` reversed (dependencies first), then queries/run
leftover nodes (in-degree never hit 0) = a cycle → break the back-edge
```

---

## Group 2 — Catalog-aware identifier fixes (compiler knows it's wrong, not what's right)

These all require the **DuckDB catalog** (`duckdb_columns()` / `duckdb_tables()` / `SUMMARIZE`), which a compiler
error message doesn't include. The compiler can only say "not found"; the linter knows the real name.

| Rule | How to detect | How to fix | Why complementary |
|------|---------------|------------|-------------------|
| **Table / column casing correction** | Exact catalog lookup of a table/column name fails, but a case-insensitive or fuzzy (Levenshtein, threshold ∝ name length) match succeeds | Replace with the exact-cased catalog identifier | ② + ③ Compiler says `column '…' not found` (unhelpful — doesn't suggest the cased name); fix is trivial against the catalog. [REPO: `mgFixColumnCasing`, `mgFixFromErrors`] |
| **Table-path qualification** | A `duckdb.table('…')` path has fewer than 3 dotted parts (`TEAM`, `schema.table`) | Prepend missing `database`/`schema` (default schema `main`) from catalog context | ① Compiler can't know the intended db/schema. [REPO: `table_path_missing_db`] |
| **Unwrap nested `duckdb.table()`** | The `table_path` value itself contains `duckdb.table('…')` | Strip the wrapper, keep the inner path | ③ Trivial regex; produces an otherwise-confusing parse error. [REPO: `table_path_unwrap`] |
| **Connection-name normalization** | `motherduck.table(…)` / `md.table(…)`, or a `md:` prefix inside a path | Connection is `duckdb`; drop `md:`: `duckdb.table('db.schema.t')` | ③ Deterministic rename. |
| **Reserved-word table name quoting** | The table component of a path matches DuckDB's `reserved` keyword set (`order`, `select`, `table`, `array`, `qualify`, `pivot`, …) | Double-quote that component: `db.schema."order"` | ② + ③ Bare reserved word → opaque SQL parse error; trivial fix. [REPO: `mgFixTablePath`] |
| **Duplicate-join auto-aliasing** | Two joins in one source target the same source without distinct aliases (or compiler `Cannot redefine '<name>'`) | Derive an alias from the FK column (strip `_id`/`_key`/`_api_id`): `join_one: home_team is team on home_team_id = home_team.team_id` | ① Compiler reports the conflict but doesn't generate the alias; the FK column name gives it deterministically. [REPO: Fix 4 + redefine recovery] |
| **Missing PK → explicit `null`** | A generated source has no detected PK and omits the field | Emit `primary_key: null` explicitly in the model-gen JSON | ③ Avoids ambiguity in the generation schema before compiling. [REPO] |

---

## Group 3 — Trivial deterministic rewrites & unhelpful-error guards (cheap text pre-pass)

Pure regex/text fixes that either dodge a cryptic compiler error or save a compile iteration. (Skip anything inside
`'…'` / `"""…"""` strings and `//`, `--`, `/* */` comments.)

| Rule | How to detect | How to fix | Why complementary |
|------|---------------|------------|-------------------|
| **Malloy reserved / time-keyword column → backtick** | A defined/referenced bare identifier matches a Malloy keyword, esp. time words `year, quarter, month, week, day, hour, minute, second, date, time` (also `from, to, count, sum, case, end, in, is, as, with, on, select, all, by, …`) | Backtick it: `` `year` ``, `` on `year` = s.`year` `` | ② **The marquee case:** a bare `year` column aborts the whole parse with a misleading message nowhere near the column. Fix is one backtick. [REPO: `mgQuoteCol` — shipped fix "Quote reserved-word columns"] |
| **`==` → `=`** | `==` outside strings | `=` | ② + ③ Lexer has no `==` token → confusing parse error; trivial. |
| **`&&` / `\|\|` → `and` / `or`** | `&&` or `\|\|` outside strings | `and` / `or` | ③ Deterministic. |
| **Double-quoted string literal → single quotes** | `"…"` used where a value is expected (e.g. `= "CA"`) | `'CA'` | ② Malloy treats `"…"` as an identifier → "not defined" error instead of a value; trivial to disambiguate. |
| **Source name → lowercase** | `source: NATION is …` | `source: nation is …` | ③ The "correct casing" example — overkill to compile for. [REPO: `source_name_casing`] |
| **`#` used as a comment → `//`** | `#`/`##` starting a prose line intended as a comment | `//` | ② Compiler **silently** treats `#` as an annotation that attaches to the next object — no error at all, so only a linter catches it. |
| **`count(*)` / `count(distinct x)`** *(optional)* | `count(\s*\*\s*)` / `count(\s*distinct\b` | `count()` / `count(x)` | ③ Trivial pre-pass; *or* just apply the compiler's `replacement` for these (it ships one) — only worth pre-fixing to cut an iteration. |

---

## Deferred to the compiler (deliberately NOT in this linter)

These are caught by the compiler with clear `code`s and/or `replacement`s — reimplementing them is rebuilding the
compiler. **Just compile and read `model.problems`** (apply any `replacement`, surface the rest by `code`):

- Expression-slot/type: `aggregate-in-dimension`, `scalar-in-measure`, `group-by-aggregate`, `aggregate-of-scalar`,
  `select-of-aggregate`, unnamed computed fields (`output-name-conflict`).
- Query structure: `select:` mixed with `group_by:`/`aggregate:`, `aggregate-in-where` (use `having:`), window fns →
  `calculate:`, `ambiguous-view-type`, `all()`/`exclude()` arg grouping.
- Expressions/types: `CASE`→`pick`, `CAST`→`::`, `@` date literals, `IN`→alternation, `concat`, `~`/`!~`,
  `function-not-found`, `case-insensitive-function`.
- Aggregate locality / fan-out (`aggregate-traverses-join-many`, `bad-join-usage`) — needs join-graph semantics.
- Most M4 deprecation rewrites — they ship a `replacement`; apply it rather than re-detecting.
- Field/source existence beyond simple casing — requires a live schema fetch, which the compiler already does.

---

## Where it sits in the loop

```
generate Malloy
   │
   ▼
THIS pre-pass:  Group 1 (reorder) → Group 2 (catalog fixes) → Group 3 (text rewrites)   ← deterministic, no compile
   │
   ▼
compile (noThrowOnError) → model.problems[]
   │
   ├─ has replacement?  → apply automatically
   └─ else              → re-prompt LLM with code + errorTag + range
```

**Rule of thumb for adding anything later:** if you can fix it from the text + catalog alone, with no judgment about
Malloy semantics, and the compiler either can't deduce it / errors unhelpfully / it's a one-liner — it goes here.
Otherwise it's the compiler's job.
