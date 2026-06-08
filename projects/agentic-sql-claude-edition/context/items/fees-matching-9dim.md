---
id: fees-matching-9dim
domain: fees
summary: The canonical 9-dimension fee-rule match against the raw tables (NULL/empty = wildcard, list columns, all rules sum).
---
A transaction matches a fee rule when it satisfies **all 9 dimensions**. `NULL`
(or an empty list for `account_type`/`aci`/`merchant_category_code`) means
"matches anything". **ALL matching rules apply — there is no "most specific wins".**
A transaction can match several rules; their fees are summed.

The 9 dimensions: `card_scheme`, `account_type`, `aci`, `is_credit`,
`intracountry`, `merchant_category_code`, `capture_delay`, `monthly_volume`,
`monthly_fraud_level`.

**Canonical match CTE (copy this; raw tables, correct list semantics).** It
attaches every matching fee rule to every transaction and computes the per-rule
fee. Filter the final SELECT to the merchant/year/period the question asks for:

```sql
WITH monthly_stats AS (   -- volume & fraud buckets per merchant per calendar month
  SELECT merchant, year,
    MONTH(MAKE_DATE(year, 1, 1) + INTERVAL (day_of_year - 1) DAY) AS month,
    CASE WHEN SUM(eur_amount) < 100000 THEN '<100k'
         WHEN SUM(eur_amount) < 1000000 THEN '100k-1m'
         WHEN SUM(eur_amount) < 5000000 THEN '1m-5m'
         ELSE '>5m' END AS volume_range,
    CASE WHEN SUM(CASE WHEN has_fraudulent_dispute THEN eur_amount ELSE 0 END)
              / NULLIF(SUM(eur_amount), 0) * 100 < 7.2 THEN '<7.2%'
         WHEN SUM(CASE WHEN has_fraudulent_dispute THEN eur_amount ELSE 0 END)
              / NULLIF(SUM(eur_amount), 0) * 100 < 7.7 THEN '7.2%-7.7%'
         WHEN SUM(CASE WHEN has_fraudulent_dispute THEN eur_amount ELSE 0 END)
              / NULLIF(SUM(eur_amount), 0) * 100 < 8.3 THEN '7.7%-8.3%'
         ELSE '>8.3%' END AS fraud_level_range
  FROM payments
  GROUP BY merchant, year, month
),
mp AS (   -- merchant profile, with capture_delay bucketed
  SELECT m.merchant, m.account_type, m.merchant_category_code,
    CASE WHEN TRY_CAST(m.capture_delay AS INTEGER) < 3 THEN '<3'
         WHEN TRY_CAST(m.capture_delay AS INTEGER) BETWEEN 3 AND 5 THEN '3-5'
         WHEN TRY_CAST(m.capture_delay AS INTEGER) > 5 THEN '>5'
         ELSE m.capture_delay END AS capture_delay_range  -- keep 'immediate'/'manual' AS-IS; never remap to '<3'
  FROM merchants m
),
matched AS (
  SELECT p.*, f.ID AS fee_id, f.fixed_amount, f.rate,
         f.fixed_amount + f.rate / 10000.0 * p.eur_amount AS fee_amount
  FROM payments p
  JOIN mp ON mp.merchant = p.merchant
  JOIN monthly_stats ms
    ON ms.merchant = p.merchant AND ms.year = p.year
   AND ms.month = MONTH(MAKE_DATE(p.year, 1, 1) + INTERVAL (p.day_of_year - 1) DAY)
  JOIN fees f
    ON (f.card_scheme IS NULL OR f.card_scheme = p.card_scheme)
   AND (f.is_credit  IS NULL OR f.is_credit  = p.is_credit)
   AND (f.intracountry IS NULL OR f.intracountry::BOOLEAN = (p.issuing_country = p.acquirer_country))
   AND (f.aci IS NULL OR len(f.aci) = 0 OR list_contains(f.aci, p.aci))
   AND (f.account_type IS NULL OR len(f.account_type) = 0 OR list_contains(f.account_type, mp.account_type))
   AND (f.merchant_category_code IS NULL OR len(f.merchant_category_code) = 0
        OR list_contains(f.merchant_category_code, mp.merchant_category_code))
   AND (f.capture_delay IS NULL OR f.capture_delay = mp.capture_delay_range)
   AND (f.monthly_volume IS NULL OR f.monthly_volume = ms.volume_range)
   AND (f.monthly_fraud_level IS NULL OR f.monthly_fraud_level = ms.fraud_level_range)
)
SELECT * FROM matched;
```

Notes:
- `fee_amount` already applies the formula (see `fees-formula`).
- One transaction → multiple `matched` rows (one per matching fee rule). So do
  **not** SUM/COUNT `eur_amount` over `matched` — it is duplicated per rule.
- For totals: `SUM(fee_amount)`. For "which fee ids apply": `DISTINCT fee_id`.
- `intracountry::BOOLEAN` handles the column whether it's stored boolean or 1.0/0.0.
- Verify column types first with `list_columns('fees')` and a `LIMIT 5` peek.
