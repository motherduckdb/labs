---
id: sql-applicable-fee-ids
domain: sql_patterns
summary: Which fee ids apply to a merchant on a day / month / year (templates T06, T20, T26).
---
"What are the applicable fee ids for {merchant} in {period}?" → the DISTINCT
`fee_id`s from the `matched` CTE (`fees-matching-9dim`), restricted to the
merchant's transactions in that period.

```sql
-- ... WITH ... matched AS (...) [from fees-matching-9dim] ...
SELECT STRING_AGG(fee_id::VARCHAR, ', ' ORDER BY fee_id) AS fee_ids
FROM (
  SELECT DISTINCT fee_id
  FROM matched
  WHERE merchant = 'Martinis_Fine_Steakhouse'
    AND year = 2023
    AND day_of_year = 10           -- or a month / whole year
);
```

Rules:
- These are the fee ids that actually matched **real transactions** of the
  merchant in the window — built from `matched`, not from scanning `fees` against
  the merchant profile alone (the period's monthly_volume/fraud buckets matter).
- **De-dupe in a subquery, then `STRING_AGG`** as shown. Do NOT write
  `STRING_AGG(DISTINCT fee_id::VARCHAR, ', ' ORDER BY fee_id)` — DuckDB rejects a
  `DISTINCT` aggregate whose `ORDER BY` expression isn't identical to the
  aggregated argument ("ORDER BY expressions must appear in the argument list").
- Check the guidelines for output shape (often a comma-separated list or a
  bracketed list). See `format-lists-kv`. Sort numerically if asked; otherwise the
  order-insensitive scorer accepts any order.
- Empty (no transactions) → `""`.
