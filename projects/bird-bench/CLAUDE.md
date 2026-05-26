# BIRD-Bench Project Instructions

## Python Environment

**Always use `uv` for Python operations.**

- Run Python scripts: `uv run python script.py`
- Install packages: `uv add package-name`
- Sync dependencies: `uv sync`

Do NOT use bare `python` or `pip` commands.

## Git Workflow

**NEVER merge PRs.** A separate git worktree runs Claude to review, fix up, and merge PRs. Your job is to create the PR and stop there.

## Log Analysis

**Logs are stored in MotherDuck, not local files.** After running evaluations with `--upload`, query logs via SQL rather than grep.

### Tables
- `controllog.events` - All events (model completions, error investigations, etc.)
- `controllog.postings` - Double-entry accounting records (tokens, costs, time)

### Common SQL Queries

```sql
-- Recent runs with costs
SELECT
    run_id,
    MIN(event_time) as started,
    COUNT(*) as events,
    SUM((payload_json->>'cost_usd')::DECIMAL) as cost_usd
FROM controllog.events
WHERE kind = 'model_completion'
GROUP BY run_id
ORDER BY started DESC
LIMIT 10;

-- Accuracy by model and config
SELECT
    payload_json->>'model' as model,
    payload_json->>'config_type' as config,
    COUNT(*) as questions,
    SUM(CASE WHEN payload_json->>'correctness_level' = 'correct' THEN 1 ELSE 0 END) as correct,
    ROUND(100.0 * SUM(CASE WHEN payload_json->>'correctness_level' = 'correct' THEN 1 ELSE 0 END) / COUNT(*), 1) as accuracy_pct
FROM controllog.events
WHERE kind = 'model_completion'
  AND payload_json->>'question_id' IS NOT NULL
GROUP BY 1, 2
ORDER BY accuracy_pct DESC;

-- Error categories from investigations
SELECT
    payload_json->>'category' as category,
    COUNT(*) as count
FROM controllog.events
WHERE kind = 'error_investigation'
GROUP BY 1
ORDER BY count DESC;

-- Token usage by model
SELECT
    dims_json->>'model' as model,
    unit,
    SUM(delta_numeric) as total
FROM controllog.postings
WHERE account_type = 'truth.tokens'
GROUP BY 1, 2
ORDER BY 1, 2;

-- Cost by model (from postings)
SELECT
    dims_json->>'model' as model,
    -SUM(delta_numeric) as total_cost_usd
FROM controllog.postings
WHERE account_type = 'truth.money'
  AND account_id = 'project'
  AND unit = 'usd'
GROUP BY 1
ORDER BY total_cost_usd DESC;
```

### Upload

Use the `upload` command to upload logs to MotherDuck and optionally clean up local files:

```bash
# Upload all logs and clean up (recommended workflow)
uv run bird-eval upload

# Upload to specific database
uv run bird-eval upload --db=my_db

# Upload but keep local files
uv run bird-eval upload --keep-local
```

**What gets uploaded:**
1. `controllog/events.jsonl` → `controllog.events`
2. `controllog/postings.jsonl` → `controllog.postings`
3. `truth_seeking/*.jsonl` → `controllog.truth_seeking`
4. `error_logs/*.jsonl` → `controllog.error_investigations`

**What gets kept locally:**
- HTML reports (error reports, introspection summaries)
- Judge reports (markdown)

### Cleanup

After uploading to MotherDuck, clean up local logs:

```bash
# Preview what would be deleted
uv run bird-eval cleanup --dry-run

# Delete logs (verifies against MotherDuck first)
uv run bird-eval cleanup

# Also delete HTML error reports
uv run bird-eval cleanup --include-html
```

### Truth-Seeking Analysis

After an eval run, use the truth-seeking inspector to determine if predicted SQL is actually more correct than gold SQL. Uses gemini-3-flash-preview as an objective third-party judge.

```bash
# Analyze the most recent error log
uv run bird-eval inspect --latest

# Analyze and open HTML viewer for review
uv run bird-eval inspect --latest --open

# Limit to first N entries (useful for testing)
uv run bird-eval inspect --latest --limit 10

# Custom output path
uv run bird-eval inspect --latest --output my_analysis.jsonl
```

**HTML Viewer Features (--open):**
- 3-column layout: Question/Context | SQL Comparison | Verdict/Reasoning
- SQL formatted with sqlglot for readability
- Filters: verdict, confidence, recommendation, database
- Keyboard navigation: `j/k` or arrows, `a/r/s` for accept/reject/skip
- Decisions persisted in localStorage
- Export accepted candidates to JSON

**Verdicts:**
- `GOLD_CORRECT` - Benchmark answer is correct
- `PREDICTED_CORRECT` - Model's answer is better (potential platinum candidate)
- `BOTH_CORRECT` - Both answers are valid
- `BOTH_WRONG` - Neither answer is correct
- `UNCLEAR` - Cannot determine which is better

**Recommendations:**
- `KEEP_GOLD` - No change needed
- `ADD_TO_PLATINUM` - Consider adding to platinum answers
- `NEEDS_REVIEW` - Human review required

Results are written to `data/eval_results/truth_seeking/analysis_<timestamp>.jsonl`.

### LLM Judge (--judge flag)

Use the `--judge` flag during train/test to enable real-time LLM judging of results that don't match gold or platinum answers. Uses gemini-3-flash as an impartial judge.

```bash
# Run with judge enabled
uv run bird-eval train --models=gemini-3-flash --configs=c --judge

# With other options
uv run bird-eval train --models=gpt-5.2 --configs=c --concurrent=20 --limit=10 --judge --open-errors
```

**When judge is invoked:**
- After gold comparison fails
- After platinum fallback fails
- After accepted partials (extra_columns, extra_duplicates, implicit_distinct) fail
- NOT invoked for ERROR or HIT_LIMIT results

**Judge verdicts:**
- `PREDICTED_CORRECT` or `BOTH_CORRECT` → marked as `JUDGE_CORRECT` (1 point)
- Other verdicts → remains INCORRECT/PARTIAL (0 points)

**SQL query for judge decisions:**
```sql
-- LLM judge decisions
SELECT
    payload_json->>'question_id' as question_id,
    payload_json->>'verdict' as verdict,
    payload_json->>'confidence' as confidence,
    payload_json->>'reasoning' as reasoning
FROM controllog.events
WHERE kind = 'llm_judge'
ORDER BY event_time DESC;

-- Judge approval rate
SELECT
    COUNT(*) as total_judged,
    SUM(CASE WHEN payload_json->>'verdict' IN ('PREDICTED_CORRECT', 'BOTH_CORRECT') THEN 1 ELSE 0 END) as approved,
    ROUND(100.0 * SUM(CASE WHEN payload_json->>'verdict' IN ('PREDICTED_CORRECT', 'BOTH_CORRECT') THEN 1 ELSE 0 END) / COUNT(*), 1) as approval_rate_pct
FROM controllog.events
WHERE kind = 'llm_judge';
```
