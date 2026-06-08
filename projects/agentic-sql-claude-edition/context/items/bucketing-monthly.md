---
id: bucketing-monthly
domain: bucketing
summary: monthly_volume and monthly_fraud_level bucket boundaries, computed per merchant per calendar month.
---
Fee rules filter on a merchant's **monthly** volume and fraud tier. Compute these
per merchant per **calendar month** (see `bucketing-month`), then bucket:

**Monthly volume** = `SUM(eur_amount)` for the merchant that month:
- `<100k` : < 100,000
- `100k-1m` : 100,000 – 1,000,000
- `1m-5m` : 1,000,000 – 5,000,000
- `>5m` : ≥ 5,000,000

**Monthly fraud level** = `SUM(fraud_amount) / SUM(total_amount) * 100` that month
(amount-weighted, on a 0–100 scale):
- `<7.2%`, `7.2%-7.7%`, `7.7%-8.3%`, `>8.3%`

```sql
CASE WHEN SUM(eur_amount) < 100000 THEN '<100k'
     WHEN SUM(eur_amount) < 1000000 THEN '100k-1m'
     WHEN SUM(eur_amount) < 5000000 THEN '1m-5m'
     ELSE '>5m' END AS volume_range,
CASE WHEN SUM(CASE WHEN has_fraudulent_dispute THEN eur_amount ELSE 0 END)
          / NULLIF(SUM(eur_amount), 0) * 100 < 7.2 THEN '<7.2%'
     WHEN ... < 7.7 THEN '7.2%-7.7%'
     WHEN ... < 8.3 THEN '7.7%-8.3%'
     ELSE '>8.3%' END AS fraud_level_range
```
Use strict `<` at each boundary (matches the reference behavior). These buckets
plug into the `fees-matching-9dim` CTE.
