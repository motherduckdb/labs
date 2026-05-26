# BIRD-Bench Evaluation Progress Log

## Overview

This document captures learnings from building and optimizing a BIRD-bench text-to-SQL evaluation system using MotherDuck MCP and OpenRouter.

---

## Session: Resource Contention & Failure Analysis (2026-01-09)

### Problem: "Too Many Open Files" at 60-70 Questions

When running evaluations with parallelization, the system would consistently fail around question 60-70 with:
```
[Errno 24] Too many open files
```

**Root Cause Analysis:**

1. **macOS file descriptor limit**: Soft limit of 256 FDs
2. **Per-question resource creation**: Each question created:
   - New `OpenRouterProvider` instance
   - New `OpenAI` client (uses httpx internally)
   - New `MotherDuckMCPClient` instance
   - Each with their own HTTP connection pools

With 10 concurrent questions × 2 connections each = 20+ simultaneous connections, plus Python overhead, we'd hit 256 FDs around question 60-70.

### Fix #1: Reuse Provider Instance Per Model

**Before:**
```python
async def evaluate_question(self, question, config, ...):
    provider = create_provider(config, self.motherduck_token)
    try:
        result = await provider.run_query(...)
    finally:
        provider.close()
```

**After:**
```python
async def run_evaluation(self, questions, model_configs, ...):
    for config in model_configs:
        # Single provider for ALL questions
        provider = create_provider(config, self.motherduck_token, shared_mcp_client=self.mcp)
        try:
            # Run all questions with same provider
            tasks = [self.evaluate_question(q, config, provider, ...) for q in questions]
            results = await asyncio.gather(*tasks)
        finally:
            provider.close()
```

**Impact:** Reduced from 100+ HTTP clients to 1 per model.

### Fix #2: Share MCP Client

Added `shared_mcp_client` parameter to providers:

```python
class BaseProvider(ABC):
    def __init__(self, config, motherduck_token, use_optimized_prompts=False, shared_mcp_client=None):
        self._mcp_client = shared_mcp_client
        self._owns_mcp_client = shared_mcp_client is None  # Only close if we created it
```

### Fix #3: Reduce Default Concurrency

Changed default from 10 to 5 concurrent questions as a safety margin.

---

## Discovery: Temperature Race Condition

### The Bug

In `_generate_single_candidate()` for multi-candidate SQL generation:

```python
# BUGGY - Race condition!
original_temp = self.config.temperature
self.config.temperature = temperature  # Mutates shared state
try:
    response = await self._call_api(messages, tools)
finally:
    self.config.temperature = original_temp
```

With 5 candidates generated in parallel via `asyncio.gather()`, all tasks would mutate the same `self.config.temperature` simultaneously.

### The Fix

Pass temperature directly to `_call_api()` instead of mutating shared state:

```python
def _call_api(self, messages, tools, temperature=None):
    return self.client.chat.completions.create(
        ...
        temperature=temperature if temperature is not None else self.config.temperature,
    )

async def _generate_single_candidate(self, ..., temperature):
    # Thread-safe - no mutation of shared state
    response = await asyncio.get_event_loop().run_in_executor(
        None,
        lambda t=temperature: self._call_api(messages, tools, temperature=t)
    )
```

---

## Thread Safety Analysis

### httpx.Client
- **Verdict: Thread-safe**
- From httpx docs: "HTTPX is intended to be thread-safe, and yes, a single client-instance across all threads will do better in terms of connection pooling"

### OpenAI Python Client
- **Verdict: Generally safe when reused**
- Uses httpx internally
- Better to reuse than create new (instantiation consumes ~16% CPU per client)
- Some reports of hanging under heavy concurrent load

### MCP Session ID
- **Verdict: Safe in practice**
- Potential race on `self.session_id` read/write
- But initialized once before concurrent requests, so stable during operation

---

## Failure Pattern Analysis

### Test Results Summary

| Model | Questions | Accuracy | Common Failures |
|-------|-----------|----------|-----------------|
| Gemini 3 Flash | 50 | 54% | 23 failures |
| GPT-5.2 | 50 | 50% | 25 failures |

**21 questions failed on BOTH models** - suggesting systematic issues, not model-specific.

### Failure Categories

| Category | Count | Example Questions |
|----------|-------|-------------------|
| **Percentage calculation wrong** | 8 | Q1482, Q1243, Q896, Q962 |
| **Aggregation logic wrong** | 4 | Q1481, Q1247, Q1302, Q955 |
| **Wrong row count** | 4 | Q1239, Q1242, Q1011, Q1014 |
| **strftime syntax error** | 2 | Q1036, Q1084 |
| **Column count mismatch** | 2 | Q1168, Q1031 |

### Key Finding: Gold SQL Quality Issues

Many "failures" are actually **bugs in the BIRD benchmark gold SQL**, not model errors.

#### Example 1: Q1243 - Broken COUNT

**Question:** "What is the percentage of female who has abnormal prothrombin time (PT)?"

**Gold SQL (buggy):**
```sql
COUNT(CASE WHEN T2.PT >= 14 THEN 1 ELSE 0 END)
```
This counts ALL rows because `0` is non-NULL. Should be:
```sql
SUM(CASE WHEN T2.PT >= 14 THEN 1 ELSE 0 END)
-- or
COUNT(CASE WHEN T2.PT >= 14 THEN 1 END)  -- no ELSE
```

**Result:** Gold says 1.2%, models say 78.4%. Models are likely correct!

#### Example 2: Q1481 - Wrong Aggregation Scope

**Question:** "...customers with the least amount of consumption **in each segment**..."

**Gold SQL:** Filters by global `MIN(Consumption)` across all data, not per-segment minimum.

**Result:** Models correctly interpret "least in each segment" but don't match broken gold.

### strftime Issues

Models generate:
```sql
STRFTIME(CAST(ta.date AS TIMESTAMP), '%Y')
```

DuckDB errors with type inference issues. The syntax appears correct per docs, but fails in practice. May need explicit casting or different approach.

---

## Cost Tracking Improvements

### OpenRouter BYOK Mode

When using "Bring Your Own Key" mode, costs come from a different location:

```python
# Extract actual costs from OpenRouter response
if response.usage and hasattr(response.usage, 'model_extra'):
    usage_extra = response.usage.model_extra
    cost_details = usage_extra.get('cost_details', {})
    if 'upstream_inference_cost' in cost_details:
        actual_upstream_cost = cost_details['upstream_inference_cost']
```

### Removed Hardcoded Prices

Deleted `input_price_per_million` and `output_price_per_million` from `ModelConfig` - always use actual API-reported costs.

---

## Tools Created

### fd_monitor.py

File descriptor monitoring utility for debugging resource issues:

```bash
# Monitor a running process
python src/fd_monitor.py <pid>

# Wrap a command with monitoring
python src/fd_monitor.py --wrap "uv run python src/run_eval.py gemini-flash-3 70"
```

---

## Architecture Decisions

### Single Provider Per Model
- Reuse HTTP connections via connection pooling
- Avoid file descriptor exhaustion
- Better performance (no connection setup overhead per question)

### Shared MCP Client
- Single MotherDuck connection for all database operations
- Consistent session state
- Reduced resource usage

### Semaphore-Based Concurrency
- `asyncio.Semaphore(max_concurrent)` limits parallel API calls
- Default of 5 is safe for macOS 256 FD limit
- Configurable via `--concurrent=N` flag

---

## Recommendations for BIRD Benchmark Users

1. **Don't trust accuracy numbers blindly** - Many gold SQL queries have bugs
2. **Manual review failures** - Check if model SQL is actually correct
3. **Consider partial matching** - Our `CorrectnessLevel.PARTIAL` catches near-misses
4. **Watch for systematic failures** - If multiple models fail the same question, suspect the gold

---

## Git Commits

- `b180837` - Fix resource contention and add evaluation improvements
  - Reuse provider per model
  - Share MCP client
  - Fix temperature race condition
  - Add fd_monitor.py
  - Add partial correctness tracking

---

---

## Session: Platinum Comparison Bug Fix (2026-02-03)

### The Problem

Running evaluations showed 0 platinum matches despite having 49 platinum answers in `data/platinum_answers.json`. Investigation revealed the `platinum_result` field was stored in inconsistent formats:

- **40 entries**: String format like `"['Yosemite High']\n['Novato High']..."` (Python list literals)
- **9 entries**: Proper list format like `[203.8]`

The `compare_with_platinum_fallback()` function was passing these directly to `compare_results()`, which expects normalized row format `[[val1], [val2], ...]`. String-formatted results would never match.

### Root Cause

The HTML viewer's export function uses JavaScript `JSON.parse()` to convert the result data. But Python-style list literals (using single quotes) fail JSON parsing and stay as strings.

### The Fix

Added `_parse_platinum_result()` helper in `src/comparison.py` that:

1. Parses string-formatted results using Python's `ast.literal_eval()`
2. Handles newline-separated row literals
3. Normalizes flat lists `[val1, val2]` to row format `[[val1], [val2]]`
4. Strips "(sampled X of Y total rows)" suffixes
5. Passes through already-correct row formats unchanged

```python
def _parse_platinum_result(platinum_result: str | list) -> list:
    """Parse platinum_result from stored format to normalized row format."""
    # ... handles string parsing with ast.literal_eval
    # ... normalizes to [[val], [val], ...] format
```

### Verification

```
$ uv run python -c "from src.comparison import _parse_platinum_result; ..."
Total entries: 49
Successfully parsed to row format: 49
Failures: 0
```

---

## Session: Opus-4.5 Not Submitting Final Answer (2026-02-03)

### The Problem

Opus-4.5 evaluations showed 18 out of 20 questions marked as "ERROR" with no predicted SQL. Analysis of the HTML error report revealed:
- Model was making 4-5 tool calls per question (well under the 10 limit)
- Model was exploring schema and running queries successfully
- But model would **stop without outputting `FINAL_SQL:`**

Only 2 questions had a valid FINAL_SQL response. Opus-4.5 gets so focused on thorough exploration that it forgets to submit the final answer.

### The Fix

Added a "nudge" mechanism in `src/providers/openrouter.py`:

```python
# Model stopped without FINAL_SQL - prompt for it explicitly (once)
if not final_sql_submitted and predicted_sql and not already_nudged_for_final:
    already_nudged_for_final = True
    nudge = "You've tested your query successfully. Now output your final answer..."
    messages.append({"role": "user", "content": nudge})
    continue  # One more iteration to get FINAL_SQL
```

When the model:
1. Has `finish_reason == "stop"`
2. Has SQL from a query tool call (`predicted_sql` is set)
3. Hasn't output FINAL_SQL yet
4. Hasn't been nudged before

We inject one more user message asking for the final answer, then give the model one more turn.

---

## Session: Extra Duplicates Partial Check (2026-02-03)

### The Problem

When model returns more rows than gold, but all extra rows are duplicates of existing rows, this was being marked as INCORRECT or extra_rows. It should be a valid PARTIAL.

Example:
- Gold: `[['A'], ['B'], ['C']]` (3 unique rows)
- Predicted: `[['A'], ['A'], ['B'], ['B'], ['C'], ['C']]` (6 rows, all duplicates)
- Expected: PARTIAL (unique values match)

### The Fix

Added `_check_extra_duplicates()` in `src/comparison.py`:

```python
def _check_extra_duplicates(gold: list, predicted: list) -> str | None:
    """Check if predicted has extra duplicate rows but unique values match gold."""
    # Predicted must have more rows than gold
    if len(predicted) <= len(gold):
        return None

    gold_unique = set(normalize_row(row) for row in gold)
    pred_unique = set(normalize_row(row) for row in predicted)

    # Check if unique predicted matches gold exactly
    if gold_unique == pred_unique:
        extra_duplicates = len(predicted) - len(pred_unique)
        return f"extra_duplicates:{extra_duplicates}_duplicates_in_predicted"
    return None
```

Now returns `PARTIAL` with reason `extra_duplicates:3_duplicates_in_predicted` for the example above.

---

## Session: Truth-Seeking & Platinum Answers (PRs 42-52)

### The Problem: Gold SQL Quality

Our failure analysis revealed that many "incorrect" model answers were actually better than the benchmark's gold SQL. We needed a systematic way to:
1. Identify when the model is correct and gold is wrong
2. Track these "platinum" answers for future evaluations
3. Give models credit for platinum matches

### Solution: Truth-Seeking Inspector (PR 42)

Added `bird-eval inspect` command that uses an objective third-party model (Gemini 2.0 Flash) to judge whether predicted SQL or gold SQL is more correct.

```bash
# Analyze most recent error log
uv run bird-eval inspect --latest

# Open HTML viewer for human review
uv run bird-eval inspect --latest --open
```

**Verdicts:**
- `GOLD_CORRECT` - Benchmark answer is correct
- `PREDICTED_CORRECT` - Model's answer is better (platinum candidate)
- `BOTH_CORRECT` - Both answers are valid
- `BOTH_WRONG` - Neither answer is correct
- `UNCLEAR` - Cannot determine

### Platinum Candidate HTML Viewer (PR 44)

Interactive 3-column UI for reviewing candidates:
- Question/Context | SQL Comparison | Verdict/Reasoning
- SQL formatted with sqlglot for readability
- Filters by verdict, confidence, recommendation, database
- Keyboard navigation (`j/k`, `a/r/s` for accept/reject/skip)
- Decisions persisted in localStorage
- Export accepted candidates to JSON

### Platinum Evaluation Support (PR 47)

Full pipeline for platinum answers:
1. Run evaluation: `uv run bird-eval test --config=c`
2. Review candidates: `uv run bird-eval inspect --open`
3. Accept/reject in viewer, export JSON
4. Import accepted: `uv run bird-eval inspect --export platinum_accepted_*.json`
5. Future evaluations automatically fallback to platinum when gold fails

**Current platinum dataset:** ~120 curated answers in `data/platinum_answers.json`

### Platinum Review Tracking (PR 50)

Track rejected candidates separately from accepted ones:
- `data/platinum_answers.json` - Accepted platinum SQL
- `data/platinum_reviewed.json` - Already-reviewed question IDs (both accepted and rejected)

This prevents re-reviewing the same candidates and enables filtering the viewer to only show new candidates.

---

## Session: Result Comparison Improvements (PRs 40-41, 45, 48)

### Type Coercion (PR 40)

Models often produce semantically equivalent but syntactically different results. Added automatic coercion:

| Type | Coercion |
|------|----------|
| Boolean | `"true"`/`"yes"` → 1, `"false"`/`"no"` → 0 |
| Int/float | `118.0` → `118` |
| Scientific | `"1e3"` → `1000` |

### Adaptive Precision (PR 40)

Use gold's decimal precision to evaluate predicted values:
- Gold: `24.67` (2 decimals)
- Predicted: `24.6666667`
- Result: **CORRECT** (rounds to 24.67)

### Implicit DISTINCT Detection (PR 40)

When predicted returns deduplicated gold results, mark as `PARTIAL` instead of `INCORRECT`:
- Gold: 5 rows with duplicates
- Predicted: 3 unique rows (subset of gold)
- Result: **PARTIAL** with note `implicit_distinct:2_duplicates_removed`

### Floating Point Tolerance (PR 45)

Fixed tolerance from 1e-6 to 0.0001 (0.01%). The tighter tolerance was catching too many false positives from rounding differences.

### Aggregated Equivalent Check (PR 41)

Detect when results are aggregated versions of expected output:
- Gold expects 5 individual rows
- Model returns single aggregated value that matches SUM/COUNT/AVG
- Result: **PARTIAL** with aggregation note

### Comparison Bug Fixes (PR 48)

Fixed edge cases:
- NULL handling in comparisons
- Empty result set comparisons
- Single-column vs multi-column result handling

---

## Session: Error Analysis & Introspection (PRs 17-38, 51)

### Bloomberg-Style Error Reports (PR 20)

Interactive HTML error viewer with:
- Filters by database, error category, correctness level
- Side-by-side gold vs predicted SQL
- Full question context and evidence

### Introspection System (PR 28)

Added `--introspect` flag to analyze failures with LLM:

```bash
uv run bird-eval test --config=c --limit=50 --introspect
```

For each failure, the introspector:
1. Examines the question, schema, gold SQL, and predicted SQL
2. Categorizes the error (schema_misunderstanding, aggregation_logic, etc.)
3. Suggests a fix for the prompt/system

### Fix Field for Generalizable Advice (PRs 31-32)

Introspection now outputs generalizable prompt advice:
- Instead of "add column X to schema"
- Now suggests "prompt should emphasize checking column descriptions for unit indicators"

### Automatic Introspection Summary (PR 51)

After introspect runs, generates markdown summary:
- Aggregates findings by category
- Lists all recommendations
- Tracks patterns across multiple questions

Example output in `data/eval_results/introspection/introspection_summary_*.md`

---

## Session: Scoring Enhancements (PRs 19, 26, 49)

### Run Summary Table (PR 26)

Display summary at end of evaluation:

```
┌─────────────────────────────────────────────────────────┐
│ Results: 250 correct, 45 partial, 5 hit_limit, 200 incorrect │
│ Accuracy: 50.0% (strict) / 59.0% (with partial)              │
└─────────────────────────────────────────────────────────┘
```

### Detailed Scoring Categories (PR 49)

Split `CORRECT` and `PARTIAL` into granular categories:

| Category | Description |
|----------|-------------|
| `CORRECT_GOLD` | Matches official gold SQL |
| `CORRECT_PLATINUM` | Matches curated platinum answer |
| `PARTIAL_ACCEPTED` | Partial match that gets credit |
| `PARTIAL_UNACCEPTED` | Partial match, no credit |
| `HIT_LIMIT` | Ran out of tool calls (separate from incorrect) |
| `INCORRECT` | Wrong answer |

**HIT_LIMIT** is now tracked separately - hitting the 10 tool call limit is a resource issue, not necessarily a model capability issue.

---

## Session: Performance & Token Optimization (PRs 22, 24, 27, 46)

### Schema Discovery via Tools (PR 22)

**Before:** Full database schema included in every prompt (expensive, often irrelevant)

**After:** Models discover schema via MCP tools as needed:
- `list_tables` - Get table names
- `describe_table` - Get column info for specific table
- `get_schema` - Get full schema only when needed

**Impact:** Reduced input tokens significantly for large databases.

### Result Sampling (PR 46)

Large query results were consuming 100k+ tokens. Added automatic sampling:
- Results limited to 20 rows max
- Full row count reported
- Sufficient for model to understand pattern

### Comment Stripping Optimization (PR 24)

`strip_all_comments()` was O(n²) due to repeated string operations. Optimized to single-pass processing.

### OpenRouter Token Caching (PR 27)

Added provider routing to leverage OpenRouter's prompt caching:
- System prompts cached across requests
- Reduces costs for repeated schema/instruction tokens

---

## Key Learnings

### 1. Ground Truth Isn't Always True
The BIRD benchmark gold SQL has significant quality issues. Building a platinum answer system was essential for fair evaluation.

### 2. Semantic Equivalence is Hard
Two SQL queries can produce "different" results that are semantically equivalent:
- Different column order
- Floating point precision
- Implicit vs explicit DISTINCT
- Type representation (bool vs int)

### 3. Failure Analysis > Aggregate Metrics
Aggregate accuracy numbers hide important patterns. The introspection system revealed:
- Categories of systematic failures
- Prompt improvements that help across questions
- Gold SQL bugs that affect many questions

### 4. Human-in-the-Loop Scales Better
The platinum viewer enabled reviewing 100+ candidates per hour:
- Keyboard shortcuts for quick decisions
- Pre-filtered by LLM confidence
- Batch export/import

---

## Architecture Evolution

```
PR 17-20: Error Analysis Foundation
   └── Error logs → HTML viewer → Human review

PR 21-38: Automated Investigation
   └── Error logs → LLM introspection → Categorized findings → Summary

PR 40-48: Comparison Intelligence
   └── Type coercion → Adaptive precision → Implicit DISTINCT

PR 42-52: Platinum Pipeline
   └── Failures → Truth-seeking → Review UI → Platinum DB → Auto-fallback
```

---

## Next Steps

1. ~~Investigate strftime DuckDB issues more deeply~~ (Resolved via type coercion)
2. ~~Consider creating a "curated gold" dataset with fixed SQL~~ (Done: platinum system)
3. Add retry logic for transient API failures
4. Implement result caching to avoid re-running successful questions
5. Apply introspection insights to improve base prompts
6. Expand platinum coverage to more question categories
