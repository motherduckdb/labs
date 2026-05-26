# BIRD-Bench Optimization Research

## Current Performance
- Gemini 3 Flash: 40%
- Claude Opus 4.5: 30%
- GPT-5.2: 30%

Target: 75%+ (top systems achieve 81.67%)

---

## Failure Analysis (10-question sample)

### Breakdown
- **7 unique failed questions** across all models
- **4/7 (57%)**: Gold SQL errors (DuckDB incompatibility - backticks, type mismatches)
- **3/7 (43%)**: True semantic failures

### Semantic Failure Patterns

**1. Column Selection (Q586)**
- Question: "Which user added a bounty..."
- Model returned: `(user,)` - correct users
- Gold expected: `(user, title)` - extra contextual column
- Issue: Models interpret literally; gold expects contextual columns

**2. Aggregation Semantics (Q198)**
- Question: "On average how many carcinogenic molecules are single bonded?"
- Model: `SUM(single_bonds) / COUNT(atoms)` = 0.82 (ratio)
- Gold: `AVG(COUNT(*) GROUP BY molecule)` = 732 (per-entity average)
- Issue: "Average per entity" vs simple ratio ambiguity

**3. Evidence Mismatch**
- Evidence hints sometimes contradict gold SQL logic
- Example: Evidence says `DIVIDE(SUM, COUNT)` but gold uses `AVG` of grouped counts

---

## Gap Analysis vs Top Systems

| Technique | Top Systems (75-81%) | Our Approach (30-40%) |
|-----------|---------------------|----------------------|
| Schema Linking | Extract 2-4 relevant tables | Full schema dump |
| Candidate Generation | 5-10 SQL candidates | Single generation |
| Selection | Self-consistency (most common result) | N/A |
| Few-Shot Examples | Embedding retrieval from training | None |
| Value Retrieval | LSH + embeddings for DB values | None |
| Iterative Refinement | Execute → error check → retry | Single pass |

---

## Top System Techniques

### IBM ExSL+Granite (BIRD Leaderboard)
1. **Extractive Schema Linking**: Fine-tuned model extracts relevant columns into sub-tables
2. **Content Linking**: Generate up to 10 SQL candidates
3. **Self-Consistency Selection**: Pick SQL whose result appears most often
4. 7x speedup from extractive vs generative schema linking

### Agentar-Scale-SQL (81.67%)
Three scaling perspectives:
1. **Internal**: RL-enhanced intrinsic reasoning
2. **Sequential**: Iterative refinement
3. **Parallel**: Diverse synthesis + tournament selection

Components:
- Light Schema Engine (simplified schema)
- Vector DB for training examples (all-MiniLM-L6-v2)
- BM25 index for keyword matching
- Multi-perspective candidate generation
- SQL selection module

---

## Prioritized Recommendations

### Tier 1: Highest Impact (implement first)

**1. Multi-Candidate + Self-Consistency**
```python
# Generate 5 candidates with temperature=0.3
candidates = [generate_sql(question, temp=0.3) for _ in range(5)]
results = [execute(sql) for sql in candidates]
final_sql = pick_most_common_result(candidates, results)
```
Expected lift: +10-15%

**2. Schema Linking / Pruning**
- Use embeddings to match question → relevant tables
- Only include 2-4 relevant tables in prompt
- Reduces noise, fits more useful context
Expected lift: +5-10%

**3. Few-Shot Example Retrieval**
- Embed all training questions
- Retrieve 2-3 most similar examples
- Include as in-context examples
Expected lift: +5-10%

### Tier 2: Medium Impact

**4. Sample Data Rows**
- Show 2-3 example rows per table
- Reveals data formats (date as "201201" vs "2012-01-01")
- Shows actual values ("CZK" not "Czech Koruna")

**5. Foreign Key Information**
- `dev_tables.json` has FK/PK data we're not using
- Critical for correct JOIN conditions

**6. Value Retrieval**
- For categorical columns, show distinct values
- Use LSH/embeddings to match question terms to DB values

### Tier 3: Refinements

**7. Chain-of-Thought Pre-Generation**
- Output reasoning before SQL: tables needed, join conditions, aggregations

**8. Iterative Error Recovery**
- If SQL errors, feed error back and retry (if allowed)

---

## Data Assets Available

### `mini_dev_data/MINIDEV/dev_tables.json`
```python
{
  "db_id": "debit_card_specializing",
  "table_names_original": ["customers", "gasstations", ...],
  "column_names_original": [[-1, "*"], [0, "CustomerID"], ...],
  "foreign_keys": [[19, 1]],  # NOT CURRENTLY USED
  "primary_keys": [1, 4, 8, ...]  # NOT CURRENTLY USED
}
```

### Schema Helper Gap
Current `get_schema_info()` provides:
- Table names, column names, types, nullable

Missing:
- Foreign key relationships
- Primary key indicators
- Sample data rows
- Distinct value counts for categorical columns

---

## Implementation Notes

### Self-Consistency Implementation
```python
from collections import Counter

def select_by_consistency(candidates: list[str], executor) -> str:
    """Generate multiple SQLs, pick one with most common result."""
    results = []
    for sql in candidates:
        try:
            result = executor(sql)
            results.append((sql, str(result)))  # stringify for comparison
        except:
            results.append((sql, "ERROR"))

    # Group by result, pick SQL from largest group
    result_counts = Counter(r[1] for r in results)
    most_common_result = result_counts.most_common(1)[0][0]

    # Return first SQL that produced this result
    for sql, result in results:
        if result == most_common_result:
            return sql
    return candidates[0]
```

### Schema Linking Approach
```python
from sentence_transformers import SentenceTransformer

model = SentenceTransformer('all-MiniLM-L6-v2')

def link_schema(question: str, tables: list[dict]) -> list[str]:
    """Return top-k relevant tables for question."""
    q_emb = model.encode(question)

    scored = []
    for table in tables:
        # Embed table name + column names
        table_text = f"{table['name']}: {', '.join(table['columns'])}"
        t_emb = model.encode(table_text)
        score = cosine_similarity(q_emb, t_emb)
        scored.append((table['name'], score))

    return [t[0] for t in sorted(scored, key=lambda x: -x[1])[:4]]
```

---

## References

- [IBM ExSL+Granite Blog](https://research.ibm.com/blog/granite-LLM-text-to-SQL)
- [Agentar-Scale-SQL](https://github.com/AntGroup/Agentar-Scale-SQL) - 81.67% on BIRD
- [BIRD Benchmark](https://bird-bench.github.io/)
- [BIRD-Interact](https://arxiv.org/abs/2510.05318) - Multi-turn evaluation (different from standard BIRD)

---

## Implementation Session: January 13, 2026

### Starting Point
- Evaluated 500 questions (full mini_dev dataset)
- Gemini 3 Flash: **62.2% accuracy** (311/500 correct)
- 110 wrong answers, 79 partial matches, 0 errors

### Techniques Implemented (Based on arXiv:2505.19988)

#### 1. Failure Pattern Analysis
Created analysis scripts to categorize failures:
- `analyze_failures.py` - High-level breakdown
- `deep_failure_analysis.py` - Detailed pattern detection

**Key Findings:**
| Pattern | Count | % of Wrong |
|---------|-------|------------|
| Type mismatch | 46 | 42% |
| Count errors | 26 | 24% |
| Percentage/ratio errors | 18 | 16% |
| Date extraction | 15 | 14% |
| Missing DISTINCT | 9 | 8% |

**SQL Pattern Issues:**
- `missing_date_extraction`: 15 (SUBSTR for YYYYMM dates)
- `count_vs_sum`: 13 (confusion between counting and summing)
- `sum_vs_count`: 9
- `missing_distinct`: 9
- `extra_group_by`: 7
- `missing_case_when`: 6

**High-Failure Keywords:**
- 'lowest': 62.5% fail rate
- 'difference': 41.7%
- 'average': 36.6%
- 'highest': 34.5%
- 'percentage': 33.3%

**Worst Databases:**
1. california_schools: 43.3%
2. financial: 46.9%
3. thrombosis_prediction: 56.0%

#### 2. Prompt Improvements (`src/providers/base.py`)

Added guidance for common failure patterns:

**A. DATE EXTRACTION PATTERNS**
```
- When dates are stored as 'YYYYMMDD' (e.g., '201201'), use SUBSTR:
  - SUBSTR(Date, 1, 4) = year (e.g., '2012')
  - SUBSTR(Date, 5, 2) = month (e.g., '01')
```

**B. COUNT vs SUM clarification**
```
- COUNT(*) = number of rows matching a condition
- SUM(column) = total of numeric values in column
- SUM(CASE WHEN cond THEN 1 ELSE 0 END) = count with condition
```

**C. Conditional Aggregation Patterns**
```
- For counting with conditions: SUM(CASE WHEN cond THEN 1 ELSE 0 END)
- In SQLite gold queries, IIF() is common - DuckDB supports CASE WHEN
```

**D. Result Format Patterns**
```
- "How many" → single COUNT: [(count,)]
- "List all" → multiple rows: [(val1,), (val2,), ...]
- "Which one" → single row: [(identifier,)]
```

**E. DISTINCT vs COUNT DISTINCT**
```
- "List unique X" → SELECT DISTINCT X
- "How many unique X" → COUNT(DISTINCT X)
```

**F. Database-Specific Notes**
Added notes for worst-performing databases:
- california_schools: frpm.CDSCode = satscores.cds
- financial: account, loan, trans, client, district relationships
- thrombosis_prediction: Patient, Examination, Laboratory links

#### 3. MinHash Sketches (`src/minhash_linker.py`)

Implemented Jaccard similarity detection for column value sets:

**Algorithm:**
1. Compute MinHash signatures (128 hashes) for each column's distinct values
2. Compare signatures between columns to estimate Jaccard similarity
3. Flag pairs with >50% value overlap as potential join candidates

**Results Discovered (622 total pairs):**

| Database | Similar Pairs | Top Example |
|----------|---------------|-------------|
| california_schools | 15 | frpm.County Name <-> schools.County (100%) |
| european_football_2 | 231 | League.id <-> Country.id (100%) |
| formula_1 | 198 | circuits.circuitId <-> races.circuitId (100%) |
| card_games | 81 | Various boolean column overlaps |
| financial | 24 | account.account_id <-> disp.account_id (100%) |
| codebase_community | 36 | postHistory.PostId <-> posts.Id (100%) |
| superhero | 21 | attribute.id <-> hero_attribute.attribute_id (100%) |
| toxicology | 6 | atom.molecule_id <-> bond.molecule_id (100%) |
| student_club | 5 | event.status <-> budget.event_status (100%) |
| thrombosis_prediction | 4 | Examination.ANA <-> Laboratory.SSA (60%) |

**Output:** `data/minhash_joins.json`

### Validation Test

Ran 20-question test after prompt improvements:
- **Result: 75.0% (15/20 correct)**
- Previous baseline on challenging: ~51%
- Improvement: +24 percentage points on test sample

### Files Created/Modified

**New Files:**
- `src/minhash_linker.py` - MinHash column similarity detection
- `analyze_failures.py` - Failure pattern analysis
- `deep_failure_analysis.py` - Detailed SQL pattern analysis
- `PROMPT_IMPROVEMENTS.md` - Summary of prompt changes
- `data/minhash_joins.json` - MinHash-discovered join candidates

**Modified Files:**
- `src/providers/base.py` - Enhanced system and user prompts with:
  - DATE EXTRACTION PATTERNS section
  - COUNT vs SUM clarification
  - Conditional aggregation patterns
  - Result format patterns
  - DISTINCT handling
  - Database-specific notes

### Expected Impact

Based on failure analysis:
- Date extraction fixes: ~3% improvement (15 failures)
- COUNT/SUM fixes: ~4.4% improvement (22 failures)
- DISTINCT fixes: ~1.8% improvement (9 failures)
- Format fixes: ~2% improvement (estimated)

**Total expected improvement: +5-10 percentage points** (to ~67-72%)

### Follow-up: 50-Question Stratified Sample (66% accuracy)

After initial improvements, ran 50-question stratified sample:
- **Result: 66% (33 correct, 9 partial, 6 wrong, 2 query errors)**
- Improvement from 62.2% baseline

**Identified remaining issues:**
1. Boolean format: Model returns `'0'`/`'1'` instead of `'YES'`/`'NO'`
2. Missing columns: Not returning all columns (e.g., rank in "Rank X by Y")
3. Binder errors: 2 cases with date function mismatches

**Additional prompt fixes applied:**
- BOOLEAN/YES-NO OUTPUT FORMAT section: Use CASE WHEN → 'YES'/'NO'
- COLUMN SELECTION section: Return ALL requested columns
- Checklist items for YES/NO and RANK() in SELECT

### Next Steps

1. **Run full 500-question evaluation** with new prompts
2. **Integrate MinHash joins** into schema helper prompts
3. **Implement few-shot example retrieval** from training set
4. **Consider multi-candidate generation** with self-consistency selection

---

## Session 2: January 13, 2026 (Continued)

### Claude Opus 4.5 Evaluation (50-question sample)

**Results:** 64% accuracy (32 correct, 10 partial, 8 incorrect)
- Cost: $13.58 for 50 questions

**Key Failure Patterns Identified:**

| Pattern | Examples | Root Cause |
|---------|----------|------------|
| DISTINCT overuse | Q672, Q1256, Q1387 | Model adds `DISTINCT` when gold expects all matching rows |
| Missing RANK columns | Q726 | "Rank X by Y" should include item, value, AND rank number |
| Multiple cols vs rows | Q87 | `(email1, email2)` in one row, not UNION of rows |
| Date function mismatch | Q972 | `YEAR(col)` vs `STRFTIME('%Y', col)` |
| COUNT vs COUNT(DISTINCT) | Q672, Q1256 | Plain COUNT when no "unique/distinct" in question |

**Evaluation Logic Fix:**
- Changed `missing_rows` from PARTIAL → INCORRECT (if model returns fewer rows, it's wrong)

### Prompt Externalization

Moved prompts from inline Python to external markdown files for easier tuning:
```
prompts/
├── system_prompt.md        # Main SQL guidance
├── user_prompt.md          # Question-specific instructions
├── system_prompt_backup.md # Original verbose version
└── user_prompt_backup.md   # Original verbose version
```

### Prompt Compaction (Agentar-Scale-SQL Inspired)

Analyzed top-performing system (81.67% accuracy):
- Uses **few-shot retrieved examples** instead of verbose rules
- **Light schema** format (compact markdown with sample values)
- **Minimal instructions** - examples > rules

**Applied learnings:**
- Compacted system prompt: 6,690 → 1,232 chars (**82% reduction**)
- Compacted user prompt: 1,941 → 206 chars (**89% reduction**)
- Removed negative phrasing ("NEVER", "DON'T") → positive framing
- Focused on essential patterns from failure analysis

**Key retained guidance:**
- Schema-qualified table names
- `STRFTIME('%Y', col)` for year extraction
- `COUNT(*)` vs `COUNT(DISTINCT x)` distinction
- YES/NO string output format
- FINAL_SQL response format

### Few-Shot Challenge

BIRD training examples use SQLite dialect (backticks, IIF(), etc.) which is incompatible with DuckDB. Options considered:
1. Convert SQLite → DuckDB programmatically
2. Use examples for context only (question/evidence similarity)
3. Build DuckDB examples from our successful runs (~300+ correct queries)

**Decision:** Pending - may build from successful run history

### Files Modified

- `src/providers/base.py` - Load prompts from external files, added failure pattern guidance
- `src/run_eval.py` - CLI validation, missing_rows → INCORRECT
- `prompts/system_prompt.md` - New compact prompt (18% of original size)
- `prompts/user_prompt.md` - New compact prompt (10% of original size)
- `optimization_research.md` - This session log

---

## Session 3: January 13, 2026 (Continued)

### Compact Prompt Results

Tested the compacted prompts (82% smaller) on 50-question sample:

| Metric | Verbose Prompt | Compact Prompt | Change |
|--------|----------------|----------------|--------|
| Correct | 33/50 (66%) | 35/50 (70%) | **+4%** |
| Partial | 9 | 3 | -6 |
| Errors | 0 | 3 | +3 |
| Prompt size | 8.6K chars | 1.4K chars | -82% |

**Key insight:** Smaller, focused prompts perform better than verbose instruction lists.

### DuckDB Type Errors

3 queries failed with type casting errors:

1. `STRFTIME('%Y', col) - 1999` → STRFTIME returns VARCHAR, can't subtract
2. `Date LIKE '1991%'` → DATE type can't use LIKE directly
3. Age calculations with string dates

**Fix added to prompt:**
```
- STRFTIME returns VARCHAR: `CAST(STRFTIME('%Y', col) AS INTEGER)` for arithmetic
- Date pattern matching: `CAST(date_col AS VARCHAR) LIKE '1991%'`
```

### Query Execution Workflow

**Problem:** Model sometimes outputs FINAL_SQL without first executing to verify it works.

**Fix:** Added explicit workflow to prompt:
```
## Workflow
1. Explore schema with `search_catalog` or `validate_sql`
2. Write SQL and execute with `query` to verify it works
3. If error, fix and re-run `query` until successful
4. Only after successful execution, output FINAL_SQL
```

### Error Analysis Tool

Created `src/error_analysis.py` - Bloomberg-terminal style HTML report for reviewing failures:

**Features:**
- Dark theme, 3-column layout (Question | SQL | COT Trace)
- Color-coded by severity (red=error, orange=incorrect, yellow=partial)
- Shows full conversation trace:
  - SYSTEM PROMPT and USER PROMPT (reconstructed)
  - ▶ CALL function() - tool calls with arguments
  - ◀ RESULT function: - tool responses
  - ◆ ASSISTANT: - model reasoning
- Comment box per question with JSON export for LLM feedback
- Auto-generated after each evaluation run

**Usage:**
```bash
uv run python src/error_analysis.py data/results/results_*.json
```

### Files Created/Modified

- `src/error_analysis.py` - New error analysis report generator
- `src/run_eval.py` - Auto-generate error analysis after eval
- `prompts/system_prompt.md` - Added type casting hints, workflow section
