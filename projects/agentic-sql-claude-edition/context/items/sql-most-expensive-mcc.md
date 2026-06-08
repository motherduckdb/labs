---
id: sql-most-expensive-mcc
domain: sql_patterns
summary: Most expensive MCC for a transaction of a given value, in general (template T25).
---
"What is the most expensive MCC for a transaction of {V} eur, in general? If
several tie, list all. Provide a list even if one element."

"In general" = no merchant, no other filters. Candidate MCCs are the DISTINCT MCCs
appearing in any fee rule's list. For each candidate, take the **AVERAGE** fee (at
value V) over **every rule that applies to it** — rules that explicitly list the MCC
**AND wildcard rules** (`merchant_category_code` NULL or empty, which apply to all
MCCs). Return the MCC(s) with the highest average.

```sql
WITH cands AS (
  SELECT DISTINCT UNNEST(merchant_category_code) AS mcc FROM fees
),
by_mcc AS (
  SELECT c.mcc,
         AVG(f.fixed_amount + f.rate / 10000.0 * 50000.0) AS avg_fee   -- V = 50000
  FROM cands c
  JOIN fees f
    ON (f.merchant_category_code IS NULL
        OR len(f.merchant_category_code) = 0
        OR list_contains(f.merchant_category_code, c.mcc))   -- INCLUDE wildcard rules
  GROUP BY c.mcc
)
SELECT STRING_AGG(mcc::VARCHAR, ', ' ORDER BY mcc)
FROM by_mcc
WHERE avg_fee = (SELECT MAX(avg_fee) FROM by_mcc);
```

Rules:
- Substitute the literal V into the formula.
- Use **AVG**, not SUM — the measure is the average per-rule fee for that MCC.
- **Include wildcard rules** (NULL/empty `merchant_category_code`) in each MCC's
  average — they apply to every MCC. Excluding them changes the ranking at low
  transaction values (wrong answer for V=1/5/10) — validated across all variations.
- Candidate MCCs come from unnesting the fee rules' lists (not from
  `merchant_category_codes`).
- Return ALL tied MCCs as a list (see `format-lists-kv`); confirm format/decimals
  in the guidelines.
