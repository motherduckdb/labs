---
id: sql-steering-card-scheme
domain: sql_patterns
summary: Which card scheme to steer a merchant's traffic to for min/max fees (templates T15, T16, T18, T19).
---
"Looking at {month}/{year}, to which card scheme should {merchant} steer traffic
to pay the minimum (or maximum) fees?"

Take the merchant's transactions in the window and recompute total fees as if ALL
of them had used each candidate card scheme; pick the min/max scheme.

```sql
WITH txns AS (
  SELECT * FROM payments
  WHERE merchant = 'Crossfit_Hanna' AND year = 2023
    AND MONTH(MAKE_DATE(year,1,1)+INTERVAL (day_of_year-1) DAY) = 3   -- omit for whole-year
),
cand(card_scheme) AS (SELECT DISTINCT card_scheme FROM fees WHERE card_scheme IS NOT NULL),
costs AS (
  SELECT c.card_scheme,
         SUM(f.fixed_amount + f.rate/10000.0 * p.eur_amount) AS total_fee
  FROM txns p
  CROSS JOIN cand c
  JOIN mp ON mp.merchant = p.merchant
  JOIN monthly_stats ms ON ms.merchant=p.merchant AND ms.year=p.year
       AND ms.month = MONTH(MAKE_DATE(p.year,1,1)+INTERVAL (p.day_of_year-1) DAY)
  JOIN fees f
    ON (f.card_scheme = c.card_scheme)                  -- candidate scheme here
   AND (f.is_credit IS NULL OR f.is_credit = p.is_credit)
   AND (f.intracountry IS NULL OR f.intracountry::BOOLEAN = (p.issuing_country = p.acquirer_country))
   AND (f.aci IS NULL OR len(f.aci)=0 OR list_contains(f.aci, p.aci))
   AND (f.account_type IS NULL OR len(f.account_type)=0 OR list_contains(f.account_type, mp.account_type))
   AND (f.merchant_category_code IS NULL OR len(f.merchant_category_code)=0 OR list_contains(f.merchant_category_code, mp.merchant_category_code))
   AND (f.capture_delay IS NULL OR f.capture_delay = mp.capture_delay_range)
   AND (f.monthly_volume IS NULL OR f.monthly_volume = ms.volume_range)
   AND (f.monthly_fraud_level IS NULL OR f.monthly_fraud_level = ms.fraud_level_range)
  GROUP BY c.card_scheme
)
SELECT card_scheme FROM costs ORDER BY total_fee ASC LIMIT 1;   -- ASC=min, DESC=max
```
(Define `mp`, `monthly_stats` as in `fees-matching-9dim`.)

Rules:
- Candidate scheme replaces the real `card_scheme` in the fee match for ALL the
  merchant's transactions; everything else (ACI, MCC, buckets…) stays real.
- Min fees → `ASC`; max fees → `DESC`.
- Return the scheme name (check guidelines for KV `scheme:fee` formatting).
