# eval-connections-mini

Evaluate AI models on NYT Connections puzzles. Built for the Seattle Startup Summit evals workshop.

## Setup

Install [uv](https://docs.astral.sh/uv/getting-started/installation/) if you don't have it:

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
```

Then install dependencies and set your API key:

```bash
uv sync
export OPENROUTER_API_KEY="sk-or-..."
```

Get an API key at [openrouter.ai/keys](https://openrouter.ai/keys).

## Run an eval

```bash
uv run eval run -m gemini-3-flash -p 5
```

This runs 5 puzzles against Gemini 3 Flash and prints solve rate, tokens, cost, and time.

### Free tier

Three free models are included for anyone who doesn't want to add credits to OpenRouter. They work, but they're slow (~10 min per puzzle vs ~10 sec for Gemini Flash):

```bash
uv run eval run -m step-3.5-flash -p 1
uv run eval run -m qwen3.6-plus -p 1
uv run eval run -m nemotron-3-super -p 1
```

## Compare models

Use `--seed` so every model gets the same puzzles in the same order:

```bash
uv run eval run -m gemini-3-flash -p 5 -s 42
uv run eval run -m gpt5.4-mini    -p 5 -s 42
uv run eval run -m haiku-4.5     -p 5 -s 42
```

See all available models with `uv run eval list-models`.

## Analyze the results

Running evals is step 1. You have to actually look at the data.

```bash
# Leaderboard + puzzle difficulty + cost breakdown
uv run analyze.py

# Game-by-game replay: see each guess and result
uv run analyze.py --replay

# Replay with model reasoning visible
uv run analyze.py --thinking

# Double-entry accounting (trial balance should be zero)
uv run analyze.py --controllog
```

The `--thinking` view is where evals get interesting. You can read the model's reasoning and see exactly where it went wrong. The aggregate numbers tell you which model is best. The thinking tells you why.

## How it works

Two files to understand:

**`src/connections_eval/core.py`** is the eval engine. OpenRouter API calls, JSONL logging, game loop, guess processing. All in one file, top to bottom.

**`src/controllog/__init__.py`** is the telemetry library. Every API call is recorded as balanced double-entry postings. Tokens, time, and money all net to zero -- verifiable with the trial balance.

The game rules are split between the **prompt** and the **engine**:

- The prompt tells the model how to play, what format to respond in, and how many mistakes remain
- The engine validates guesses, checks for correct groups, detects one-away, tracks mistakes, and auto-solves the last group

Deterministic logic goes in the engine. Everything else goes in the prompt.

## Data files

- `inputs/puzzles.yml` -- 5 NYT Connections puzzles from March 2026
- `inputs/models.yml` -- models and their OpenRouter IDs
- `inputs/prompt_template.xml` -- game rules and response format

All editable. Add models by putting their OpenRouter ID in `models.yml`. Add puzzles by following the YAML format.

## Project structure

```
eval-connections-mini/
├── src/
│   ├── connections_eval/
│   │   ├── __init__.py         # package version
│   │   ├── core.py             # API + logging + game engine
│   │   └── cli.py              # CLI (run, list-models, list-puzzles)
│   └── controllog/
│       └── __init__.py         # telemetry: events + balanced postings
├── inputs/
│   ├── puzzles.yml             # 5 puzzles
│   ├── models.yml              # model configs
│   └── prompt_template.xml     # game rules + response format
├── tests/
│   └── test_core_invariants.py # game engine tests
├── logs/                       # created at runtime (gitignored)
├── analyze.py                  # DuckDB analysis
├── analyze.sql                 # raw SQL for exploration
├── pyproject.toml
└── README.md
```

## Extending

Replace the game with your task. The structure stays the same: a prompt template, an engine that validates responses, and controllog to track what happened. Run it every time you change the prompt.

---

## Reference

### CLI commands

| Command | Description |
|---------|-------------|
| `uv run eval run -m MODEL -p N` | Run N puzzles against MODEL |
| `uv run eval run -m MODEL -p N -s SEED` | Same, with fixed seed for reproducibility |
| `uv run eval list-models` | Show available models and their OpenRouter IDs |
| `uv run eval list-puzzles` | Show available puzzles with difficulty ratings |

### Analysis commands

| Command | Description |
|---------|-------------|
| `uv run analyze.py` | Model leaderboard, puzzle difficulty, cost breakdown |
| `uv run analyze.py --replay` | Game-by-game replay with guesses and results |
| `uv run analyze.py --thinking` | Replay with model reasoning visible |
| `uv run analyze.py --controllog` | Controllog token/cost accounting and trial balance |

### Available models

| Name | Provider | OpenRouter ID | Free? |
|------|----------|---------------|-------|
| gemini-3-flash | Google | `google/gemini-3-flash-preview` | |
| gpt5.4-mini | OpenAI | `openai/gpt-5.4-mini` | |
| haiku-4.5 | Anthropic | `anthropic/claude-haiku-4.5` | |
| step-3.5-flash | StepFun | `stepfun/step-3.5-flash:free` | Yes |
| qwen3.6-plus | Qwen | `qwen/qwen3.6-plus-preview:free` | Yes |
| nemotron-3-super | NVIDIA | `nvidia/nemotron-3-super-120b-a12b:free` | Yes |

Add more by editing `inputs/models.yml` with any [OpenRouter model ID](https://openrouter.ai/models).

### Puzzles

5 NYT Connections puzzles from March 27-31, 2026 (#1020-#1024). Add more by editing `inputs/puzzles.yml`.

### Dependencies

- Python 3.12+
- [uv](https://docs.astral.sh/uv/) package manager
- [OpenRouter](https://openrouter.ai) API key

### Log format

Eval logs are written to `logs/` as JSONL. Each file contains `exchange` records (per-guess detail) and a `summary` record (run totals). Controllog telemetry is written to `logs/controllog/YYYY-MM-DD/` as balanced events and postings.

All log data is queryable with DuckDB:

```sql
SELECT * FROM read_json_auto('logs/connections_eval_*.jsonl')
WHERE message = 'exchange' LIMIT 10;
```

See `analyze.sql` for more query examples.
