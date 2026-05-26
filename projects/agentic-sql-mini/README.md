# agentic-sql-mini

Minimal A/B harness for the **catalog-context-for-agents** experiment.

> **Can descriptive column names alone replace prose docs as an agent's information source?**

Two arms, same data, same model. The only difference is column names. No `manual.md` or other prose in the system prompt for either arm.

| Arm | Schema |
|---|---|
| `baseline` | `table_1` / `column_a` placeholders |
| `explicit` | Hand-tuned, descriptive table + column names |

## Headline (DABstep test set, n=418, medium reasoning)

| Arm | Accuracy | Cost | Hit-limit | Avg turns |
|---|---|---|---|---|
| baseline | 47/418 = 11.2% | $29.30 | 26% | 30.5 |
| **explicit** | **205/418 = 49.0%** | **$23.26** | **4%** | **17.5** |

**+37.8 pp.** Explicit is 4.4× more accurate and $6 cheaper. By difficulty: easy 43% → 72%, hard 5% → 44%.

See [`training_results.md`](training_results.md) for the full V1–V5 result history, reasoning-ladder variance reps (3× each), and per-question stability numbers.

## Setup

```bash
uv sync
cp .env.example .env  # add OPENROUTER_API_KEY
```

For an end-to-end walkthrough that verifies every layer (data load → splits → scorer → agent → both arms), see [`TESTING.md`](TESTING.md).

## Run

```bash
# 1. Build the two DuckDB files
uv run asm load --arm baseline
uv run asm load --arm explicit

# 2. Smoke 5 train questions per arm
uv run asm evaluate --arm baseline --split train --limit 5 --reasoning medium
uv run asm evaluate --arm explicit --split train --limit 5 --reasoning medium

# 3. Full train (36 Q) at concurrency 16
uv run asm evaluate --arm baseline --split train --concurrency 16 --reasoning medium
uv run asm evaluate --arm explicit --split train --concurrency 16 --reasoning medium

# 4. Held-out test set (418 Q) — sequential is safer to stay under OpenRouter's 450 RPM
uv run asm evaluate --arm baseline --split test --concurrency 16 --reasoning medium && \
uv run asm evaluate --arm explicit --split test --concurrency 16 --reasoning medium

# 5. Compare two result files
uv run asm compare results/baseline_test_*.jsonl results/explicit_test_*.jsonl

# Inspect a saved trace for a specific task across both arms
uv run python _trace.py 5
```

Per-question JSONL writes to `results/`. The agent loop runs at `--concurrency N` via a single shared httpx client and per-task `contextvars` for usage tracking — no rate-limit fan-out, no leaked sessions. The OpenAI SDK's `max_retries=8` handles 429 bursts.

## Findings worth knowing

- **Naming replaces prose.** With `manual.md` stripped from the prompt, descriptive names alone get 49% on test vs 11% on placeholders. Same agent, same model.
- **Recovery loop matters.** If `Runner.run` finishes without a `submit_answer` call, the agent gets one forced retry round with prior context. Cut hit-limits from ~25% to ~4% on explicit.
- **Reasoning curve is unimodal.** Medium beats both low and high on the train slice (3 reps each). High overthinks edge cases the schema already covers.
- **n=36 is noisy.** ~22% of questions flip between runs at the same config (temperature=0). Single-run claims need ≥3 reps; n=418 smooths this out.

## Layout

```
data/
  split.json             # 36 train (26 templated + 10 dabstep dev) / 418 test
  dabstep/               # raw context files + tasks
schemas/
  baseline.sql           # generic-name DDL
  explicit.sql           # hand-tuned-name DDL (edit this)
src/
  score.py               # verbatim DABstep scorer port
  agent.py               # 4 tools, recovery loop, shared OpenRouter client
  load.py                # apply schema SQL
  run.py                 # CLI: load / evaluate / summary / compare
_trace.py                # render saved tool_calls for one task across both arms
results/                 # JSONL output (gitignored)
training_results.md      # V1–V5 history, distributions, file index
```

## Out of scope

Everything that isn't isolating naming: prose docs in the prompt, comments, views, macros, semantic layers, RAG, multi-agent, fragments, self-scoring, learning loops.

Inspired by [`agentic-sql`](https://github.com/motherduckdb/agentic-sql) but stripped to just this experiment. The DABstep scorer (`src/score.py`) is a verbatim port — every rule and edge case from upstream is preserved.
