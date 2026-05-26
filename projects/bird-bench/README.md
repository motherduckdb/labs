# BIRD-Bench Evaluation

Text-to-SQL evaluation framework using the BIRD Mini-Dev benchmark with MotherDuck as the execution backend.

## Prerequisites

- Python 3.11+
- [uv](https://docs.astral.sh/uv/) for dependency management
- MotherDuck account with token
- OpenRouter API key (for model access)

## Setup

### 1. Install dependencies

```bash
uv sync
```

### 2. Configure environment

Create a `.env` file:

```bash
MOTHERDUCK_TOKEN=your_motherduck_token
OPENROUTER_API_KEY=your_openrouter_key
```

### 3. Download and prepare data

The BIRD benchmark data is not included in the repository. Run these scripts to download and prepare it:

```bash
# Download BIRD Mini-Dev dataset from HuggingFace
uv run python -m src.data_prep

# Download the SQLite databases (required for gold SQL validation)
# This creates mini_dev_data/ directory (~500MB)
uv run python -c "from datasets import load_dataset; load_dataset('birdsql/bird_mini_dev', trust_remote_code=True)"
```

This will create:
- `data/bird_challenging_100.json` - Benchmark questions

### 4. Load data into MotherDuck

The databases need to be loaded into MotherDuck. See the MotherDuck documentation for loading SQLite databases.

## Running Evaluations

```bash
# Run evaluation with a specific model
uv run python -m src.run_eval --model=gemini-flash-3 --limit=10

# Run on random sample
uv run python -m src.run_eval --model=gemini-flash-3 --random-sample=50

# Run all models
uv run python -m src.run_eval --all --limit=10
```

Available models:
- `gemini-flash-3` - Gemini 3 Flash
- `claude-opus-4.5` - Claude Opus 4.5
- `gpt-5.2` - GPT-5.2

## CLI Quick Reference

| Command | Configs (take values) | Flags (boolean) | Notes |
|---------|----------------------|-----------------|-------|
| `setup` | `--config=a/b/c` | `--drop` | Set up database configs |
| `sample` | `--ratio=N`, `--seed=N` | - | Generate train/test split |
| `train` | `--models=X`, `--configs=a,b,c`, `--concurrent=N`, `--limit=N`, `--seed=N` | `--introspect`, `--upload`, `--open-errors`, `--judge` | Run train phase |
| `test` | `--models=X`, `--configs=a,b,c`, `--concurrent=N`, `--limit=N`, `--seed=N` | `--introspect`, `--upload`, `--open-errors`, `--judge` | Run test phase |
| `full` | `--models=X`, `--limit=N`, `--seed=N` | `--upload`, `--open-errors` | Run train → test |
| `inspect` | `--export=FILE`, `--output=FILE`, `--limit=N`, `--run=ID` | `--open`, `--error-log`, `--latest`, `--include-reviewed` | Truth-seeking analysis |
| `errors` | `--file=PATH`, `--output=PATH`, `--run=ID` | `--open` | Error analysis report |
| `hydrate` | `--limit=N` | `--dry-run`, `-v` | Populate Config C query history |
| `upload` | `--db=NAME` | `--keep-local` | Upload logs to MotherDuck |
| `cleanup` | - | `--dry-run`, `--no-verify`, `--include-html` | Delete local logs after upload |
| `report` | `--file=PATH` | - | Generate results report |
| `verify` | - | - | Verify database contents |

**Config aliases:** `a`=baseline, `b`=comments, `c`=full (with query history)

## Project Structure

```
src/
  providers/          - Model provider implementations (OpenRouter)
  optimization/       - Prompt optimization tools
  comparison.py       - Result comparison utilities
  schema_helper.py    - Schema information utilities
  sql_executor.py     - SQL execution via MotherDuck
  controllog.py       - Telemetry and accounting system
  truth_seeker.py     - LLM judge for truth-seeking analysis
  platinum.py         - Platinum answer management
  error_investigator.py - Error categorization

eval/
  cli.py              - CLI entry point (bird-eval)
  runner.py           - Phase orchestration (train/test)
  config.py           - Eval configurations
  sampler.py          - Stratified splitting
  scoring.py          - Accuracy calculations
  database_setup.py   - Database config management

prompts/
  system_prompt.md    - System prompt template
  user_prompt.md      - User prompt template

data/
  platinum_answers.json  - Human-curated gold answers (tracked)
  platinum_reviewed.json - Reviewed question_ids for filtering (tracked)
  eval_results/          - Generated reports and logs (not tracked)
```

## Data Files

| File | Source | How to Generate |
|------|--------|-----------------|
| `bird_challenging_100.json` | HuggingFace | `uv run python -m src.data_prep` |
| `results/` | Evaluation | Generated during evaluation |

Tracked files: `platinum_answers.json` (curated corrections) and `platinum_reviewed.json` (reviewed question_ids).

## Platinum Answers

The BIRD benchmark gold answers sometimes contain errors. The platinum system allows human-curated corrections to be used as fallback during evaluation.

### How it works

1. During evaluation, if a predicted result doesn't match gold, the system checks against platinum answers
2. If the prediction matches a platinum answer, it's marked as correct with `match_source: "platinum"`
3. This improves accuracy measurement by accounting for known gold answer issues

### Reviewing platinum candidates

After running an evaluation, review potential corrections:

```bash
# Open HTML viewer for platinum candidates from latest run
uv run bird-eval inspect --latest --open

# In the viewer:
# - Review each candidate's reasoning
# - Click Accept/Reject for each
# - Click "Export Decisions" when done
```

### Inspect command flags

| Flag | Description |
|------|-------------|
| `--latest` | Filter to most recent run by timestamp |
| `--run=ID` | Filter to specific run_id |
| `--open` | Generate and open HTML viewer |
| `--limit=N` | Limit number of entries to analyze |
| `--include-reviewed` | Include already-reviewed candidates (normally filtered) |
| `--export=FILE` | Import decisions from exported JSON file |

### Review tracking

The system tracks both accepted and rejected candidates:
- **Accepted** entries are added to `data/platinum_answers.json`
- **All reviewed** question_ids are tracked in `data/platinum_reviewed.json`
- Reviewed items are automatically filtered from future inspect runs

```bash
# Import decisions (accepts go to platinum, rejects are tracked)
uv run bird-eval inspect --export platinum_review_*.json

# To see all items including previously reviewed
uv run bird-eval inspect --latest --open --include-reviewed
```

### Platinum workflow

1. **Run evaluation**: `uv run bird-eval test --config=c`
2. **Review candidates**: `uv run bird-eval inspect --latest --open`
3. **Accept/reject** in HTML viewer, click "Export Decisions"
4. **Import decisions**: `uv run bird-eval inspect --export <file>`
5. **Future runs** automatically use platinum fallback
6. **Future inspects** automatically hide reviewed items

## LLM Judge

The `--judge` flag enables an LLM-as-judge to evaluate results that don't match gold or platinum answers. This provides a last-resort correctness check using Gemini 3 Flash as an impartial third-party judge.

### How it works

1. After comparing predicted results against gold and platinum answers
2. If no match found (and not an accepted partial like extra_columns)
3. The judge analyzes both SQL queries and their results
4. If the judge determines the prediction is correct, it's marked `JUDGE_CORRECT` (1 point)

### Usage

```bash
# Enable judge for train evaluation
uv run bird-eval train --models=gemini-3-flash --configs=c --judge

# Enable judge for test evaluation
uv run bird-eval test --models=gpt-5.2 --configs=a,b,c --judge
```

### Judge report

At the end of a run with `--judge`, an auditable report is printed showing:
- Total questions judged
- Approved vs rejected breakdown
- Verdicts and reasoning for each decision

### Controllog events

Judge decisions are logged as `llm_judge` events in controllog:
```sql
SELECT
    payload_json->>'question_id' as question_id,
    payload_json->>'verdict' as verdict,
    payload_json->>'confidence' as confidence
FROM controllog.events
WHERE kind = 'llm_judge'
ORDER BY event_time DESC;
```

## Metadata Generation

For generating database metadata (column statistics, descriptions, SQL comments), use the separate [metadata_generator](https://github.com/matsonj/metadata_generator) package:

```bash
uv run metadata-generator generate <schema_name>
```
