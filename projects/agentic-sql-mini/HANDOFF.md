# agentic-sql-mini — handoff

**Status:** Two pivots deep. The original V1 (naming axis, manual.md in prompt for both arms) ran and lost. We then proposed a "raw vs modeled schema" pivot, *still* keeping manual.md in the prompt. Boss pushed back: that's still not a clean test of whether the schema can stand on its own. **Current framing: no prose docs in the system prompt at all. Schema is the only context.** The experiment is now "can dbt-style modeling encode enough business logic to make a downstream agent successful with zero prose documentation?"

Read this whole file before touching code.

---

## TL;DR of where we are

- V1 ran 36-Q train: baseline `column_a..column_t` placeholders **44.4%**, explicit (descriptive renames + `applies_to_*` prefixes) **33.3%**. −11.1 pp regression. Naming hypothesis is dead.
- Diagnosis (independently confirmed by reading regression SQL on tasks 1273, 1593, 1744, 2767): the `applies_to_*` prefixes acted as imperatives, pushing the model toward over-precise rule-applicability SQL when the gold answers reward naive aggregation. Both arms had manual.md available, so naming added no information — only bridging cost and over-precision pressure.
- New axis: **schema modeling, with no prose docs**. Two arms:
  - `raw` — DABstep tables, original column names (`payments`, `fee_rules`, `aci`, `rate`, `eur_amount`, `intracountry`, etc.), no aliasing, no placeholders.
  - `modeled` — same data plus dbt-style materializations: denormalized merchant attrs onto transactions, pre-computed `transaction_date`/`transaction_month`, monthly fraud/volume buckets, materialized `fee_applicability` and `transaction_fees` tables.
- **Manual.md and payments-readme.md are no longer in scope.** They've been removed from `agent.py`'s system prompt. Both arms see only the DDL + sample values that the 4 tools surface.
- Agent already does `agent.py:281` cap of 50 rows on `query`, so naive `SELECT *` doesn't blow context.
- Build system: **dbt-duckdb**. Materialized tables (not views, not macros — see `## On views vs macros` below). Tool surface unchanged. Manifest.json is dev-side only, not exposed to the agent.

## What this experiment is now testing

> Can structural data modeling alone — without prose documentation — give a SQL agent enough to answer real business questions?

That's a meaningful claim about how to invest in production warehouses. If modeled wins by a wide margin over raw with no prose, it's evidence that good dbt modeling beats bolted-on docs. If modeled and raw both collapse, it's evidence that prose is load-bearing and modeling can't substitute. Either result is publishable.

Expected shape: raw arm probably collapses on fee-rule-applicability questions (the manual.md was encoding the actual rule predicates). That's fine — the wider the gap, the cleaner the signal. We're not trying to make raw look good.

## Locked decisions (don't relitigate)

- **No prose docs in the system prompt.** Period. This is the new invariant. If you find yourself wanting to add a hint about ACI / capture_delay / fraud bracketing, the answer is to encode it as a column / lookup table / materialization in the modeled arm, not as prose.
- **Local DuckDB only**, 4 tools (`list_tables`, `describe_table`, `query`, `submit_answer`). No MCP, no `ask_docs`, no column comments, no manifest exposure to the agent. Tool surface is part of the experiment's invariants.
- **Scorer (`src/score.py`) is a verbatim DABstep port** — every rule and edge case from upstream is preserved. Don't "fix" it without checking `~/code/agentic-sql/src/benchmarks/dabstep.py`.
- **Splits are frozen.** 36 train (`split.json:train_ids`) / 418 test (`test_ids`). The 10 official DABstep dev questions were merged into train (and removed from test) intentionally.
- **OpenRouter model:** `google/gemini-3-flash-preview` default. App tagged `X-Title: agentic-sql-mini`. `--reasoning medium` default. `--max-turns 40` default.
- **Build system:** dbt-duckdb. Materialized tables only. No views, no macros (rationale below).

## On views vs macros vs tables (resolved)

Considered three options for how dbt encodes modeled artifacts:

| | Views | **Materialized tables** | Macros |
|---|---|---|---|
| Build cost | 0 | once at `dbt build` | 0 |
| Query cost | recompute every call | cheap filtered scan | recompute every call |
| Visible to `list_tables`/`describe_table` | yes | yes | **no** — needs new tool |
| Forces parameterization | no | no | yes |
| Experiment cleanliness | 1 variable | 1 variable | **2 variables** (modeling + new tool affordance) |

Views are bad because cross-product fee_applicability re-computes per call (LIMIT can't always push through 8-predicate joins). Macros require expanding the tool surface to expose `list_macros`/`get_macro_source`, which means the modeled arm differs from raw on **two** axes (modeling + introspection affordance). If modeled wins, we won't know which moved the needle.

Materialized tables solve the perf concern (pay once at build) AND keep tool surface invariant. DABstep dataset is small enough that even worst-case materializations fit (post-filter fee_applicability ≈ 11M rows). Decision: `materialized: table` for everything in the modeled arm.

If a specific artifact ever proves too large to materialize, *that's* the trigger to revisit — not before. And "macros + new introspection tool" is a legitimate **next** experiment to run as a separate arm after we've isolated the pure-modeling effect.

## Repo state right now

```
agentic-sql-mini/
├── data/
│   ├── dabstep/
│   │   ├── context/        # canonical CSV/JSON + manual.md + payments-readme.md (still on disk; no longer injected)
│   │   └── tasks/          # all.jsonl (454), dev.jsonl (10)
│   └── split.json          # 36 train / 418 test
├── schemas/
│   ├── baseline.sql        # V1 generic placeholders — TO BE DELETED on pivot start
│   └── explicit.sql        # V1 descriptive renames — TO BE DELETED on pivot start
├── src/
│   ├── agent.py            # ✅ updated: SYSTEM_PROMPT no longer injects manual.md/payments-readme.md
│   ├── load.py             # applies schemas/{arm}.sql to {arm}.db — needs to be rewired to dbt
│   ├── run.py              # CLI: load / evaluate / summary / compare. --arm Choice still ["baseline","explicit"]
│   └── score.py            # DABstep scorer port (do not touch)
├── results/                # JSONL — V1 results live here; keep as evidence
├── README.md
├── TESTING.md
└── HANDOFF.md              # this file
```

`agent.py` is the only code change so far this pivot. Everything else (schemas, load.py, run.py --arm choices) is still V1 shape. Don't run anything until the dbt scaffold is in place.

## V1 evidence worth keeping

The regression SQL across tasks 1273, 1593, 1744, 2767 (read directly from `results/explicit_train_20260502T011937Z.jsonl`) shows a consistent pattern: the explicit arm builds elaborate `monthly_stats` CTEs and walks every `applies_to_*` predicate, where the baseline writes a 3-line `AVG(fixed + rate*X/10000)` and gets the gold answer. This is over-precision induced by predicate-named columns, not noise. It's why we're not just re-running V1 with cleaner schemas — the renaming axis is structurally wrong. Modeling, materialized at build time, doesn't have this failure mode because the agent doesn't have to *write* the predicate logic; it's already encoded in the table.

Result files retained:
- `results/baseline_train_20260502T001830Z.jsonl` (V1 baseline, 16/36, $3.37, 61 min)
- `results/explicit_train_20260502T011937Z.jsonl` (V1 explicit, 12/36, $3.52, 62 min)

Both still have manual.md in the system prompt. They're V1 evidence, not a new-framing baseline. **The new raw-arm baseline must be re-run from scratch** because the system prompt has changed.

## Recommended first moves for the new thread

1. **Delete V1 schemas.** `rm schemas/baseline.sql schemas/explicit.sql`. Don't try to salvage either.

2. **Add `dbt-duckdb` to `pyproject.toml`.** `uv sync`.

3. **Scaffold the dbt project** at top level:

   ```
   dbt/
     dbt_project.yml
     profiles.yml         # two targets: raw → ./raw.db, modeled → ./modeled.db
     models/
       raw/               # tag: raw
         payments.sql                  # SELECT * FROM read_csv('../data/dabstep/context/payments.csv')
         fee_rules.sql                 # read_json
         merchants.sql
         merchant_category_codes.sql
         acquirer_countries.sql
       modeled/           # tag: modeled
         stg_transactions.sql          # adds transaction_date DATE, transaction_month INT
         fct_transactions.sql          # transactions ⋈ merchant attrs (denormalized)
   ```

   All models `materialized: table`. Original DABstep column names verbatim in `models/raw/` — no aliasing, no `column_a` placeholders.

4. **Wire `src/load.py` to dbt.** `--arm raw` shells `dbt build --target raw --select tag:raw`. `--arm modeled` shells `dbt build --target modeled` (everything). Update `src/run.py`'s `--arm` Choice from `["baseline","explicit"]` to `["raw","modeled"]`.

5. **Smoke 5 train questions per arm with `--reasoning low`** (~cents) on the prototype-scope modeled arm (just `stg_transactions` + `fct_transactions`, nothing else). The question is: does even minimal denormalization + date materialization move the needle vs raw? If yes, layer in monthly fraud buckets, fee_applicability, transaction_fees iteratively. If no, regroup before adding more.

6. **Hold off on the test run.** $15–$30 + ~2 hours wall time per arm at current serial pace. Don't burn that until modeled arm is locked.

7. **Add parallelism before the test run** — design sketch in the *Performance* section below. Cuts wall time 4–8×.

## Defensible-modeled-artifact rule

A modeled artifact is fair game if it would plausibly exist in a production warehouse for **operational reasons** (fee reconciliation, monthly reporting, fraud monitoring), not just to encode benchmark answers.

- ✅ `transaction_fees` (per-transaction realized fee) — finance teams need this for reconciliation.
- ✅ `monthly_fraud_buckets` (per merchant per month, with `<7.2%` / `7.2%-7.7%` / etc. labels) — risk teams bucket exactly this way for fee-tier rules.
- ✅ `fee_applicability` (filtered tx × rule pairs, post-predicate) — needed to explain why a given transaction was charged a given fee.
- ❌ `answer_to_question_2767` — encoding the answer.
- ❌ A column called `is_in_fraud_danger` driven by manual.md prose — that's smuggling docs into schema.

When in doubt, ask: "would a real payments analytics team build this?"

## Per-question outcome matrix from V1 (n=36)

Useful to revisit when designing modeled artifacts — these are the questions the new arms have to handle.

| outcome | count | task_ids |
|---|---|---|
| both ✓ | 9 | 5, 49, 347, 1417, 1507, 1520, 1685, 2524, 2557 |
| explicit gain (E✓ B✗) | 3 | 1681, 1808, 2463 |
| explicit regression (B✓ E✗) | 7 | 1273, 1464, 1475, 1593, 1744, 2490, 2767 |
| both ✗ | 17 | 70, 1290, 1305, 1442, 1451, 1711, 1746, 1753, 1834, 1871, 2537, 2587, 2634, 2697, 2703, 2762, 2765 |

The 17 both-✗ questions are the hard ones. Most are fee-rule-applicability + counterfactual stacking. Modeled arm should specifically target these. q70 is unusual — "is Martinis in danger of getting a fine?" is a yes/no judgment that previously leaned on manual.md prose. Without the manual, it's likely unanswerable in the raw arm and only answerable in modeled if we materialize a `merchant_fraud_risk_status` column (defensible — risk teams do build this).

**Caveat:** these per-question splits were measured *with* manual.md in scope. With the new no-prose framing, the raw arm will likely collapse on more questions than V1's baseline did, including some that were "both ✓" before. Don't over-anchor on V1's exact 16/36.

## Tools / config

```bash
uv sync                              # deps
# After dbt scaffold lands:
uv run asm load --arm raw            # dbt build --target raw --select tag:raw
uv run asm load --arm modeled        # dbt build --target modeled
uv run asm evaluate --arm raw --split train         # full train
uv run asm evaluate --arm modeled --task-id 1871 --watch  # single Q, live tool calls
uv run asm summary results/raw_train_<ts>.jsonl
uv run asm compare results/raw_train_*.jsonl results/modeled_train_*.jsonl
```

`--watch` shows live tool calls, thinking blocks, turn counter `[turn N/40]`, question, gold, prediction.

Each result row has: `task_id`, `level`, `question`, `gold_answer`, `predicted_answer`, `predicted_sql`, `is_correct`, `correctness`, `hit_limit`, `tool_calls` (every tool with sql + rows + errors), `n_tool_calls`, `prompt_tokens`, `completion_tokens`, `cached_tokens`, `cost_usd`, `elapsed_s`.

## Performance: parallelism before the test run

Currently `_evaluate_loop` is serial. Sketch (cf. `~/code/agentic-sql/src/batch_runner.py`):

1. Add `--concurrency N` flag to `evaluate` (default 1).
2. Wrap per-question body in `async def bounded(q, i): async with sem: ...` and `await asyncio.gather(...)`.
3. **DuckDB safety:** open a fresh `duckdb.connect(path, read_only=True)` inside `bounded`. Per-tool `cursor()` already in place.
4. **Cost attribution:** `OpenRouterProvider.cost_usd` is a shared instance attribute — under concurrency it'd over-attribute. Move per-call accumulators into a `contextvars.ContextVar` set by a per-task wrapper.
5. **`--watch` rendering:** prepend `[task_id]` to each line so interleaved logs are tagged.

At concurrency=8, ~4–8× speedup. Test run drops from ~2 hr/arm to ~10 min/arm.

## Out of scope (still)

Column comments, schema.yml descriptions exposed to agent, views over the raw layer, macros, RAG, multi-agent, learning loops, fragment retrieval, MotherDuck MCP tools, manual.md or payments-readme.md in any form. The modeled arm is allowed to materialize anything a real ops team would build, but **the agent's context surface stays at 4 tools + DDL + 50-row samples**. That's the experiment.

---

*Last updated: 2026-05-04. agent.py SYSTEM_PROMPT no longer references manual.md or payments-readme.md (drop ~6.3K tokens from prompt). Cost-to-date this initiative ≈ $7.20.*
