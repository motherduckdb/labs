---
id: sql-fee-id-applicability
domain: sql_patterns
summary: "Which merchants are affected by a fee id" incl. "if fee X were only applied to account_type Y, which merchants would be affected" (T01); which merchants a fee affected in a year (T14); which fee ids apply to a given account_type + aci (T24).
---
**T24 — "fee id(s) that apply to account_type {AT} and aci {X}"** (attribute-only,
no merchant/period). Scan `fees` with wildcard/list semantics:
```sql
SELECT STRING_AGG(ID::VARCHAR, ', ' ORDER BY ID) AS fee_ids
FROM fees
WHERE (account_type IS NULL OR len(account_type)=0 OR list_contains(account_type, 'F'))
  AND (aci IS NULL OR len(aci)=0 OR list_contains(aci, 'D'));
```
**This returns ~150+ ids, not a handful.** Most rules match via the wildcard
(NULL/empty list = matches any), so the answer is large. If you get only a few ids
you used exact list-equality — wrong.
```
RIGHT:  (account_type IS NULL OR len(account_type)=0 OR list_contains(account_type,'D'))
WRONG:  account_type = ['D']     -- drops every wildcard rule and multi-value list → far too few ids
```
Match each list dimension with `list_contains(...)` plus the `IS NULL OR len(...)=0`
wildcard guard — **never** `account_type = ['D']` / `aci = ['X']`.

**T14 — "in {year}, which merchants were affected by fee id {X}?"** A merchant is
affected if any of its {year} transactions match fee id X. Use the `matched` CTE
(`fees-matching-9dim`) and take the DISTINCT merchants for that fee id:
```sql
-- ... WITH ... matched AS (...) ...
SELECT STRING_AGG(DISTINCT merchant, ', ' ORDER BY merchant) AS merchants
FROM matched
WHERE year = 2023 AND fee_id = 384;
```

**T01 — "during {year}, imagine fee id {X} was only applied to account_type {AT};
which merchants would have been affected by this change?"** "Affected" = merchants
who CURRENTLY receive fee X but would **lose** it under the hypothetical.
Restricting a fee to {AT} can only *remove* matches, so the affected merchants are
those whose {year} transactions match fee X **as the rule is actually defined**
(including its real `account_type` list) and whose own merchant `account_type <> {AT}`.
Do NOT force `account_type = {AT}` — that's the merchants who KEEP the fee, not the
ones affected.

Worked example: fee 787 has `account_type=['D']`, so as-defined it matches only
Rafa_AI (account_type D). "Only applied to R" (or H, or anything ≠ D) → Rafa_AI loses
it → answer `Rafa_AI`.
```
RIGHT:  Rafa_AI                                  (matched-as-defined, account_type ≠ AT)
WRONG:  Belles_cookbook_store, Rafa_AI           (added the account_type=R merchant — that one KEEPS the fee)
```
```sql
-- match fee X exactly as defined, then keep merchants whose account_type <> {AT}
SELECT STRING_AGG(DISTINCT p.merchant, ', ' ORDER BY p.merchant) AS merchants
FROM payments p
JOIN mp ON mp.merchant = p.merchant
JOIN monthly_stats ms ON ms.merchant=p.merchant AND ms.year=p.year
     AND ms.month = MONTH(MAKE_DATE(p.year,1,1)+INTERVAL (p.day_of_year-1) DAY)
JOIN fees f ON f.ID = 787            -- the specific fee id {X}
   AND (f.account_type IS NULL OR len(f.account_type)=0 OR list_contains(f.account_type, mp.account_type))
   AND mp.account_type <> 'R'        -- the imposed account_type {AT}: keep merchants who LOSE the fee
   AND (f.card_scheme IS NULL OR f.card_scheme = p.card_scheme)
   AND (f.is_credit IS NULL OR f.is_credit = p.is_credit)
   AND (f.intracountry IS NULL OR f.intracountry::BOOLEAN = (p.issuing_country = p.acquirer_country))
   AND (f.aci IS NULL OR len(f.aci)=0 OR list_contains(f.aci, p.aci))
   AND (f.merchant_category_code IS NULL OR len(f.merchant_category_code)=0 OR list_contains(f.merchant_category_code, mp.merchant_category_code))
   AND (f.capture_delay IS NULL OR f.capture_delay = mp.capture_delay_range)
   AND (f.monthly_volume IS NULL OR f.monthly_volume = ms.volume_range)
   AND (f.monthly_fraud_level IS NULL OR f.monthly_fraud_level = ms.fraud_level_range)
WHERE p.year = 2023;
```
(Define `mp`, `monthly_stats` as in `fees-matching-9dim`.)

Rules:
- T01 keeps fee X's account_type dimension AS DEFINED; {AT} is used only to
  EXCLUDE via `mp.account_type <> {AT}`. Result = merchants matched by fee X in
  {year} whose account_type ≠ {AT} (they lose the fee). DISTINCT merchants.
- T14/T20 ("which merchants were affected by fee X" / "applicable fee ids for a
  merchant") use the plain `matched` set with no account_type exclusion.
- Output shape per guidelines (comma list / bracketed list — see `format-lists-kv`).
- Empty → `""`.
