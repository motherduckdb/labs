---
id: schema-scope
domain: schema
summary: What "the dataset" means, the merchants vs payments distinction, type mismatches, and "possible values".
---
**"The dataset" = the `payments` table.** It is the authoritative source for any
count of merchants, customers, transactions, volume, or fraud.

- "How many merchants are in the dataset", "unique merchants", "the set of
  merchants" → `SELECT COUNT(DISTINCT merchant) FROM payments` (NOT the merchants
  table). The `merchants` dimension table has ~30 rows, most with zero
  transactions; it is only for looking up a merchant's account_type / MCC /
  capture_delay.

**Type mismatches to watch:**
- `merchant_category_codes.mcc` is VARCHAR; `merchants.merchant_category_code` is
  BIGINT — cast on join.
- `fees.capture_delay` matches VARCHAR buckets, not raw day integers.

**"Possible values" of a field** come from the **manual definitions**, not
`SELECT DISTINCT`. The manual defines the full domain (e.g. all ACI letters A–G,
all account types), which may include values with zero rows in the data. Fetch
`terminology-*` for the authoritative value lists.

**An empty SQL result is the empty string `""`, NOT "Not Applicable".** See
`format-na-empty` for when "Not Applicable" is correct.
