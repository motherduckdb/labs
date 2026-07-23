---
id: schema-fees
domain: schema
summary: Column dictionary for the fees rule table, including which columns are LIST types.
---
**`fees`** — fee rule definitions (read from fees.json). One row per rule `ID`.
A transaction can match MANY rules; see `fees-matching-9dim`.

Columns (native names):
- `ID` — fee rule id (integer).
- `card_scheme` — VARCHAR scalar. `NULL` = applies to any scheme.
- `account_type` — **LIST** of account-type letters, e.g. `['F','S']`. **Empty list `[]` or NULL = any.**
- `aci` — **LIST** of ACI letters, e.g. `['C','B']`. **Empty `[]` or NULL = any.**
- `merchant_category_code` — **LIST** of MCC integers, e.g. `[8000, 8011]`. **Empty `[]` or NULL = any.**
- `is_credit` — boolean scalar. `NULL` = any.
- `intracountry` — boolean scalar (true = domestic only). `NULL` = any.
- `capture_delay` — VARCHAR scalar bucket: `'<3'`, `'3-5'`, `'>5'`, `'immediate'`, `'manual'`. `NULL` = any.
- `monthly_volume` — VARCHAR scalar bucket: `'<100k'`, `'100k-1m'`, `'1m-5m'`, `'>5m'`. `NULL` = any.
- `monthly_fraud_level` — VARCHAR scalar bucket: `'<7.2%'`, `'7.2%-7.7%'`, `'7.7%-8.3%'`, `'>8.3%'`. `NULL` = any.
- `fixed_amount` — float, fixed fee in euros per transaction.
- `rate` — integer, variable rate in basis points (divided by 10000).

**Critical gotcha:** `account_type`, `aci`, and `merchant_category_code` are
**LIST columns**, not scalars. Match them with `list_contains(...)` and treat
empty/NULL as wildcard — do NOT write `f.aci = p.aci`. See `fees-matching-9dim`.
Run `list_columns('fees')` and a `SELECT * FROM fees LIMIT 5` to confirm types.
