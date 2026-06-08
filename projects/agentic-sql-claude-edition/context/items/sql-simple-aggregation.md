---
id: sql-simple-aggregation
domain: sql_patterns
summary: Plain payments aggregations — counts, averages, group-by, date-range filters (template T23 and the easy questions).
---
Many questions are plain aggregations over `payments` with no fee logic:
counts, sums, averages, "top country", "grouped by X between months".

```sql
-- T23: avg transaction value grouped by {col} for {merchant} {scheme}, between months M1..M2 of {year}
SELECT day_of_year, ip_country, ...        -- whatever {group_col} is
       , ROUND(AVG(eur_amount), 2) AS avg_value
FROM payments
WHERE merchant = 'Rafa_AI' AND card_scheme = 'Visa' AND year = 2023
  AND MONTH(MAKE_DATE(year,1,1)+INTERVAL (day_of_year-1) DAY) BETWEEN 4 AND 6
GROUP BY 1
ORDER BY 1;
```

Reminders:
- "Top country for X" / "highest number of transactions" → `GROUP BY ... ORDER BY COUNT(*) DESC LIMIT 1`.
- For fraud questions, decide rate (amount-weighted) vs % of transactions
  (count-based) — see `terminology-term-mapping`.
- Derive months/days from `day_of_year` (see `bucketing-month`).
- Match the answer to the guidelines exactly (single value, code, list, rounding).
