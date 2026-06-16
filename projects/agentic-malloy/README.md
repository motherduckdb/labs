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

## Run it

```bash
npm install
cp .env.example .env        # add OPENROUTER_API_KEY + MOTHERDUCK_TOKEN

# Phase-0 proofs (no credentials needed):
npx tsx src/load.ts         # builds data/dabstep.duckdb (gitignored)
npx tsx src/spike.ts        # compile + run a trivial Malloy query
npx tsx src/spike-fees.ts   # reproduce task 1711's 29.93 via a Malloy fee match

# Harness (needs credentials; executes on MotherDuck via MCP):
npx tsx bin/asm-malloy.ts load              # build the local compile DB
npx tsx bin/asm-malloy.ts malloy-preflight  # compile + local run sanity check
npx tsx bin/asm-malloy.ts evaluate --task-id 1711 --author sonnet --fixer opus
npx tsx bin/asm-malloy.ts evaluate --split templates --run-class official
npx tsx bin/asm-malloy.ts summary results/<file>.jsonl
```

`evaluate` runs the two-model author→fixer loop, explores via MotherDuck MCP,
executes the compiled Malloy answer on MotherDuck, scores via the Python sidecar,
and writes `results/*.jsonl` + `results/controllog/{events,postings}.jsonl`.
Defaults to the baseline's MotherDuck DB (`agentic_sql_claude`) so no separate
build is needed.

## Substrate

Exploration (MotherDuck MCP tools) and the scored Malloy answer both execute on
**MotherDuck** — same substrate as the baseline. Malloy compiles against a **local
DuckDB** built from the same CSVs, used only for schema introspection and the
translation-check; execution never happens locally.

## Harness status

End-to-end harness wired and unit-verified (all but a live eval, which needs
credentials): Malloy runtime, MotherDuck MCP client, two-model author→fixer loop,
Python scoring sidecar (vendors `score.py`), Malloy file store + linter, controllog
emitter, and the CLI (`load` / `malloy-preflight` / `evaluate` / `summary`).

## What's next

`layer-build` is wired (`asm-malloy layer-build --model opus`): an expensive-tier
model reads the manual + 26 train Q/A + schema and writes the real `malloy/` layer,
then it's compile-validated with a repair loop. Needs a key to run.

- Run `layer-build` to author the real layer (current `payments_base.malloy` is
  throwaway/smoke), then first live `evaluate` → iterate to 26/26 on the train split.
- Phase 2 (optimization) + Phase 3 (held-out) per the plan.
