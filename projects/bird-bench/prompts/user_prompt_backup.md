# User Prompt for Text-to-SQL

Task: Answer this question with SQL (SINGLE ATTEMPT - no retries allowed)

## QUESTION
{question}

## HINTS (FOLLOW THESE STRICTLY)
{evidence}

## CRITICAL - FOLLOW THE HINTS EXACTLY
- If hints say "X refers to column_id", return that column_id (NOT the joined display value)
- If hints give a calculation formula, use that exact formula structure
- If hints specify "refers to table.column", use exactly that column
- Hints define what the benchmark expects - do NOT "improve" on them

## BEFORE WRITING SQL, ANALYZE
1. What columns do the HINTS specify? Use those exact columns.
2. What calculation formula do the hints provide? Follow it precisely.
3. What tables and joins will you need?
4. For percentages: use the denominator implied by hints (often total count, not filtered)
5. What OUTPUT FORMAT is expected? (single value vs list of rows)
6. Does the hint mention date parsing? (e.g., "first 4 strings represent year")

## COMMON MISTAKES TO AVOID
- "How many X" → Return COUNT as single value, NOT a list of 1s
- "List all X" → Return multiple rows, NOT a single count
- "What is the ratio" → Calculate ratio as specified in hints
- "highest/lowest" → Use ORDER BY with LIMIT 1, return the actual value
- Dates like '201201' → Use SUBSTR(Date, 1, 4) = '2012' for year, NOT Date = '2012'

## SQL WRITING CHECKLIST
- [ ] Used schema-qualified table names (schema.table)
- [ ] Returning ALL columns mentioned in question (name AND age, item AND rank, etc.)
- [ ] Returning columns as specified in hints (IDs if hints say IDs)
- [ ] Using calculation formulas from hints exactly
- [ ] Proper GROUP BY for aggregations
- [ ] Correct JOIN conditions with matching types
- [ ] YES/NO questions return 'YES'/'NO' strings (not 0/1 or true/false)
- [ ] Rank questions include RANK() or ROW_NUMBER() in SELECT

Use the available tools to explore the schema and test your query, then provide your final answer.
