# Prompt Improvements Based on Failure Analysis (Jan 13, 2026)

## Analysis Summary

From 500-question evaluation (62.2% accuracy = 311 correct):
- 110 wrong answers (22.0%)
- 79 partial matches (15.8%)
- 0 errors (schema validation working well)

## Key Failure Patterns Identified

### 1. Type Mismatch (46 failures)
Model returns different data types than expected (e.g., string vs int, single value vs list)

### 2. Count Errors (26 failures)
- 13 cases: Used COUNT when SUM should be used
- 9 cases: Used SUM when COUNT should be used
- Confusion about "how many" vs "total"

### 3. Percentage/Ratio Errors (18 failures)
Wrong calculation formulas, wrong denominators

### 4. Date Extraction (15 failures)
Not using SUBSTR to extract year/month from YYYYMM format dates

### 5. Missing DISTINCT (9 failures)
Duplicate rows when joining, missing COUNT(DISTINCT)

### 6. Format Mismatches
- Expected list, got single aggregated value
- Expected single value, got list
- Expected ID, got joined display value

## SQL Pattern Analysis

| Pattern | Count |
|---------|-------|
| missing_date_extraction | 15 |
| count_vs_sum | 13 |
| sum_vs_count | 9 |
| missing_distinct | 9 |
| extra_group_by | 7 |
| missing_case_when | 6 |
| missing_group_by | 5 |
| missing_conditional_agg | 4 |
| missing_limit | 3 |

## Worst Performing Databases

1. california_schools: 43.3%
2. financial: 46.9%
3. thrombosis_prediction: 56.0%
4. formula_1: 56.1%
5. card_games: 57.7%

## High-Failure Keywords

| Keyword | Fail Rate |
|---------|-----------|
| 'lowest' | 62.5% |
| 'difference' | 41.7% |
| 'average' | 36.6% |
| 'highest' | 34.5% |
| 'percentage' | 33.3% |

## Improvements Made to Prompts

### System Prompt Additions

1. **DATE EXTRACTION PATTERNS** - Explicit guidance for YYYYMM → SUBSTR(Date, 1, 4)
2. **COUNT vs SUM clarification** - When to use each
3. **Conditional aggregation patterns** - CASE WHEN for counting with conditions
4. **Result format patterns** - When to return list vs single value
5. **DISTINCT vs COUNT DISTINCT** - Clear distinction
6. **Database-specific notes** - california_schools, financial, thrombosis_prediction

### User Prompt Additions

1. **OUTPUT FORMAT analysis** - Consider whether single value or list expected
2. **Common mistakes to avoid** - Specific examples like "nationality vs currency"
3. **Date parsing reminders** - Check if hint mentions date format

## Expected Impact

- Addressing date extraction: +3% (15 failures)
- Addressing COUNT/SUM: +4.4% (22 failures)
- Addressing DISTINCT: +1.8% (9 failures)
- Addressing format: +2% (estimated)

Total expected improvement: **+5-10 percentage points** (to ~67-72%)

## Next Steps

1. Run evaluation with updated prompts
2. Analyze remaining failures
3. Consider implementing MinHash sketches for field resemblance (from paper)
4. Add more database-specific guidance as patterns emerge
