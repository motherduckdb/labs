# agentic-malloy

Experiment: is a **Malloy semantic layer** a more token-efficient, more reliable
substrate for a data model than the **markdown + SQL context** baseline
(`../agentic-sql-claude-edition`), on the DABstep benchmark — while holding accuracy
at or above that baseline?

Same data, same eval (26-question train set, ~419 held-out). The only thing that
changes is the knowledge substrate: a central Malloy model (one source per entity)
plus per-query Malloy authored by the agent. **The answer is submitted as Malloy**;
SQL is for exploration only. Both ends are deterministic, so the Malloy→SQL
translation is checkable.

Full plan (phases, metrics, decisions): see the approved plan doc shared separately.
This is **Node / TypeScript** (Malloy's native runtime).

## Status — Phase-0 gate cleared

The two riskiest unknowns are proven with running code:

- **Malloy runs in-process.** `@malloydata/malloy` + `@malloydata/db-duckdb` compile
  Malloy → SQL (`getSQL()`) and execute against a local DuckDB. No sidecar.
- **The hard fee logic is expressible in Malloy.** The 9-dimension wildcard fee match
  (list columns where empty-list/NULL = wildcard, *all* matching rules sum) compiles
  and runs to **29.93 — the gold answer for task 1711**.

Key Malloy finding: DuckDB list functions need the raw-escape with a return-type
annotation, e.g. `len!number(fees.aci) = 0` and `list_contains!boolean(fees.aci, aci)`;
the match is a `join_many` with a boolean `on:`.

## Layout

```
src/load.ts        # builds data/dabstep.duckdb from the DABstep CSVs (local; for Malloy compile)
src/spike.ts       # proof: Malloy compile+run in-process
src/spike-fees.ts  # proof: 9-dim wildcard fee match → 29.93 (task 1711)
data/dabstep/      # DABstep sources + tasks (copied from the baseline)
malloy/            # the semantic layer (model-authored; being built)
```

## Run the proofs

```bash
npm install
npx tsx src/load.ts         # builds data/dabstep.duckdb (gitignored)
npx tsx src/spike.ts        # compile + run a trivial Malloy query
npx tsx src/spike-fees.ts   # reproduce task 1711's 29.93 via a Malloy fee match
```

## Substrate

Exploration (MotherDuck MCP tools) and the scored Malloy answer both execute on
**MotherDuck** — same substrate as the baseline. Malloy compiles against a **local
DuckDB** built from the same CSVs, used only for schema introspection and the
translation-check; execution never happens locally.

## What's next (Phase 1)

MCP client + exploration tools, controllog wiring, the two-model author→fixer loop,
a Python scoring sidecar (vendors the baseline's `score.py`), the Malloy file store +
linter, then a **model-authored** `layer-build` pass → drive the train set to 26/26.
