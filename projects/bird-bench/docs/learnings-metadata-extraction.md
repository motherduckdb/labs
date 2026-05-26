# Learnings: Metadata Extraction for Text-to-SQL

**Date:** 2026-01-09
**Reference:** "Automatic Metadata Extraction for Text-to-SQL" (arXiv:2505.19988)

## Background

Analyzed the paper that achieved #1 on BIRD leaderboard using GPT-4o with no fine-tuning. Their key insight: *"the most difficult part of query development lies in understanding the database contents."*

## Key Findings from Paper

### What They Did

1. **Database Profiling** - Extract statistics for each column:
   - Record counts, NULL percentages
   - Distinct value counts (cardinality)
   - Min/max values, value distributions
   - Minhash sketches for field resemblance

2. **Natural Language Metadata** - Convert stats to LLM-readable descriptions:
   ```
   Column "cust_status": 3 distinct values ('Active', 'Inactive', 'Pending').
   94% non-NULL. Appears to be a categorical status indicator.
   ```

3. **Iterative Schema Linking** - LSH + FAISS for approximate string matching:
   - Generate SQL
   - Extract referenced fields
   - Fuzzy match against full schema
   - Re-prompt with augmented schema
   - Repeat until convergence

4. **Query Log Analysis** - Found 25%+ of join constraints undocumented in BIRD

### What They Didn't Use
- No fine-tuning
- No multi-candidate generation
- No complex reasoning chains
- Just GPT-4o with rich metadata

## Our Implementation

### Phase 1: Remove Self-Consistency

Removed multi-candidate generation (5 candidates → 1).

**Result:** No accuracy drop on 10-question sample, 5x theoretical cost reduction.

**Files changed:**
- `src/providers/base.py` - Removed `num_candidates`, `candidate_temperature` from ModelConfig
- `src/providers/openrouter.py` - Removed `_generate_single_candidate`, `run_query_with_candidates`
- `src/run_eval.py` - Simplified to always use single `run_query`

### Phase 2: Database Profiler

Built profiler using DuckDB's built-in `SUMMARIZE` function.

**File:** `src/profiler.py`

**Features:**
- Extracts cardinality, min/max, NULL%, avg/std for all columns
- Detects categorical columns (≤20 distinct values)
- Retrieves sample values for categorical columns
- Caches profiles to `data/profiles/*.json`

**Key insight:** DuckDB's SUMMARIZE provides everything we need in one query:
```sql
SUMMARIZE schema.table
-- Returns: column_name, column_type, min, max, approx_unique, avg, std, q25, q50, q75, count, null_percentage
```

**Result:**
- 33% cost reduction ($0.0913 → $0.0616)
- 34% time reduction (15.7s → 10.4s)
- Same accuracy (60%)
- +1 partial match

The model makes fewer exploratory tool calls when it has statistics upfront.

### Phase 3: LLM Description Generator

Built generator that creates semantic column descriptions using Gemini Flash.

**File:** `src/metadata_generator.py`

**Features:**
- Generates table-level descriptions ("This table contains customer information...")
- Generates column-level descriptions with semantic types (identifier, categorical, measure, date, etc.)
- Caches to `data/descriptions/*.json`
- Uses cheap model (Gemini Flash) to minimize cost

**Result:**
- No accuracy improvement
- Slightly higher cost ($0.0616 → $0.0725)
- Descriptions may help with different question types

**Learning:** For these 10 questions, raw statistics (cardinality, sample values) were more useful than semantic descriptions. The model could infer meaning from the data itself.

### Phase 4: Integration

Updated `schema_helper.py` to include profile stats and descriptions in prompts.

**New function:** `get_linked_schema_with_profile()`

**Schema output format:**
```
TABLE: customers (32,461 rows)
  Purpose: Contains customer information including segment and currency.
--------------------------------------------------
  CustomerID: BIGINT (~34,308 unique, avg=27888.2, range=[3, 53314])
      → Unique identifier for each customer
  Segment: VARCHAR (3 distinct)
      → Values: 'SME', 'KAM', 'LAM'
  Currency: VARCHAR (2 distinct)
      → Values: 'EUR', 'CZK'
```

## Benchmark Results

| Phase | Configuration | Accuracy | Partial | Cost | Avg Time |
|-------|---------------|----------|---------|------|----------|
| 1 | Baseline (no self-consistency) | 60% | 0% | $0.0913 | 15.7s |
| 2 | + Profile stats | 60% | 10% | $0.0616 | 10.4s |
| 3 | + LLM descriptions | 60% | 10% | $0.0725 | 10.2s |

## Key Takeaways

1. **Profiling is the biggest win** - Rich statistics reduce exploratory queries and cost

2. **Self-consistency may be unnecessary** - With good metadata, single-shot works well

3. **Semantic descriptions had minimal impact** - The model infers meaning from statistics

4. **Tool calling complements profiling** - Our MCP approach lets the model validate assumptions; profiling gives it a head start

5. **DuckDB's SUMMARIZE is powerful** - One function provides comprehensive column statistics

## Model Configurations

```python
# Available in src/providers/__init__.py
MODELS = {
    "gemini-flash-3":           # Baseline (schema linking, samples, FK)
    "gemini-flash-3-profiled":  # + profile statistics
    "gemini-flash-3-described": # + profile + LLM descriptions
}
```

## What We Didn't Implement (Yet)

1. **Iterative schema linking** - Fuzzy matching to correct hallucinated column names
2. **Query log analysis** - Discovering undocumented joins from gold SQL
3. **Minhash sketches** - For field resemblance detection across tables

## Files Created

```
src/profiler.py                  # Database profiler
src/metadata_generator.py        # LLM description generator
data/profiles/*.json             # Cached profiles (11 databases)
data/descriptions/*.json         # Cached descriptions (9 databases)
TODO.md                          # Future work items
```

## Phase 5: Jinja-Based Metadata Injection

**Date:** 2026-01-13

### Problem

The profiling infrastructure was built (profiler.py, metadata_generator.py, minhash_linker.py) but wasn't being used effectively. The model was still making expensive MCP calls (~700ms each) to explore schemas at runtime.

### Solution

Implemented fast Jinja-based metadata injection:

1. **Pre-compute metadata cache** (`src/build_metadata_cache.py`)
   - Uses `SUMMARIZE <table>` for efficient stats collection
   - Caches to `data/metadata_cache/<schema>.json`
   - Built cache for 12 schemas, 77 tables, 815 columns

2. **Jinja template** (`prompts/user_prompt.md.j2`)
   - Injects FK relationships, MinHash similarities, discovered joins
   - Column info with cardinality and null percentages
   - Renders in ~3ms vs 700ms+ per MCP call

3. **Metadata loader** (`src/metadata_loader.py`)
   - Preloads all metadata on import
   - LRU cache for schema data
   - `render_user_prompt()` function for fast rendering

**Result:**
- Schema info now injected in ~3ms instead of multiple MCP calls
- Model sees FK, join patterns, column cardinality upfront
- 100% accuracy on 2-question test with metadata visible

### Key Fix: raw_messages Capture

**Problem:** User reported metadata not visible in results files after 50-question run.

**Root cause:** The `raw_messages` list in `openrouter.py` was only capturing assistant and tool messages, not the initial system/user prompts. This made it impossible to verify metadata injection from results files.

**Fix:** Added initial prompts to `raw_messages`:
```python
# openrouter.py
raw_messages.append({"role": "system", "content": system_content})
raw_messages.append({"role": "user", "content": user_content})
```

### Key Fix: Silent Exception Logging

**Problem:** Jinja metadata failures were being silently swallowed.

**Fix:** Added stderr logging in `base.py`:
```python
except Exception as e:
    print(f"WARNING: Jinja metadata failed: {e}", file=sys.stderr)
```

### Debugging Lesson

When validating that metadata injection works:
1. Check results JSON for `raw_response.messages[0:2]` (system + user prompts)
2. Look for `### Foreign Keys`, `### Tables`, row counts in user message
3. Check stderr for any warning messages during runs

### Files Modified

```
src/providers/openrouter.py  # Capture initial prompts in raw_messages
src/providers/base.py        # Log Jinja errors instead of silent fail
```

## Phase 6: Database Comments and Architecture Simplification

**Date:** 2026-01-14

### Problem

The metadata injection system had grown complex:
- Jinja templates injecting metadata into prompts
- Local `validate_sql` tool parsing SQL and checking references
- Multiple layers of caching (profiles, descriptions, metadata cache)
- MotherDuck MCP `list_columns` tool didn't expose our enrichment data

### Solution

Moved metadata directly into the database as COMMENT ON statements:

1. **Generated SQL comment files** (`data/comments/*.sql`)
   - 9 schemas with table and column comments
   - Comments include: semantic type, description, data type, distinct count, null%, value range
   - Example: `[identifier] A unique identifier for each card. (BIGINT, 53,728 distinct, 0% null, range: 1..56832)`

2. **Fixed identifier quoting** (`src/metadata_generator.py`)
   - Added `quote_identifier()` function for columns with spaces/special chars
   - Columns like `"Academic Year"`, `"Charter School (Y/N)"` now properly quoted

3. **Ran enrichment SQL against MotherDuck**
   - All 9 schema comment files executed successfully
   - Comments now accessible via `duckdb_columns()` function

4. **Disabled Jinja injection** (`src/providers/base.py`)
   - Set `use_jinja_metadata = False`
   - Model can now query comments directly when needed

5. **Removed validate_sql tool**
   - Removed from `MCP_TOOL_DEFINITIONS`
   - Removed `_validate_sql()`, `_parse_search_suggestions()` methods
   - Removed `extract_references()` from `sql_utils.py`
   - Tool was complex and not being advertised to models anyway

6. **Updated system prompt** (`prompts/system_prompt.md`)
   - Added `list_columns` tool
   - Removed `SUMMARIZE` reference
   - Added hint: query `duckdb_columns()` for column descriptions

### Current Architecture

```
Model ──> MCP Tools ──> MotherDuck
          - query
          - list_tables
          - list_columns
          - search_catalog

Column descriptions stored as database comments, accessible via:
SELECT column_name, comment FROM duckdb_columns()
WHERE schema_name = 'X' AND table_name = 'Y'
```

### Key Learnings

1. **MotherDuck MCP doesn't expose comments yet** - `list_columns` returns `"comment": null` even after we added COMMENT ON statements. Model must query `duckdb_columns()` directly.

2. **Database comments are the right abstraction** - Metadata belongs in the database, not in prompt templates. Models can access it when needed via standard SQL.

3. **Simpler is better** - Removing the validate_sql tool and Jinja complexity reduces code to maintain while keeping core functionality.

4. **Identifier quoting matters** - California schools schema has columns like `"Percent (%) Eligible Free (K-12)"` that require proper quoting.

### Files Changed

```
src/metadata_generator.py    # Added quote_identifier()
src/providers/base.py        # Disabled Jinja, removed validate_sql
src/mcp_client.py           # Removed validate_sql from tool definitions
src/sql_utils.py            # Removed extract_references()
prompts/system_prompt.md    # Updated tools list
data/comments/*.sql         # New enrichment SQL files (9 schemas)
```

### Next Steps

- Run benchmark to measure impact of simplified architecture
- Consider if MotherDuck will expose comments in `list_columns` (file feature request?)
- May want to prompt model to check `duckdb_columns()` for unfamiliar columns

## Recommendations

1. **Use profiled config by default** - Best cost/accuracy tradeoff
2. **Skip descriptions for now** - Minimal benefit, adds cost
3. **Implement iterative schema linking** - Likely next biggest improvement
4. **Test on larger sample** - 10 questions may not show full picture
5. **Always capture full prompts in raw_messages** - Essential for debugging
6. **Store metadata in database** - Comments are cleaner than prompt injection
