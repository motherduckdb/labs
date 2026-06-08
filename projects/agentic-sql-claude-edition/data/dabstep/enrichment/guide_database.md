# DABstep Domain Guide

## [section:core]

Adyen-like payments dataset with transactions, fee rules, and merchant profiles.

### Core Tables

- **payments** — Fact table. One row per transaction. Use for counts, volumes, fraud rates.
- **fees** — Fee rule definitions. NULL in any dimension = wildcard (matches all values). ALL matching rules are summed per transaction (no "most specific wins" logic).
- **merchants** — Dimension table (~30 rows, 5 active in payments). Properties: account_type, merchant_category_code, capture_delay.
- **acquirer_countries** — Maps acquirer IDs to country codes. Join via `merchants.acquirer` array.
- **merchant_category_codes** — MCC lookup table. Note: `mcc` is VARCHAR, `merchants.merchant_category_code` is BIGINT.

### Key Relationships

- **Customer** = `email_address`, not `card_number`. One customer can have multiple cards.
- **Intracountry** is derived: `issuing_country = acquirer_country` means domestic (1.0), otherwise international (0.0).
- **"The Nth of the year"** means `day_of_year = N`, not month N.

Use `search_fragments` for fee calculation formulas, NULL-wildcard matching patterns, and bucketing ranges.

### Dataset Scope

- "The dataset" refers to the **payments** table. The payments table is the fact table and the authoritative source for "how many merchants are in the dataset".
- When a question asks about "merchants in the dataset," "unique merchants," or "set of merchants," query the payments table.
- The merchants table is a dimension table with 30 rows, most of which have no transactions.

## [section:fee_rules]

### Fee Rule Dimensions (9 total)

card_scheme, account_type, aci, is_credit, intracountry, merchant_category_code, capture_delay, monthly_volume, monthly_fraud_level.

### Fee Matching Logic

- NULL in any fee rule dimension = wildcard (matches all values for that dimension).
- ALL matching fee rules apply per transaction — there is no "most specific rule wins" logic. A single transaction can match multiple fee rules and all fees are summed.
- Fee formula: `fee = fixed_amount + (rate * transaction_value / 10000)`.
- A single fees ID always has the same fixed_amount and rate. When averaging fees, deduplicate by fees ID first.

### Bucketing Rules

- **Monthly volume** (SUM eur_amount per merchant per month): <100k, 100k-1m, 1m-5m, >5m.
- **Monthly fraud level** (fraud_amount/total_amount*100): <7.2%, 7.2%-7.7%, 7.7%-8.3%, >8.3%.
- **Capture delay**: VARCHAR. Numeric values bucketed for fee matching: TRY_CAST <3 → '<3', 3-5 → '3-5', >5 → '>5'. Non-numeric values ('immediate', 'manual') match directly.

### Fee Factor Direction Rules (from manual)

The manual explicitly defines how each fee dimension affects cost. These rules are authoritative — do NOT override them with computed averages from raw fee tables, which are confounded by correlations between dimensions.

| Factor | Direction | Manual quote |
|---|---|---|
| is_credit | True = costlier | "Typically credit transactions are more expensive (higher fee)" |
| intracountry | 1.0 (domestic) = cheaper | "Local acquiring ... lower fees" |
| capture_delay | faster = costlier | "The faster the capture to settlement happens, the more expensive it is" |
| monthly_volume | higher = cheaper | "Merchants with higher volume are able to get cheaper fees" |
| monthly_fraud_level | higher = costlier | "Payment processors will become more expensive as fraud rate increases" |

When questions ask about which factors make fees cheaper or more expensive, use the manual's stated rules above rather than computing averages from the fees table. Raw averages are misleading because fee dimensions are correlated with each other.

### ACI Special Cases

- ACI G exists in payments but has no explicit fee rules in the fees table — it only matches where `aci IS NULL`.
- When comparing fees across candidate ACIs, use A-F (exclude G since it has no explicit rules).

## [section:data_quality]

### Fraud Rate vs Fraud Percentage

- **Fraud rate** is amount-weighted: `SUM(fraud_amount) / SUM(total_amount)` — a ratio between 0 and 1.
- **Percentage of fraudulent transactions** is count-based: `COUNT(fraud) / COUNT(*) * 100`.
- These are fundamentally different measures. Read the question carefully to determine which one is asked for.

### Not Applicable Rules

Return `Not Applicable` when the question asks about a concept that is NOT explicitly defined in the domain manual or data schema. The domain covers payments processing, fee rules, and merchant profiles — concepts outside this scope (e.g., regulatory penalties, policy thresholds) are not defined.

**Decision process:**
1. Identify the key concept in the question.
2. Check whether the manual explicitly **defines** that exact concept.
3. If the manual never defines that exact concept — even if it mentions adjacent concepts — the answer is `Not Applicable`.

Note: Fee bucketing boundaries (monthly_fraud_level, monthly_volume) are pricing tiers, not regulatory thresholds.

An empty SQL result is NOT "Not Applicable" — the answer is the empty string `""`.

### Possible Values: Manual vs Database

When a question asks about "possible values" for a field, the answer comes from the **manual definition**, not from `SELECT DISTINCT`. The manual defines the complete domain of valid values, which may include values with zero rows in the current data. Always check the domain manual for field definitions before relying on DISTINCT queries.

### Type Mismatches

- `merchant_category_codes.mcc` is VARCHAR, `merchants.merchant_category_code` is BIGINT — cast needed for joins.
- `fees.capture_delay` matching uses VARCHAR buckets, not raw integers.

## [section:aggregation_patterns]

### Date Filtering

- **"In [Month] [Year]"** — Filter by calendar month derived from day_of_year:
  `MONTH(MAKE_DATE(year, 1, 1) + INTERVAL (day_of_year - 1) DAY) = M`

### Percentage and Ratio Patterns

- **"Percentage" values** are on a 0–100 scale. If you compute a 0–1 ratio, multiply by 100.
- **"Average X per unique Y"** = average of per-group averages:
  `SELECT AVG(group_avg) FROM (SELECT Y, AVG(X) AS group_avg FROM t GROUP BY Y)`

### Fee Delta / Rate Change

When a question asks "what delta would Merchant pay if the fee with ID=X changed to rate Y?":
- delta = `SUM((new_rate - old_rate) / 10000.0 * transaction_amount)`
- Positive delta means merchant pays MORE, negative means LESS.

### Merchant-Level Acquirer Join

For merchant-level acquirer information, use LATERAL UNNEST:
```sql
LATERAL (SELECT UNNEST(m.acquirer) AS acq_id) acq
JOIN acquirer_countries ac ON ac.acquirer = acq.acq_id
```

### Fee Steering Comparisons

To compare fees across candidate values (e.g., ACIs, card schemes), CROSS JOIN filtered transactions with candidate values, then JOIN fees using the candidate as the match dimension:
```sql
CROSS JOIN (SELECT unnest(['A','B','C','D','E','F']) AS target_aci) ta
JOIN fees f ON f.card_scheme = p.card_scheme
  AND (f.aci = ta.target_aci OR f.aci IS NULL)
  -- + remaining NULL-wildcard dimensions
GROUP BY ta.target_aci
ORDER BY SUM(f.fixed_amount + f.rate * p.eur_amount / 10000)
```

When asked "which ACI minimizes fees" or "most expensive ACI/MCC":
- Aggregate fees per candidate value across ALL card schemes combined — return a single answer, not per-scheme breakdowns.
- For "most expensive": highest total fees. For "cheapest": lowest total fees.

### Answer Format Patterns

- "Which ACI" → single letter (e.g., D).
- "Which card scheme" with a fee → card_scheme:fee with COLON delimiter, fee rounded to 2 decimals (e.g., GlobalCard:1234.56).
