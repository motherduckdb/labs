---
id: sql-aci-fraud-steering
domain: sql_patterns
summary: Which ACI to steer fraudulent transactions to for the lowest fees (templates T08, T17).
---
"For {merchant} in {month}/{year}, if we moved the fraudulent transactions to a
different ACI (by changing the interaction), which ACI gives the lowest fees?"

> **READ FIRST — this is ACI steering, NOT card-scheme steering.** You are choosing
> ONE **ACI** (a single letter A–E). The card scheme never changes. The question's
> guideline says `format: {card_scheme}:{fee}` — that guideline is **mislabeled and
> WRONG for this question**; ignore it. `GROUP BY c.aci` (the candidate ACI), NOT
> `card_scheme`. The final answer is exactly one letter, e.g. `D` — no scheme, no fee,
> no breakdown. If your output contains a card-scheme name or a `:`, it is wrong.

Take the merchant's **fraudulent** transactions in the window, and for each
candidate ACI in **A–E** recompute the total fee as if every one of those
transactions had used that ACI. Return the ACI with the lowest total.

**Candidate set is A–E only — exclude BOTH F and G.** Only A–E are valid steering
targets (incentivizable interactions); F and G are not. Validated 25/25 across
T08+T17. Including F flips Belles_cookbook_store tasks from the gold `E` to a wrong
`F` (F can have a lower raw total but isn't a valid target). (This differs from the
"most-expensive ACI" pattern, which uses A–F.)

The template below is **self-contained — copy it whole.** The `monthly_stats` and
`mp` CTEs are the canonical ones from `fees-matching-9dim`; do NOT improvise your
own bucket ranges (the capture_delay buckets are exactly `<3` / `3-5` / `>5` plus
`immediate`/`manual` kept as-is — any other bucketing mismatches the fees table
and silently steers to the wrong ACI).

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
mp AS (   -- merchant profile, with capture_delay bucketed (buckets are FIXED: <3 / 3-5 / >5)
  SELECT m.merchant, m.account_type, m.merchant_category_code,
    CASE WHEN TRY_CAST(m.capture_delay AS INTEGER) < 3 THEN '<3'
         WHEN TRY_CAST(m.capture_delay AS INTEGER) BETWEEN 3 AND 5 THEN '3-5'
         WHEN TRY_CAST(m.capture_delay AS INTEGER) > 5 THEN '>5'
         ELSE m.capture_delay END AS capture_delay_range  -- keep 'immediate'/'manual' AS-IS
  FROM merchants m
),
frauds AS (   -- the merchant's fraudulent transactions in the window
  SELECT * FROM payments
  WHERE merchant = 'Golfclub_Baron_Friso' AND year = 2023
    AND MONTH(MAKE_DATE(year,1,1)+INTERVAL (day_of_year-1) DAY) = 1
    AND has_fraudulent_dispute
),
cand(aci) AS (SELECT UNNEST(['A','B','C','D','E'])),   -- A–E only; NOT F or G
-- join frauds × candidate ACI × fees, matching all 9 dims but with the CANDIDATE aci
costs AS (
  SELECT c.aci,
         SUM(f.fixed_amount + f.rate/10000.0 * p.eur_amount) AS total_fee
  FROM frauds p
  CROSS JOIN cand c
  JOIN mp ON mp.merchant = p.merchant            -- merchant profile (account_type, mcc, capture bucket)
  JOIN monthly_stats ms ON ms.merchant=p.merchant AND ms.year=p.year
       AND ms.month = MONTH(MAKE_DATE(p.year,1,1)+INTERVAL (p.day_of_year-1) DAY)
  JOIN fees f
    ON (f.card_scheme IS NULL OR f.card_scheme = p.card_scheme)
   AND (f.is_credit IS NULL OR f.is_credit = p.is_credit)
   AND (f.intracountry IS NULL OR f.intracountry::BOOLEAN = (p.issuing_country = p.acquirer_country))
   AND (f.aci IS NULL OR len(f.aci)=0 OR list_contains(f.aci, c.aci))   -- candidate ACI here
   AND (f.account_type IS NULL OR len(f.account_type)=0 OR list_contains(f.account_type, mp.account_type))
   AND (f.merchant_category_code IS NULL OR len(f.merchant_category_code)=0 OR list_contains(f.merchant_category_code, mp.merchant_category_code))
   AND (f.capture_delay IS NULL OR f.capture_delay = mp.capture_delay_range)
   AND (f.monthly_volume IS NULL OR f.monthly_volume = ms.volume_range)
   AND (f.monthly_fraud_level IS NULL OR f.monthly_fraud_level = ms.fraud_level_range)
  GROUP BY c.aci
)
SELECT aci FROM costs ORDER BY total_fee ASC, aci LIMIT 1;
```

Rules:
- Use the `monthly_stats`/`mp` CTEs above verbatim — the bucket boundaries come
  from the manual (see `fees-matching-9dim`), not from the data.
- The candidate ACI replaces the transaction's real ACI in the fee match.
- ONE overall ACI across all card schemes — do NOT break down per scheme.
- "Lowest fees" → `ORDER BY total_fee ASC`.
- **Candidate ACIs are A–E only.** Never include F or G.
- **Output: ONE ACI letter. Nothing else.** The question's guideline shows
  `{card_scheme}:{fee}` — **that guideline is misleading; the gold is the single ACI
  letter** (e.g. `E`). Never `GROUP BY card_scheme`, never append a fee.
  ```
  RIGHT:  E
  WRONG:  TransactPlus:27.51      (per-scheme breakdown + fee — the guideline trap)
  WRONG:  E GlobalCard:0.0,...    (letter + breakdown)
  WRONG:  F:32.45                 (forgot to exclude F)
  ```
  Canonical final line — return exactly this shape (one row, one column, the letter):
  ```sql
  SELECT aci FROM costs ORDER BY total_fee ASC, aci LIMIT 1;
  ```
