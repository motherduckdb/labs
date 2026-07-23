---
id: sql-hypothetical-mcc-delta
domain: sql_patterns
summary: Fee delta if a merchant had a different MCC before the year started (template T09).
---
"Imagine merchant {M} had changed its MCC to {new_mcc} before {year} started —
what fee delta for {year}?" → `hypothetical_total - actual_total`.

Compute both totals with the SAME 9-dimension matching; the only change is the
MCC used in the `merchant_category_code` match. Easiest: parameterize the
merchant profile's MCC.

```sql
WITH monthly_stats AS ( ... ),   -- from fees-matching-9dim, filtered to merchant M, year Y
mp_actual AS (   -- real profile
  SELECT merchant, account_type, merchant_category_code AS mcc, <capture_delay_range>
  FROM merchants WHERE merchant = 'Crossfit_Hanna'
),
mp_hypo AS (     -- same profile but overridden MCC
  SELECT merchant, account_type, CAST(5911 AS BIGINT) AS mcc, <capture_delay_range>
  FROM merchants WHERE merchant = 'Crossfit_Hanna'
),
fees_for AS (    -- reusable: total fee given a profile's mcc value
  -- join payments(M,Y) to fees using mp.mcc in the MCC dimension, all other dims as usual
  ...
)
SELECT ROUND(
  (SELECT SUM(fee_amount) FROM matched_hypo) -
  (SELECT SUM(fee_amount) FROM matched_actual), 6) AS delta;
```

Practical approach that avoids bugs:
1. Compute `actual_total` = total fees for M in Y via `sql-total-fees-merchant`.
2. Compute `hypo_total` = the same query, but in the fee join replace the MCC
   match with the new code: `list_contains(f.merchant_category_code, 5911) OR len=0 OR NULL`.
3. `delta = ROUND(hypo_total - actual_total, <decimals>)`.

Rules:
- Re-run the FULL 9-dimension match for both — monthly_volume/fraud buckets and
  all other dimensions stay the same; only MCC differs.
- Do NOT pick a single "most specific" fee — all matching rules sum (both sides).
- Round per guidelines (often 6 decimals here).
