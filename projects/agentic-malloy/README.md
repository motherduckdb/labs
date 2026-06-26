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
npx tsx bin/asm-malloy.ts usage-report results/<file>.jsonl   # substrate-value metrics (read-only, local)
```

`usage-report` aggregates a completed run into the substrate-value metrics:
answer-path economics (view-selection / authored-malloy / sql), **share-of-logic**
(authored Malloy chars / authored Malloy+SQL chars), central-vs-per-query Malloy size
+ Malloy→SQL expansion, **view utilization** (how many layer views are actually
reused), and the answer-time context-token breakdown. `--json <path>` writes the
report object. Read-only and local — no MCP/eval spend.

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

## Layer provenance & the official gate (do NOT hand-edit the layer)

The experiment's claim is that the Malloy layer is **model-authored**. To keep that
honest:

- `layer-build` writes `malloy/.provenance.json` (`malloy_provenance: "model_authored"`,
  `malloy_model_hash`, `manual_included`, `authoring_model`, `built_at`).
- `evaluate --run-class official` **fails fast** unless that marker exists, says
  `model_authored`, AND the on-disk layer still hashes to the recorded
  `malloy_model_hash`. A hand-edit breaks the hash → the run is refused.
- **Never hand-edit `malloy/models/*` to improve answers.** If the layer misses
  questions, change the `layer-build` prompt / `skill.md` / `layer-build.ts` and
  **rerun `layer-build`** — then re-run `evaluate`. Hand-edits make the run
  `human_edited` and disqualify it from the official 26/26.

## `layer-improve` — targeted, model-driven layer repair (stays model_authored)

`asm-malloy layer-improve --from results/<run>.jsonl` is the MODEL-driven (never
human) complement to the rule above: it triages a run's misses and edits the layer
**only** for genuine structural defects, keeping provenance `model_authored`.

- **Triage (the hard part).** For each `is_correct:false` row it re-runs the
  submitted Malloy through the runtime and smoke-runs each named layer view it
  referenced. A pure classifier (`classifyMiss`) decides, from that evidence alone:
  a NAMED layer view that errors / is wrongly empty on its own ⇒ **layer** defect;
  a query that re-runs fine but returns the wrong rows ⇒ **skill** (the agent's
  inline filter/field/grain); no submission ⇒ **answering** (turn budget). A layer
  EDIT requires BOTH this structural probe AND a model verdict of `layer`.
- **Manner of failure (from the logs).** It correlates the run to its controllog
  (by `(task_id, submitted Malloy)`), pulls each miss's **tool trace**, and a model
  verdict labels *how* it failed — `overspecified` · `underspecified` ·
  `hallucination` · `layer_not_used` (the right view existed but the agent
  hand-wrote raw Malloy) · `wrong_logic` · `gave_up` — with a recommended fix
  (`skill` / `linter` / `layer` / `model`). The answer **shape** (scalar vs. list
  vs. bracketed-list) and "did it reuse a named view" feed over/under-specification
  reasoning — all gold-free (`--no-manner` restores the cheap deterministic-only path).
- **Tool-error meta-analysis.** It aggregates the run's per-tool error rate; any
  tool over **15%** (`--tool-error-threshold`) gets a model diagnosis of the
  *systemic* cause + where the durable fix belongs. A layer-cause routes into the
  repair path (only if a view is actually broken); skill/linter causes become
  precise recommendations. A diagnosed `skill` rule is **recommend-only by default**;
  `--apply-skill-fixes` (opt-in) appends it to a marked section of `src/skill.md` so a
  default run never mutates a tracked file. The skill is a tunable prompt, not the
  layer, so this never touches `malloy_provenance` — but because it's still an
  uncommitted prompt change, an `evaluate --run-class official` **refuses to run on a
  dirty tracked tree** (commit first), so an official number can't be scored on it.
- **No leakage.** A repair prompt sees only the failing Malloy, exec diagnostics,
  "this view returns 0/errors", the column profile, and the manual — **never the
  gold answer**, and it must not tune to a train value. Fixes are general
  (join scope, wildcard/domain handling, grain), exactly like `layer-build`.
- **Train-only edits.** A layer edit (and a skill-fix application) is **refused**
  when ANY task in the `--from` run (passers included, not just the misses) is
  outside the train split — checked against `data/split.json`, not the row's
  recorded split. The full-run check matters because the tool-error meta-analysis
  spans every row, so a held-out passer's trace must not influence a write. Such
  runs are triaged/reported only.
- **Don't regress.** Edits are minimal atomic `{old,new}` patches, re-validated by
  the same P0 gate (compile + execute every view). If the post-edit all-views gate
  fails, **every edit is rolled back** and provenance is left untouched.
- **Honest / idempotent.** When no miss is a structural layer defect (the common
  case — the current layer is clean), it edits nothing, leaves the hash/provenance
  untouched, and reports where each fix belongs (skill / prompt / model-capability).
  On a successful edit it re-hashes, re-stamps `model_authored` with an
  `improve_lineage` (from/to hash, round, edited files, source run), and emits a
  controllog build run. `--re-eval` then re-runs the same task-ids to measure —
  always as a **smoke** run (the just-edited layer/skill is uncommitted, and an
  official run requires a clean tree), so commit the edits and run
  `evaluate --run-class official` separately to record an official number.

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
