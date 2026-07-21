# SQL Query Patterns for Fee Calculations

These are verified query patterns for common fee-related question types. Use these as templates when constructing queries.

## Pattern 1: Average Fee Across Fee Rules (using fee_rules_expanded view)

Use the `fee_rules_expanded` view which pre-expands NULL wildcards for account_type, aci, is_credit, and intracountry. This lets you use simple WHERE equality (no `OR IS NULL` needed). Each fee ID has the same `fees_fixed_amount` and `fees_rate` — you MUST deduplicate by fee ID first, then average.

```sql
-- Average fee for NexPay credit transactions at 10 EUR
SELECT ROUND(AVG(fee_amount), 6) AS avg_fee
FROM (
  SELECT fees_id, AVG(fees_fixed_amount + (fees_rate * 10.0 / 10000.0)) AS fee_amount
  FROM fee_rules_expanded
  WHERE fees_card_scheme = 'NexPay'
    AND expanded_is_credit = TRUE
  GROUP BY fees_id
);
```

Key rules:
- Use `fee_rules_expanded` instead of `fees` — NULL wildcards are already expanded
- Inner query: `GROUP BY fees_id` ensures each fee rule is counted once
- Simple equality filters: `fees_card_scheme = 'X'`, `expanded_is_credit = Y`, `expanded_account_type = 'Z'`, `expanded_aci = 'A'`, `expanded_intracountry = 1.0`
- For dimensions NOT expanded (fees_mcc, fees_capture_delay, fees_monthly_volume, fees_monthly_fraud_level): still use `OR column IS NULL` if filtering

## Pattern 2: Total Fees for a Merchant (using merchant_transaction_fees view)

For merchant-specific fee calculations, use the `merchant_transaction_fees` view which pre-computes fee rule matching across all 9 dimensions and includes `derived_fee_amount`.

```sql
-- Total fees for Belles_cookbook_store on day 12 of 2023
SELECT ROUND(SUM(derived_fee_amount), 2) AS total_fees
FROM merchant_transaction_fees
WHERE payments_merchant = 'Belles_cookbook_store' AND payments_year = 2023 AND payments_day_of_year = 12;
```

Key rules:
- No JOIN with payments needed — payments are pre-baked into the view
- `derived_fee_amount` is pre-computed: `fees_fixed_amount + (fees_rate / 10000.0) * payments_eur_amount`
- ALL matching fee rules are summed (a transaction can match multiple fees)
- WARNING: do NOT SUM or COUNT `payments_eur_amount` directly — rows are duplicated per fee rule

## Pattern 3: Fee Delta When Rate Changes

When a question asks "what delta would Merchant pay if the fee with ID=X changed to rate Y?", compute the difference in fees using the merchant_transaction_fees view.

```sql
-- Delta if fee ID 276 rate changed to 99 for Rafa_AI in 2023
SELECT ROUND(SUM((99 - fees_rate) / 10000.0 * payments_eur_amount), 2) AS delta
FROM merchant_transaction_fees
WHERE payments_merchant = 'Rafa_AI' AND payments_year = 2023 AND fees_id = 276;
```

Key rules:
- delta = SUM((new_rate - fees_rate) / 10000.0 * payments_eur_amount)
- Positive delta means merchant pays MORE, negative means LESS
- Filter merchant_transaction_fees by the specific fees_id

## Pattern 4: Hypothetical MCC Code Change (total fee delta)

When a question asks "what would change if merchant X had MCC code Y?", compute both actual and hypothetical total fees, then subtract.

```sql
-- Delta if Crossfit_Hanna changed MCC to 5911
WITH monthly_stats AS (
    SELECT merchant, year,
        MONTH(MAKE_DATE(year, 1, 1) + INTERVAL (day_of_year - 1) DAY) AS month,
        CASE WHEN SUM(eur_amount) < 100000 THEN '<100k'
             WHEN SUM(eur_amount) < 1000000 THEN '100k-1m'
             WHEN SUM(eur_amount) < 5000000 THEN '1m-5m'
             ELSE '>5m' END AS volume_range,
        CASE WHEN SUM(CASE WHEN has_fraudulent_dispute THEN eur_amount ELSE 0 END) / NULLIF(SUM(eur_amount), 0) * 100 < 7.2 THEN '<7.2%'
             WHEN SUM(CASE WHEN has_fraudulent_dispute THEN eur_amount ELSE 0 END) / NULLIF(SUM(eur_amount), 0) * 100 < 7.7 THEN '7.2%-7.7%'
             WHEN SUM(CASE WHEN has_fraudulent_dispute THEN eur_amount ELSE 0 END) / NULLIF(SUM(eur_amount), 0) * 100 < 8.3 THEN '7.7%-8.3%'
             ELSE '>8.3%' END AS fraud_level_range
    FROM payments
    WHERE merchant = 'Crossfit_Hanna' AND year = 2023
    GROUP BY merchant, year, month
),
hypo AS (
  SELECT SUM(f.fixed_amount + (f.rate / 10000.0) * p.eur_amount) AS total
  FROM payments p
  JOIN monthly_stats ms ON p.merchant = ms.merchant AND p.year = ms.year
    AND MONTH(MAKE_DATE(p.year, 1, 1) + INTERVAL (p.day_of_year - 1) DAY) = ms.month
  JOIN fees f
    ON (f.card_scheme = p.card_scheme OR f.card_scheme IS NULL)
    AND (f.aci = p.aci OR f.aci IS NULL)
    AND (f.is_credit = p.is_credit OR f.is_credit IS NULL)
    AND (f.intracountry = CASE WHEN p.issuing_country = p.acquirer_country THEN 1.0 ELSE 0.0 END OR f.intracountry IS NULL)
    AND (f.account_type = 'F' OR f.account_type IS NULL)
    AND (f.merchant_category_code = 5911 OR f.merchant_category_code IS NULL)
    AND (f.capture_delay = 'manual' OR f.capture_delay IS NULL)
    AND (f.monthly_volume = ms.volume_range OR f.monthly_volume IS NULL)
    AND (f.monthly_fraud_level = ms.fraud_level_range OR f.monthly_fraud_level IS NULL)
  WHERE p.merchant = 'Crossfit_Hanna' AND p.year = 2023
),
actual AS (
  SELECT SUM(derived_fee_amount) AS total
  FROM merchant_transaction_fees
  WHERE payments_merchant = 'Crossfit_Hanna' AND payments_year = 2023
)
SELECT ROUND(hypo.total - actual.total, 6) AS delta
FROM hypo, actual;
```

Key rules:
- CRITICAL: Do NOT use QUALIFY ROW_NUMBER() to pick "most specific" fee. ALL matching fees are summed.
- For hypothetical: join payments to fees directly, substituting the new MCC code
- For actual: use merchant_transaction_fees (already handles all 9 dimensions)
- Delta = hypothetical_total - actual_total
- Must replicate all 9 dimension matches including monthly_volume and monthly_fraud_level bucketing

## Fee Factor Directionality (from manual Section 5)

When questions ask which factors make fees cheaper or more expensive, the answers come from the domain manual — no SQL needed. These are the directionality rules stated in the manual:

| Factor | Type | Cheaper Fee When | Manual Basis |
|--------|------|-----------------|-------------|
| capture_delay | string | Increased (longer delay, e.g. >5 or manual) | "The faster the capture to settlement happens, the more expensive it is" |
| monthly_fraud_level | string | Decreased (lower fraud) | "payment processors will become more expensive as fraud rate increases" |
| monthly_volume | string | Increased (higher volume) | "merchants with higher volume are able to get cheaper fees" |
| is_credit | boolean | False (debit transaction) | "credit transactions are more expensive (higher fee)" |
| intracountry | boolean | True (domestic transaction) | "international transactions...typically are more expensive" |

- **Boolean factors cheaper when True**: intracountry
- **Boolean factors cheaper when False**: is_credit
- **Factors cheaper when value increased**: monthly_volume, capture_delay
- **Factors cheaper when value decreased**: monthly_fraud_level

## Pattern 5: Which ACI Minimizes Fees for Fraudulent Transactions? (using fraud_aci_costs view)

Use the `fraud_aci_costs` view which pre-computes total fees per candidate ACI (A-F) for each merchant's fraudulent transactions. No complex joins needed.

```sql
-- Best ACI for Golfclub_Baron_Friso in January
SELECT derived_target_aci
FROM fraud_aci_costs
WHERE payments_merchant = 'Golfclub_Baron_Friso' AND derived_month = 1
ORDER BY derived_total_fee ASC
LIMIT 1;
```

Key rules:
- View pre-computes: for each merchant x year x month x target_aci, the total fee if ALL fraudulent transactions used that ACI
- Answer is the `derived_target_aci` with the lowest `derived_total_fee`
- For yearly questions, aggregate across months: `SELECT derived_target_aci, SUM(derived_total_fee) ... GROUP BY derived_target_aci ORDER BY SUM(derived_total_fee) LIMIT 1`
- Return just the ACI letter (e.g. `D`), not a scheme:amount pair
- **CRITICAL: Do NOT break down by card_scheme.** The question asks for ONE overall optimal ACI across all card schemes combined
- **Do NOT reconstruct this logic from raw tables** — the view already handles all the complex fee matching. If the view gives you an answer, trust it

## Pattern 6: Most Expensive ACI for a Merchant (using merchant_transaction_fees)

When asked "which ACI is most expensive for Merchant X?", compute total fees per ACI across ALL card schemes combined, then return the most expensive.

```sql
-- Most expensive ACI for Belles_cookbook_store in 2023
SELECT payments_aci, ROUND(SUM(derived_fee_amount), 2) AS total_fees
FROM merchant_transaction_fees
WHERE payments_merchant = 'Belles_cookbook_store' AND payments_year = 2023
GROUP BY payments_aci
ORDER BY total_fees DESC
LIMIT 1;
```

Key rules:
- No JOIN with payments needed — payments are pre-baked into the view
- Group by `payments_aci` — sum across all card schemes, all months
- "Most expensive" = highest total_fees; "cheapest" = lowest total_fees
- Return as list format if guidelines say so: `['F']`

## Pattern 7: Most Expensive ACI for a Card Scheme (using fee_rules_expanded)

When asked "for a transaction of X euros on [card_scheme], which ACI is most expensive?", SUM all matching fee costs per ACI. These are NOT merchant-specific — no merchant dimension is involved.

```sql
-- Most expensive ACI for a 1 EUR credit transaction on NexPay
SELECT expanded_aci
FROM fee_rules_expanded
WHERE fees_card_scheme = 'NexPay' AND expanded_is_credit = TRUE
GROUP BY expanded_aci
ORDER BY SUM(fees_fixed_amount + (fees_rate * 1.0 / 10000.0)) DESC
LIMIT 1;
```

Key rules:
- Use SUM, NOT AVG — a transaction matches all applicable fee rules cumulatively
- Substitute the transaction amount (e.g. `1.0`, `100.0`, `10000.0`) in the fee formula
- Filter by card_scheme and is_credit from the question
- No GROUP BY fees_id dedup — we want ALL matching rules per ACI summed
- Do NOT use merchant_transaction_fees for these questions — no merchant is specified
