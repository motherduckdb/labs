---
id: sql-total-fees-merchant
domain: sql_patterns
summary: Total fees a merchant paid in a day / month / year (templates T07, T21, T22).
---
Build the `matched` CTE from `fees-matching-9dim`, then sum `fee_amount` over the
period. Filter on the merchant and the time window in the final SELECT.

```sql
-- ... WITH monthly_stats, mp, matched AS (...)  [from fees-matching-9dim] ...
SELECT ROUND(SUM(fee_amount), 2) AS total_fees
FROM matched
WHERE merchant = 'Belles_cookbook_store'
  AND year = 2023
  AND day_of_year = 12;          -- "the 12th of the year 2023"
```

Variants:
- **In a month**: add `AND MONTH(MAKE_DATE(year,1,1)+INTERVAL (day_of_year-1) DAY) = M`.
- **In a year**: just `year = Y`.

Rules:
- `SUM(fee_amount)` counts every matching rule per transaction (correct — fees stack).
- Do NOT sum `eur_amount` over `matched`; it's duplicated per matching rule.
- Round per the guidelines (usually 2 decimals).
- If the merchant has no transactions in the window, the result is empty → answer `""`.
