---
id: bucketing-month
domain: bucketing
summary: Deriving calendar month from day_of_year, and the "Nth of the year" trap.
---
There is no month column. Derive the calendar month from `year` + `day_of_year`:

```sql
MONTH(MAKE_DATE(year, 1, 1) + INTERVAL (day_of_year - 1) DAY) AS month
```

- **"in [Month] [Year]"** → filter on this derived month: `... = M`.
- **"the Nth of the year"** → `day_of_year = N` (it is the Nth **day**, NOT month N).
- Monthly volume/fraud buckets (see `bucketing-monthly`) are grouped by this
  derived month, always full natural months (day 1 to month end).

Month names → numbers: January=1 … December=12.
