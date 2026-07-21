---
id: sql-avg-fee
domain: sql_patterns
summary: Average fee a card scheme charges for a transaction value, and cheapest/most-expensive scheme (templates T03, T04, T05, T10, T11).
---
These are **rule-level** questions with no merchant and no real transaction —
they ask "what would the average fee be for a transaction of {V} eur" given some
filters. Work directly off `fees`, substituting V into the formula, and average
over the **distinct matching fee rules** (each `ID` is one rule).

Filters come from the question and use the same wildcard/list semantics as
`fees-matching-9dim` (NULL/empty list = any):

```sql
-- T03/T04: account_type {AT} (+ optional MCC), avg fee for {scheme} at {V} eur, 6 decimals
SELECT ROUND(AVG(fixed_amount + rate / 10000.0 * 5000.0), 6) AS avg_fee
FROM fees
WHERE card_scheme = 'NexPay'
  AND (account_type IS NULL OR len(account_type) = 0 OR list_contains(account_type, 'F'))
  -- if an MCC description is given, resolve it via merchant_category_codes then:
  -- AND (merchant_category_code IS NULL OR len(merchant_category_code)=0 OR list_contains(merchant_category_code, <mcc>))
;

-- T05: "for credit transactions" → add is_credit filter
--   AND (is_credit IS NULL OR is_credit = TRUE)
```

```sql
-- T10/T11: in the average scenario, which card scheme is cheapest / most expensive for {V} eur
SELECT card_scheme
FROM fees
GROUP BY card_scheme
ORDER BY AVG(fixed_amount + rate / 10000.0 * 1234.0) ASC    -- ASC = cheapest, DESC = most expensive
LIMIT 1;
```

Rules:
- Substitute the literal transaction value into `rate/10000.0 * V`.
- Each fee `ID` is one rule already; a plain `AVG` over the filtered rules is the
  "average fee" (dedupe only if you joined something that duplicates ids).
- Only apply the dimensions the question constrains; leave the rest unfiltered.
- Watch the decimals in the guidelines (T03/T04 want 6).
