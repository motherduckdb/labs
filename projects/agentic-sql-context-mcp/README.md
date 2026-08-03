# agentic-sql-context-mcp

A single-setup agentic-SQL system for the **DABStep** benchmark, built around two
ideas from Anthropic's *self-service data analytics* work — with the agent's
tools swapped from local hand-built ones to the **MotherDuck context MCP**:

1. **A compact skill** (`skill/SKILL.md`) injected into the system prompt — it
   teaches the agent *how* to work and *where* knowledge lives, not the knowledge
   itself.
2. **A semantic layer via MotherDuck guides** — domain knowledge (fee matching,
   bucketing, terminology, SQL patterns, answer formatting) lives as guides on
   the MotherDuck MCP server, grouped under six `dabstep/<domain>` topics that
   are pre-seeded in the skill, and is fetched progressively:
   `list_guides(topic)` → the topic's guides with uuids and one-line
   descriptions → `get_guide(uuid)` for one item's full body. The agent loads
   only what each question needs, and data access (`list_tables`,
   `list_columns`, `query`) runs against the same MCP server instead of an
   in-process DuckDB connection.

Target: **100% on the 26 template-representative questions** (one per DABStep
template T01–T26; `train_ids` in `data/split.json`).

## Results

This fork: **417/419 (99.5%)** on the cleaned full test set, with
`gemini-3-flash` at `--reasoning low`, for **~$8.57** per run
(~$0.020/question).

The baseline it aims to match (from `agentic-sql-claude-edition`, the
hand-built local-tools version this project was copied from):
**419/419 (100%)** on the same set and model, for **~$7.91** per run
(~$0.019/question).

- **Set:** all 450 DABStep questions minus the 26 template reps (= 424 held-out)
  minus **5 provably-wrong `hf_consensus` golds** set aside in `data/bad_golds.json`
  (our SQL is correct; those golds disagree with the data — verified) → **419**.
- **Approach:** a compact always-on skill + a 27-item semantic layer published as
  MotherDuck guides under `dabstep/` and fetched via `list_guides`/`get_guide`.
  The whole knowledge base is ~53K chars but the agent loads only ~16K per hard
  question — the *always-on* prompt is ~3.4× smaller than injecting the manual.
- **Reasoning sweet spot:** `low` matches `medium` accuracy at ~half the cost; `off`
  is cheapest (~$7.3) but shows ~1% scattered adherence variance.

What it took to get there (per-template error analysis in `docs/error-fixes.md`):
- Correct, generalizing SQL for the hard fee families — 9-dimension fee matching
  (NULL/empty = wildcard, all rules sum), the T08/T17 fraud-ACI steering misread
  (it's ACI steering, not card-scheme — the guideline is mislabeled), `is_credit`
  strictness, AVG-over-wildcards for "most expensive MCC", the T01 "loses-the-fee"
  inversion, `capture_delay` `immediate`/`manual` handling.
- Customer/shopper rules: a customer is a NON-NULL email; "per shopper" vs "% of
  transactions" differ; honor an explicit basis ("based on IP" → `ip_address`).
- **The core lesson:** high-leverage rules must live in the *always-on* skill, not
  fetch-gated context items — otherwise a low/no-reasoning model skips them.

See **[docs/how-it-works.md](docs/how-it-works.md)** for diagrams of the runtime
answer flow and the log-driven improvement loop.

## How a question flows

```
system prompt + SKILL + question
  → list_guides(topic="dabstep/fees")   # a domain topic's guides: uuid + description
  → get_guide(uuid)                     # full guide body, as needed
  → list_tables / list_columns          # explore schema (MCP)
  → query (verify SQL, via MCP)
  → submit_answer                              # the SQL whose result IS the answer
```

## Stack

- Agent loop: `openai-agents` SDK → **OpenRouter**, default model
  `google/gemini-3-flash-preview` (the skill + semantic-layer context are designed
  to let a cheap, fast model do well; `--model opus/sonnet/...` to switch).
  Anthropic models get prompt-cache breakpoints automatically.
- Reasoning: default **`--reasoning low`** — the cost/accuracy sweet spot here.
  `off` is cheapest but shows ~1% scattered adherence variance; `low` matches
  `medium` accuracy on this skill at roughly half the cost; `medium`/`high` are
  available for harder models/tasks.
- Data + semantic layer: the **MotherDuck context MCP server** (`src/mcp_client.py`).
  Data access (`list_tables`, `list_columns`, `query`) and the semantic layer
  (`list_guides`, `get_guide`) are both MCP tools at agent runtime — no
  in-process DuckDB connection, no local `semantic_lookup` store.
- Logging: `controllog` double-entry events/postings; inspect with `controllog-viz`.
- Scoring: the strict DABStep scorer (`src/score.py`, verbatim port).

## Setup

```bash
uv sync
cp .env.example .env   # fill in OPENROUTER_API_KEY and MOTHERDUCK_TOKEN
```

## Usage

```bash
# 1. Build the MotherDuck database from data/dabstep/context/
uv run asm load

# 2. Publish the 27-item semantic layer as MotherDuck guides under dabstep/
uv run asm guides-load

# 3. Run the agent. Defaults: model gemini-3-flash, reasoning low, concurrency 15.
uv run asm evaluate --watch                 # 26 template reps (default split)
uv run asm evaluate --split test            # 419 held-out (5 bad golds set aside)
uv run asm evaluate --split all             # 445 (450 minus the 5 bad golds)

# 4. Summarize a results file (shows the misses)
uv run asm summary results/templates_<ts>.jsonl

# 5. Visualize a run. controllog-viz is a standalone CLI (it caps duckdb at
#    1.5.2, so it runs in its own environment, not this project's). It reads the
#    JSONL under results/. `review` shows the rich per-question trace cards
#    (chain-of-thought + every list_guides/get_guide/query/submit_answer call, predicted
#    vs gold) — driven by the `evaluation_result` events the eval emits.
uvx --from "git+https://github.com/motherduckdb/labs#subdirectory=projects/controllog-viz" \
    controllog-viz review --source results --latest --open -o review.html
uvx --from "git+https://github.com/motherduckdb/labs#subdirectory=projects/controllog-viz" \
    controllog-viz dashboard --source results --open -o dashboard.html
```

### Agentic Company benchmark profile

The same evaluation loop can run the 40-question Agentic Company DABstep set. It reads the
canonical `questions.jsonl` and `manual.md` from the adjacent `the-agentic-company` repository;
it does not copy them into this project. By default that repository is resolved as
`../../../the-agentic-company` from this project (set `AGENTIC_COMPANY_REPO` to override it).
The v0.3.1 manifest contract and exact question/manual hashes are validated before model spend.

Only `manual.md` is published as model context. The architecture documents and private semantic
contracts are never published or added to a prompt. The guide is personal (`access=user`): the
fixed topic acts as the registry, so each MotherDuck principal creates or updates exactly one
manual without committing a principal-specific UUID. Do not run the first publish concurrently
from two processes; a duplicate is detected and must be cleaned up before evaluation.

```bash
# Preview, then publish exactly one guide at agentic-company/manual.
uv run asm guides-load --benchmark agentic-company --dry-run
uv run asm guides-load --benchmark agentic-company

# The profile attaches the configured read-only MotherDuck share as
# agentic_company_snapshot at the start of each MCP session.
uv run asm evaluate --benchmark agentic-company --task-id AC-002 --watch
uv run asm evaluate --benchmark agentic-company --split all
```

The Agentic profile keeps concurrency, retries, OpenRouter routing, tool traces, controllog events,
JSONL results, and summaries on the existing harness. Its additions are profile-specific: a
multi-schema prompt/skill, the single manual guide, trusted share attachment, filtering/blocking of
the private `ground_truth` and `sim` schemas, and strict scoring from each task's
`answer_criteria`. DABstep remains the default profile and retains its existing scorer and split
behavior.

The supplied share still physically contains `ground_truth` and `sim`. The client hides them from
table discovery and rejects explicit schema references, metadata enumeration, and dynamic table
lookup as benchmark-integrity defenses. For a warehouse-enforced security boundary, publish a
sanitized share that omits those schemas entirely.

Before model spend, the profile also scans all 68 public relations and compares a deterministic
row-count/content fingerprint with the canonical local database. This detects data changes behind
the stable share URL instead of treating the snapshot cutoff as proof of database identity.

## Iterating toward 100%

Each miss points at one of four artifacts to fix, then re-run:
- a missing/weak **context item** (`context/items/*.md`),
- a wrong **SQL pattern**,
- an **answer-format** slip,
- a **skill-navigation** gap (`skill/SKILL.md`).

`controllog-viz review` renders the full tool-call trace (including
`list_guides`/`get_guide` navigation) and predicted-vs-gold for diagnosis.

## Layout

```
skill/SKILL.md          the skill (procedure + navigation)
context/items/*.md      the semantic-layer source (one file = one item; published as guides)
src/mcp_client.py       MCP session + tool-call plumbing (query/schema/guides)
src/agent.py            tools + prompt + OpenRouter provider
src/agentic_company_profile.py  Agentic artifact contract, preflight, and profile policy
src/agentic_company_score.py    strict criteria-driven Agentic Company scorer
src/load.py             build the MotherDuck database
src/run.py              CLI: load / guides-load / evaluate / summary
src/score.py            DABStep scorer (verbatim)
data/dabstep/           source CSV/JSON + manual + all.jsonl (gold)
data/split.json         the 26 template train_ids
```
