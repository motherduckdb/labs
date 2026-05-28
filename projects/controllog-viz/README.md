# controllog-viz

Static HTML views for [controllog](../controllog) datasets. Reads the universal
`events` + `postings` schema — from local JSONL **or** MotherDuck, through one DuckDB
layer — and renders two self-contained pages:

- **review** — one run. If the run contains `evaluation_result` events, it renders the
  full **evaluation review**: question-by-question cards, a chain-of-thought conversation
  explorer (system/user/thinking/tool-call/result, both OpenAI Chat-Completions and
  Responses-API formats), top-level filters (status / model / tier / category), a stats
  bar, per-question comment export, expand/collapse, and `e`/`c` keyboard shortcuts —
  feature-for-feature parity with agentic-sql's review. Any other run falls back to a
  universal view (stats, invariant badge, event timeline with collapsible JSON payloads,
  postings detail).
- **dashboard** — all runs: a runs table, cost/latency/utility trend charts, per-run
  event-kind stacked bar, and a global trial-balance (invariant) panel.

There is **no domain-specific code**: payloads render generically and postings roll up
dynamically by `(account_type, unit)`. Any controllog dataset works out of the box.

## Install

```bash
pip install "controllog-viz @ git+https://github.com/motherduckdb/labs#subdirectory=projects/controllog-viz"
```

## Usage

`--source` is a JSONL file, directory, or glob, or `md:<database>` for MotherDuck
(token via `MOTHERDUCK_TOKEN`).

```bash
# Cross-run dashboard from local logs
controllog-viz dashboard --source logs/ -o out/dashboard.html --open

# Review the most recent run
controllog-viz review --source logs/ --latest -o out/review.html

# Review a specific run from MotherDuck
controllog-viz review --source md:my_db --run-id run-2026-05-26
```

A directory or glob resolves recursively to `**/events.jsonl` and `**/postings.jsonl`,
so it works with both flat (`logs/controllog/events.jsonl`) and date-partitioned layouts.

## How it works

| Layer | File | Responsibility |
|-------|------|----------------|
| Reader | `reader.py` | `connect(source)` → in-memory DuckDB with `events`/`postings` temp views, normalized identically for JSONL and MotherDuck. |
| Queries | `queries.py` | Derived SQL (runs, timeline, kind counts, postings rollup, trial balance) returning `list[dict]`. The semantics layer. |
| Render | `render.py` | Presentation only — consumes rows, emits self-contained HTML. Dispatches the review to the rich or universal renderer. |
| Eval review | `eval_review.py` | Rich evaluation review built from `evaluation_result` payloads (cards, conversation explorer, filters). |
| CLI | `cli.py` | `review` / `dashboard` commands. |

## Develop

```bash
uv run --extra dev pytest
```
