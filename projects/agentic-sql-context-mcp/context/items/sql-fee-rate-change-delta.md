---
id: sql-fee-rate-change-delta
domain: sql_patterns
summary: Delta a merchant would pay if a specific fee id's rate changed (templates T12, T13).
---
"In {year} (or {month} {year}) what delta would {merchant} pay if the relative
fee of fee id {X} changed to {new_rate}?"

Only the rows where that fee id matched are affected. The fixed_amount is
unchanged; only `rate` changes, so the per-row delta is
`(new_rate - rate) / 10000.0 * eur_amount`. Sum over the merchant's matched rows
for that fee id in the window.

```sql
-- REQUIRED: paste the full `matched` CTE verbatim from fees-matching-9dim (all 9
-- dimensions). Do NOT hardcode/approximate the match in a flat WHERE clause — fees
-- often constrain capture_delay / account_type / mcc / monthly_volume /
-- monthly_fraud_level, and skipping any dimension silently includes/excludes rows.
SELECT ROUND(SUM((99 - rate) / 10000.0 * eur_amount), 2) AS delta
FROM matched
WHERE merchant = 'Rafa_AI'
  AND year = 2023
  AND fee_id = 276;            -- the fee whose rate changes to 99
-- month variant: AND MONTH(MAKE_DATE(year,1,1)+INTERVAL (day_of_year-1) DAY)=M
```

Rules:
- **If no transactions match the fee in the window, the delta is `0`, not empty.**
  Wrap the sum: `ROUND(COALESCE(SUM((new_rate - rate)/10000.0 * eur_amount), 0), N)`.
  A fee that doesn't apply means zero change — report `0` (to the guideline's decimals,
  e.g. `0.00000000000000`), never `""` or "Not Applicable".
- Positive delta = pays MORE; negative = pays LESS.
- The affected rows MUST come from the full 9-dim `matched` CTE filtered to the single
  `fee_id` — never a `payments`-only filter. Inspect the fee row's dims first.
- Use `rate` (the original) from the matched rows; substitute the new rate as a literal.
- Only the named `fee_id` rows change — do not touch other matching rules.
- Follow the guideline's rounding (often "14 decimals" → `ROUND(..., 14)`).
