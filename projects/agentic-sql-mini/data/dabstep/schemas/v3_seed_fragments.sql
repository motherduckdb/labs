-- v3 seed fragments: SQL patterns and recipes for common query types.
-- Split from v3_metadata.sql. Contains only INSERT INTO fragments statements.
-- Fragments that were purely descriptive (no SQL) have been promoted to annotations.
-- Remaining fragments all have SQL snippets showing how to apply the pattern.
-- IDs start at 1 and are contiguous.

INSERT OR REPLACE INTO fragments (id, db_names, table_names, column_names, trust_level, score, tags, fragment_type, description, sql, examples, is_seed)
VALUES
(1, ['dabstep_d'], ['fees'], ['card_scheme', 'account_type', 'aci', 'is_credit', 'intracountry', 'merchant_category_code', 'capture_delay', 'monthly_volume', 'monthly_fraud_level'], 'proven', 10, ['null_wildcard'], 'join_recipe',
'NULL in any fee rule dimension = wildcard (matches all values). ALL matching fee rules apply — no "most specific rule wins" logic. A single transaction can match multiple fee rules and all are summed.',
'-- join payments to fees with NULL-wildcard matching
JOIN fees f ON (f.card_scheme = p.card_scheme OR f.card_scheme IS NULL)
  AND (f.account_type = m.account_type OR f.account_type IS NULL)
  AND (f.aci = p.aci OR f.aci IS NULL)
  -- repeat for all 9 fee dimensions',
'| fee rule aci | payment aci | matches? |
|---|---|---|
| NULL | A | yes (NULL = wildcard) |
| A | A | yes (exact) |
| A | B | no |
| NULL | G | yes (only way G matches)', TRUE),

(2, ['dabstep_d'], ['fees'], ['fixed_amount', 'rate', 'ID'], 'proven', 10, ['fee_formula'], 'business_rule',
'Fee = fixed_amount + (rate * transaction_value / 10000). A single fees ID always has the same fixed_amount and rate. When averaging fees, deduplicate by fees ID first.',
'-- fee calculation per transaction
SELECT f.fixed_amount + (f.rate * p.eur_amount / 10000.0) AS fee
-- dedup when averaging: AVG(DISTINCT fees_id) won''t work, use subquery
SELECT AVG(fee) FROM (SELECT DISTINCT f.ID, f.fixed_amount + f.rate * p.eur_amount / 10000.0 AS fee ...)',
NULL, TRUE),

(3, ['dabstep_d'], ['merchants'], ['capture_delay'], 'proven', 10, ['capture_delay'], 'sql_pattern',
'capture_delay is VARCHAR. Numeric values bucketed for fee matching: <3, 3-5, >5. Non-numeric values (immediate, manual) match fee rules directly.',
'-- bucket capture_delay for fee matching
CASE
  WHEN TRY_CAST(m.capture_delay AS INTEGER) < 3 THEN ''<3''
  WHEN TRY_CAST(m.capture_delay AS INTEGER) BETWEEN 3 AND 5 THEN ''3-5''
  WHEN TRY_CAST(m.capture_delay AS INTEGER) > 5 THEN ''>5''
  ELSE m.capture_delay  -- ''immediate'', ''manual'' pass through
END',
'| capture_delay (raw) | bucketed | rule |
|---|---|---|
| 1 | <3 | TRY_CAST as int, < 3 |
| 4 | 3-5 | BETWEEN 3 AND 5 |
| 7 | >5 | > 5 |
| immediate | immediate | non-numeric passthrough |
| manual | manual | non-numeric passthrough', TRUE),

(4, ['dabstep_d'], ['payments', 'fees'], ['eur_amount', 'monthly_volume', 'monthly_fraud_level'], 'proven', 10, ['bucketing'], 'sql_pattern',
'Fee rules match on monthly volume and fraud level ranges per merchant per calendar month. Volume: <100k, 100k-1m, 1m-5m, >5m (SUM eur_amount). Fraud: <7.2%, 7.2%-7.7%, 7.7%-8.3%, >8.3% (fraud_amount/total_amount*100).',
'-- compute monthly volume bucket per merchant
WITH monthly AS (
  SELECT merchant, MONTH(txn_date) AS m,
    SUM(eur_amount) AS vol,
    SUM(CASE WHEN has_fraudulent_dispute THEN eur_amount ELSE 0 END) * 100.0 / SUM(eur_amount) AS fraud_pct
  FROM payments GROUP BY 1, 2
)
-- match: WHERE (f.monthly_volume = bucket OR f.monthly_volume IS NULL)',
NULL, TRUE),

(5, ['dabstep_d'], ['payments'], ['issuing_country', 'acquirer_country'], 'proven', 10, ['intracountry'], 'join_recipe',
'Intracountry = issuing_country == acquirer_country. payments.acquirer_country exists directly on the table. For merchant-level acquirer info, LATERAL UNNEST merchants.acquirer then JOIN acquirer_countries.',
'-- intracountry flag (simple — acquirer_country is on payments)
CASE WHEN p.issuing_country = p.acquirer_country THEN 1.0 ELSE 0.0 END AS intracountry
-- merchant-level acquirer country (when needed)
LATERAL (SELECT UNNEST(m.acquirer) AS acq_id) acq
JOIN acquirer_countries ac ON ac.acquirer = acq.acq_id',
NULL, TRUE),

(6, ['dabstep_d'], ['payments'], ['has_fraudulent_dispute', 'eur_amount'], 'proven', 10, ['fraud_rate'], 'sql_pattern',
'Fraud rate is amount-weighted (0-1 ratio). "Percentage of fraudulent transactions" is count-based. These are different measures.',
'-- amount-weighted fraud rate
SUM(CASE WHEN has_fraudulent_dispute THEN eur_amount ELSE 0 END) / SUM(eur_amount)
-- count-based fraud percentage
COUNT(CASE WHEN has_fraudulent_dispute THEN 1 END) * 100.0 / COUNT(*)',
NULL, TRUE),

(7, ['dabstep_d'], ['payments'], ['day_of_year'], 'proven', 10, ['date_arithmetic'], 'sql_pattern',
'Convert day_of_year to date. "The 50th of the year" means day_of_year=50, NOT month 50.',
'-- day_of_year to date
MAKE_DATE(year, 1, 1) + INTERVAL (day_of_year - 1) DAY
-- extract month
MONTH(MAKE_DATE(year, 1, 1) + INTERVAL (day_of_year - 1) DAY)',
NULL, TRUE),

(8, ['dabstep_d'], ['fees'], ['aci'], 'proven', 10, ['aci_g'], 'value_domain',
'ACI G exists in payments but has no explicit fee rules in the fees table — it only matches where aci IS NULL.',
'-- ACI G fee matching
WHERE (f.aci = ''G'' OR f.aci IS NULL)',
NULL, TRUE),

(9, ['dabstep_d'], ['payments', 'fees'], ['aci'], 'proven', 10, ['steering', 'cross_join', 'fee_comparison'], 'sql_pattern',
'To compare fees across candidate values (e.g., ACIs, card schemes), CROSS JOIN filtered transactions with candidate values, then JOIN fees using the candidate as the match dimension. Candidates A-F for ACI (exclude G — no explicit fee rules).',
'-- compare total fees across candidate ACIs
CROSS JOIN (SELECT unnest([''A'',''B'',''C'',''D'',''E'',''F'']) AS target_aci) ta
JOIN fees f ON f.card_scheme = p.card_scheme
  AND (f.aci = ta.target_aci OR f.aci IS NULL)
  -- + remaining NULL-wildcard dimensions
GROUP BY ta.target_aci
ORDER BY SUM(f.fixed_amount + f.rate * p.eur_amount / 10000)',
NULL, TRUE),

(10, ['dabstep_d'], ['fees'], ['aci', 'card_scheme'], 'proven', 10, ['answer_format', 'steering'], 'business_rule',
'"Which ACI" → single letter (e.g., D). "Which card scheme" with a fee → card_scheme:fee with a COLON delimiter, fee rounded to 2 decimals (e.g., GlobalCard:1234.56).',
'-- ACI answer: just the letter
SELECT target_aci FROM ... ORDER BY total_fee LIMIT 1
-- card scheme answer: colon-delimited
SELECT card_scheme || '':'' || ROUND(total_fee, 2) FROM ...',
NULL, TRUE),

(11, ['dabstep_d'], ['payments', 'fees'], ['fees_id', 'fees_rate', 'eur_amount'], 'proven', 10, ['fee_delta', 'rate_change'], 'sql_pattern',
'Fee delta: difference in cost when a fee rule''s rate changes. delta = SUM((new_rate - fees_rate) / 10000.0 * payments_eur_amount). Positive = merchant pays MORE. Use merchant_transaction_fees view filtered by fees_id.',
'-- Delta if fee ID 276 rate changed to 99 for Rafa_AI in 2023
SELECT ROUND(SUM((99 - fees_rate) / 10000.0 * payments_eur_amount), 2) AS delta
FROM merchant_transaction_fees
WHERE payments_merchant = ''Rafa_AI'' AND payments_year = 2023 AND fees_id = 276;',
'| new_rate | fees_rate | delta sign |
|---|---|---|
| 99 | 50 | positive (pays more) |
| 30 | 50 | negative (pays less) |', TRUE),

(12, ['dabstep_d'], ['payments', 'fees', 'merchants'], ['merchant_category_code'], 'proven', 10, ['hypothetical_mcc', 'what_if'], 'sql_pattern',
'Hypothetical MCC: compute actual fees (from merchant_transaction_fees view) vs hypothetical fees (raw join with substituted MCC). Delta = hypothetical - actual. Must replicate all 9 fee dimensions including monthly_volume and monthly_fraud_level bucketing.',
'-- Delta if Crossfit_Hanna changed MCC to 5911
WITH monthly_stats AS (
  SELECT merchant, year,
    MONTH(MAKE_DATE(year, 1, 1) + INTERVAL (day_of_year - 1) DAY) AS month,
    CASE WHEN SUM(eur_amount) < 100000 THEN ''<100k''
         WHEN SUM(eur_amount) < 1000000 THEN ''100k-1m''
         WHEN SUM(eur_amount) < 5000000 THEN ''1m-5m''
         ELSE ''>5m'' END AS volume_range,
    CASE WHEN SUM(CASE WHEN has_fraudulent_dispute THEN eur_amount ELSE 0 END) / NULLIF(SUM(eur_amount), 0) * 100 < 7.2 THEN ''<7.2%''
         WHEN SUM(CASE WHEN has_fraudulent_dispute THEN eur_amount ELSE 0 END) / NULLIF(SUM(eur_amount), 0) * 100 < 7.7 THEN ''7.2%-7.7%''
         WHEN SUM(CASE WHEN has_fraudulent_dispute THEN eur_amount ELSE 0 END) / NULLIF(SUM(eur_amount), 0) * 100 < 8.3 THEN ''7.7%-8.3%''
         ELSE ''>8.3%'' END AS fraud_level_range
  FROM payments WHERE merchant = ''Crossfit_Hanna'' AND year = 2023
  GROUP BY merchant, year, month
),
hypo AS (
  SELECT SUM(f.fixed_amount + (f.rate / 10000.0) * p.eur_amount) AS total
  FROM payments p
  JOIN monthly_stats ms ON p.merchant = ms.merchant AND p.year = ms.year
    AND MONTH(MAKE_DATE(p.year, 1, 1) + INTERVAL (p.day_of_year - 1) DAY) = ms.month
  JOIN fees f ON (f.card_scheme = p.card_scheme OR f.card_scheme IS NULL)
    AND (f.aci = p.aci OR f.aci IS NULL)
    AND (f.is_credit = p.is_credit OR f.is_credit IS NULL)
    AND (f.intracountry = CASE WHEN p.issuing_country = p.acquirer_country THEN 1.0 ELSE 0.0 END OR f.intracountry IS NULL)
    AND (f.account_type = ''F'' OR f.account_type IS NULL)
    AND (f.merchant_category_code = 5911 OR f.merchant_category_code IS NULL)
    AND (f.capture_delay = ''manual'' OR f.capture_delay IS NULL)
    AND (f.monthly_volume = ms.volume_range OR f.monthly_volume IS NULL)
    AND (f.monthly_fraud_level = ms.fraud_level_range OR f.monthly_fraud_level IS NULL)
  WHERE p.merchant = ''Crossfit_Hanna'' AND p.year = 2023
),
actual AS (
  SELECT SUM(derived_fee_amount) AS total
  FROM merchant_transaction_fees
  WHERE payments_merchant = ''Crossfit_Hanna'' AND payments_year = 2023
)
SELECT ROUND(hypo.total - actual.total, 6) AS delta FROM hypo, actual;',
NULL, TRUE),

(13, ['dabstep_d'], ['payments', 'fees'], ['aci'], 'proven', 10, ['most_expensive_aci', 'merchant_fees'], 'sql_pattern',
'Most expensive ACI for a merchant: group by payments_aci in merchant_transaction_fees view, SUM derived_fee_amount across ALL card schemes. Return the ACI with highest (or lowest) total.',
'-- Most expensive ACI for Belles_cookbook_store in 2023
SELECT payments_aci, ROUND(SUM(derived_fee_amount), 2) AS total_fees
FROM merchant_transaction_fees
WHERE payments_merchant = ''Belles_cookbook_store'' AND payments_year = 2023
GROUP BY payments_aci
ORDER BY total_fees DESC
LIMIT 1;',
'| question type | aggregation |
|---|---|
| most expensive | ORDER BY total_fees DESC LIMIT 1 |
| cheapest | ORDER BY total_fees ASC LIMIT 1 |
| list all | no LIMIT, return all ACIs |', TRUE),

(14, ['dabstep_d'], ['fees'], ['aci', 'card_scheme'], 'proven', 10, ['most_expensive_aci', 'card_scheme_fees'], 'sql_pattern',
'Most expensive ACI for a card scheme (not merchant-specific): use fee_rules_expanded view. SUM all matching fee costs per ACI — do NOT use AVG or GROUP BY fees_id dedup. Substitute the transaction amount in the fee formula.',
'-- Most expensive ACI for a 1 EUR credit transaction on NexPay
SELECT expanded_aci
FROM fee_rules_expanded
WHERE fees_card_scheme = ''NexPay'' AND expanded_is_credit = TRUE
GROUP BY expanded_aci
ORDER BY SUM(fees_fixed_amount + (fees_rate * 1.0 / 10000.0)) DESC
LIMIT 1;',
'| question type | view | note |
|---|---|---|
| per-merchant ACI | merchant_transaction_fees | group by payments_aci |
| per-card-scheme ACI | fee_rules_expanded | SUM not AVG, no dedup |', TRUE);
