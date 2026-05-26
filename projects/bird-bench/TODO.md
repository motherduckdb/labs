# BIRD-Bench TODO

## High Priority

### Iterative Schema Linking

Based on "Automatic Metadata Extraction for Text-to-SQL" (arXiv:2505.19988), implement iterative schema linking to catch column name mismatches.

**Current approach (one-shot):**
```
Question → Embed → Find top-k similar tables → Done
```

**Target approach (iterative):**
```
Question → Initial schema selection → LLM generates SQL
                                           ↓
                              Extract referenced columns/tables
                                           ↓
                              Any unknown references? ──No──→ Done
                                           ↓ Yes
                              Use LSH/fuzzy match to find
                              similar column names in full schema
                                           ↓
                              Add matched tables to context
                                           ↓
                              Re-prompt LLM with augmented schema
                                           ↓
                              (repeat until convergence)
```

**Implementation steps:**
1. [ ] Create SQL parser to extract table/column references from generated SQL
2. [ ] Build LSH or fuzzy index over all columns in each database schema
3. [ ] Add validation step after SQL generation to check if referenced columns exist
4. [ ] Implement correction loop in provider that suggests alternatives for unknown columns
5. [ ] Add max iterations limit to prevent infinite loops
6. [ ] Benchmark on 10 questions to measure improvement

**Expected benefit:** Catches hallucinated column names and suggests corrections before final SQL execution.

---

## Medium Priority

### Fix Profile Generation for Problem Databases

Two databases fail to profile due to date parsing issues in DuckDB's SUMMARIZE:
- `thrombosis_prediction` - date string format issues
- `toxicology` - NAType handling issues

**Steps:**
1. [ ] Investigate specific column types causing failures
2. [ ] Add try/catch per-column in profiler to handle edge cases
3. [ ] Fall back to manual statistics queries for problem columns

### Evaluate Descriptions on Larger Sample

LLM descriptions didn't improve accuracy on 10 questions. Test on larger sample to see if they help with specific question types.

**Steps:**
1. [ ] Run 50-question benchmark with and without descriptions
2. [ ] Analyze which question types benefit from semantic descriptions
3. [ ] Consider making descriptions optional per-question based on complexity

---

## Low Priority

### Query Log Analysis for Join Discovery

The paper found 25%+ of join constraints in BIRD were not documented in the SQLite schema. Analyze gold SQL queries to discover implicit joins.

**Steps:**
1. [ ] Parse all gold SQL queries from dev set
2. [ ] Extract JOIN conditions
3. [ ] Compare against documented foreign keys
4. [ ] Add discovered joins to FK metadata

### Cost Tracking Dashboard

Build visualization for cost/accuracy tradeoffs across configurations.

**Steps:**
1. [ ] Aggregate results from all benchmark runs
2. [ ] Create cost vs accuracy scatter plot
3. [ ] Track cost per correct answer metric
