---
id: schema-merchants-lookups
domain: schema
summary: merchants dimension table plus the acquirer_countries and merchant_category_codes lookups, and how they join.
---
**`merchants`** — dimension table (~30 rows; only ~5 appear in payments). Read
from merchant_data.json. Columns:
- `merchant` — name; joins to `payments.merchant`.
- `account_type` — single letter (R/D/H/F/S/O). See `terminology-account-type`.
- `merchant_category_code` — single MCC integer (BIGINT).
- `capture_delay` — VARCHAR: a number of days, or `'immediate'` / `'manual'`. Bucket it for fee matching (see `bucketing-capture-delay`).
- `acquirer` — **LIST** of acquirer ids.

**`acquirer_countries`** — maps `acquirer` (id) → `country_code`. Join from
merchants via the acquirer list:
```sql
FROM merchants m, LATERAL UNNEST(m.acquirer) AS acq(acquirer_id)
JOIN acquirer_countries ac ON ac.acquirer = acq.acquirer_id
```

**`merchant_category_codes`** — MCC lookup: `mcc` (description→code). Used when a
question gives an MCC *description* instead of a code. **Type gotcha:**
`merchant_category_codes.mcc` is VARCHAR while `merchants.merchant_category_code`
is BIGINT — cast when joining (`mcc::BIGINT`).

Relationships at a glance:
- `payments.merchant` → `merchants.merchant` (for account_type / mcc / capture_delay).
- merchant profile + monthly stats + the transaction feed the 9-dimension fee
  match (see `fees-matching-9dim`).
