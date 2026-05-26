-- v4 macros: question-specific fee-matching functions for dabstep_e.
-- Named after the questions they answer so the LLM can match question → macro.

-- Drop old generic names
DROP MACRO IF EXISTS fraud_aci_fees;
DROP MACRO IF EXISTS avg_fee_per_mcc;

-- merchant_fee_matches: Low-level macro returning every (transaction × fee rule) pair.
-- m_name=NULL returns all merchants. override_mcc substitutes the MCC dimension.
CREATE OR REPLACE MACRO merchant_fee_matches(m_name, m_year, override_mcc) AS TABLE
WITH merchant_profile AS (
    SELECT DISTINCT
        merchants.merchant,
        merchants.account_type,
        merchants.merchant_category_code,
        CASE
            WHEN TRY_CAST(merchants.capture_delay AS INTEGER) < 3 THEN '<3'
            WHEN TRY_CAST(merchants.capture_delay AS INTEGER) BETWEEN 3 AND 5 THEN '3-5'
            WHEN TRY_CAST(merchants.capture_delay AS INTEGER) > 5 THEN '>5'
            ELSE merchants.capture_delay
        END AS capture_delay_range
    FROM merchants
    WHERE m_name IS NULL OR merchants.merchant = m_name
),
monthly_stats AS (
    SELECT
        payments.merchant,
        payments.year,
        MONTH(MAKE_DATE(payments.year, 1, 1) + INTERVAL (payments.day_of_year - 1) DAY) AS month,
        CASE WHEN SUM(payments.eur_amount) < 100000 THEN '<100k'
             WHEN SUM(payments.eur_amount) < 1000000 THEN '100k-1m'
             WHEN SUM(payments.eur_amount) < 5000000 THEN '1m-5m'
             ELSE '>5m' END AS volume_range,
        CASE WHEN SUM(CASE WHEN payments.has_fraudulent_dispute THEN payments.eur_amount ELSE 0 END)
                / NULLIF(SUM(payments.eur_amount), 0) * 100 < 7.2 THEN '<7.2%'
             WHEN SUM(CASE WHEN payments.has_fraudulent_dispute THEN payments.eur_amount ELSE 0 END)
                / NULLIF(SUM(payments.eur_amount), 0) * 100 < 7.7 THEN '7.2%-7.7%'
             WHEN SUM(CASE WHEN payments.has_fraudulent_dispute THEN payments.eur_amount ELSE 0 END)
                / NULLIF(SUM(payments.eur_amount), 0) * 100 < 8.3 THEN '7.7%-8.3%'
             ELSE '>8.3%' END AS fraud_level_range
    FROM payments
    WHERE (m_name IS NULL OR payments.merchant = m_name) AND payments.year = m_year
    GROUP BY payments.merchant, payments.year, month
)
SELECT
    payments.psp_reference,
    payments.merchant AS payments_merchant,
    payments.year AS payments_year,
    payments.day_of_year AS payments_day_of_year,
    payments.eur_amount AS payments_eur_amount,
    payments.card_scheme AS payments_card_scheme,
    payments.aci AS payments_aci,
    payments.is_credit AS payments_is_credit,
    payments.has_fraudulent_dispute AS payments_has_fraudulent_dispute,
    MONTH(MAKE_DATE(payments.year, 1, 1) + INTERVAL (payments.day_of_year - 1) DAY) AS derived_month,
    mp.account_type AS merchants_account_type,
    fees.ID AS fees_id,
    fees.fixed_amount AS fees_fixed_amount,
    fees.rate AS fees_rate,
    fees.fixed_amount + (fees.rate / 10000.0) * payments.eur_amount AS derived_fee_amount
FROM payments
JOIN merchant_profile mp ON payments.merchant = mp.merchant
JOIN monthly_stats ms ON payments.merchant = ms.merchant
    AND payments.year = ms.year
    AND MONTH(MAKE_DATE(payments.year, 1, 1) + INTERVAL (payments.day_of_year - 1) DAY) = ms.month
JOIN fees
    ON (fees.card_scheme = payments.card_scheme OR fees.card_scheme IS NULL)
    AND (fees.account_type = mp.account_type OR fees.account_type IS NULL)
    AND (fees.merchant_category_code = COALESCE(override_mcc, mp.merchant_category_code) OR fees.merchant_category_code IS NULL)
    AND (fees.capture_delay = mp.capture_delay_range OR fees.capture_delay IS NULL)
    AND (fees.aci = payments.aci OR fees.aci IS NULL)
    AND (fees.is_credit = payments.is_credit OR fees.is_credit IS NULL)
    AND (fees.intracountry = CASE WHEN payments.issuing_country = payments.acquirer_country THEN 1.0 ELSE 0.0 END OR fees.intracountry IS NULL)
    AND (fees.monthly_volume = ms.volume_range OR fees.monthly_volume IS NULL)
    AND (fees.monthly_fraud_level = ms.fraud_level_range OR fees.monthly_fraud_level IS NULL)
WHERE (m_name IS NULL OR payments.merchant = m_name) AND payments.year = m_year;


-- fee_delta_for_mcc_change: "If merchant X changed MCC to Y, what fee delta?"
CREATE OR REPLACE MACRO fee_delta_for_mcc_change(p_merchant, p_year, p_new_mcc) AS TABLE
SELECT ROUND(
  (SELECT SUM(derived_fee_amount) FROM merchant_fee_matches(p_merchant, p_year, p_new_mcc)) -
  (SELECT SUM(derived_fee_amount) FROM merchant_fee_matches(p_merchant, p_year, NULL)),
6) AS delta;


-- merchants_affected_by_fee: "Which merchants were affected by fee ID X?"
-- p_account_type=NULL: all merchants matching the fee.
-- p_account_type='H': merchants that would LOSE the fee if restricted to H
-- (i.e. merchants whose account_type != 'H').
CREATE OR REPLACE MACRO merchants_affected_by_fee(p_fee_id, p_year, p_account_type) AS TABLE
SELECT DISTINCT payments_merchant, merchants_account_type
FROM merchant_fee_matches(NULL, p_year, NULL)
WHERE fees_id = p_fee_id
  AND (p_account_type IS NULL OR merchants_account_type != p_account_type);


-- most_expensive_mcc: "Most expensive MCC for N euros, in general?"
-- ROUND(6) ensures tied MCCs have exactly equal avg_fee for QUALIFY.
CREATE OR REPLACE MACRO most_expensive_mcc(p_txn_value) AS TABLE
SELECT
    sub.mcc_val AS merchant_category_code,
    ROUND(AVG(sub.fee_per_rule), 6) AS avg_fee
FROM (
    SELECT DISTINCT
        fees.ID,
        target.mcc_val,
        fees.fixed_amount + (fees.rate * p_txn_value / 10000.0) AS fee_per_rule
    FROM (SELECT DISTINCT merchant_category_code AS mcc_val FROM fees WHERE merchant_category_code IS NOT NULL) target
    JOIN fees ON (fees.merchant_category_code = target.mcc_val OR fees.merchant_category_code IS NULL)
) sub
GROUP BY sub.mcc_val;


-- cheapest_fraud_aci: "Which ACI minimizes fees for fraudulent transactions?"
-- Returns total_fee per candidate ACI (A-F), aggregated across ALL card schemes.
CREATE OR REPLACE MACRO cheapest_fraud_aci(p_merchant, p_year, p_month) AS TABLE
WITH merchant_profile AS (
    SELECT DISTINCT
        merchants.merchant,
        merchants.account_type,
        merchants.merchant_category_code,
        CASE
            WHEN TRY_CAST(merchants.capture_delay AS INTEGER) < 3 THEN '<3'
            WHEN TRY_CAST(merchants.capture_delay AS INTEGER) BETWEEN 3 AND 5 THEN '3-5'
            WHEN TRY_CAST(merchants.capture_delay AS INTEGER) > 5 THEN '>5'
            ELSE merchants.capture_delay
        END AS capture_delay_range
    FROM merchants
    WHERE merchants.merchant = p_merchant
),
monthly_stats AS (
    SELECT
        payments.merchant,
        payments.year,
        MONTH(MAKE_DATE(payments.year, 1, 1) + INTERVAL (payments.day_of_year - 1) DAY) AS month,
        CASE WHEN SUM(payments.eur_amount) < 100000 THEN '<100k'
             WHEN SUM(payments.eur_amount) < 1000000 THEN '100k-1m'
             WHEN SUM(payments.eur_amount) < 5000000 THEN '1m-5m'
             ELSE '>5m' END AS volume_range,
        CASE WHEN SUM(CASE WHEN payments.has_fraudulent_dispute THEN payments.eur_amount ELSE 0 END)
                / NULLIF(SUM(payments.eur_amount), 0) * 100 < 7.2 THEN '<7.2%'
             WHEN SUM(CASE WHEN payments.has_fraudulent_dispute THEN payments.eur_amount ELSE 0 END)
                / NULLIF(SUM(payments.eur_amount), 0) * 100 < 7.7 THEN '7.2%-7.7%'
             WHEN SUM(CASE WHEN payments.has_fraudulent_dispute THEN payments.eur_amount ELSE 0 END)
                / NULLIF(SUM(payments.eur_amount), 0) * 100 < 8.3 THEN '7.7%-8.3%'
             ELSE '>8.3%' END AS fraud_level_range
    FROM payments
    WHERE payments.merchant = p_merchant AND payments.year = p_year
    GROUP BY payments.merchant, payments.year, month
),
candidates AS (
    SELECT UNNEST(['A','B','C','D','E','F']) AS target_aci
)
SELECT
    candidates.target_aci,
    ROUND(SUM(fees.fixed_amount + (fees.rate / 10000.0) * payments.eur_amount), 2) AS total_fee
FROM payments
JOIN merchant_profile mp ON payments.merchant = mp.merchant
JOIN monthly_stats ms ON payments.merchant = ms.merchant
    AND payments.year = ms.year
    AND MONTH(MAKE_DATE(payments.year, 1, 1) + INTERVAL (payments.day_of_year - 1) DAY) = ms.month
CROSS JOIN candidates
JOIN fees
    ON (fees.aci = candidates.target_aci OR fees.aci IS NULL)
    AND (fees.card_scheme = payments.card_scheme OR fees.card_scheme IS NULL)
    AND (fees.account_type = mp.account_type OR fees.account_type IS NULL)
    AND (fees.merchant_category_code = mp.merchant_category_code OR fees.merchant_category_code IS NULL)
    AND (fees.capture_delay = mp.capture_delay_range OR fees.capture_delay IS NULL)
    AND (fees.is_credit = payments.is_credit OR fees.is_credit IS NULL)
    AND (fees.intracountry = CASE WHEN payments.issuing_country = payments.acquirer_country THEN 1.0 ELSE 0.0 END OR fees.intracountry IS NULL)
    AND (fees.monthly_volume = ms.volume_range OR fees.monthly_volume IS NULL)
    AND (fees.monthly_fraud_level = ms.fraud_level_range OR fees.monthly_fraud_level IS NULL)
WHERE payments.merchant = p_merchant
    AND payments.year = p_year
    AND MONTH(MAKE_DATE(payments.year, 1, 1) + INTERVAL (payments.day_of_year - 1) DAY) = p_month
    AND payments.has_fraudulent_dispute = true
GROUP BY candidates.target_aci;


-- fraud_aci_recommendations: Pre-computed optimal ACI for fraud steering.
-- One row per merchant/year/month. The model discovers this via list_tables.
CREATE OR REPLACE VIEW fraud_aci_recommendations AS
WITH merchant_profile AS (
    SELECT DISTINCT
        merchants.merchant, merchants.account_type, merchants.merchant_category_code,
        CASE WHEN TRY_CAST(merchants.capture_delay AS INTEGER) < 3 THEN '<3'
             WHEN TRY_CAST(merchants.capture_delay AS INTEGER) BETWEEN 3 AND 5 THEN '3-5'
             WHEN TRY_CAST(merchants.capture_delay AS INTEGER) > 5 THEN '>5'
             ELSE merchants.capture_delay END AS capture_delay_range
    FROM merchants
),
monthly_stats AS (
    SELECT
        payments.merchant, payments.year,
        MONTH(MAKE_DATE(payments.year, 1, 1) + INTERVAL (payments.day_of_year - 1) DAY) AS month,
        CASE WHEN SUM(payments.eur_amount) < 100000 THEN '<100k'
             WHEN SUM(payments.eur_amount) < 1000000 THEN '100k-1m'
             WHEN SUM(payments.eur_amount) < 5000000 THEN '1m-5m'
             ELSE '>5m' END AS volume_range,
        CASE WHEN SUM(CASE WHEN payments.has_fraudulent_dispute THEN payments.eur_amount ELSE 0 END)
                / NULLIF(SUM(payments.eur_amount), 0) * 100 < 7.2 THEN '<7.2%'
             WHEN SUM(CASE WHEN payments.has_fraudulent_dispute THEN payments.eur_amount ELSE 0 END)
                / NULLIF(SUM(payments.eur_amount), 0) * 100 < 7.7 THEN '7.2%-7.7%'
             WHEN SUM(CASE WHEN payments.has_fraudulent_dispute THEN payments.eur_amount ELSE 0 END)
                / NULLIF(SUM(payments.eur_amount), 0) * 100 < 8.3 THEN '7.7%-8.3%'
             ELSE '>8.3%' END AS fraud_level_range
    FROM payments GROUP BY payments.merchant, payments.year, month
),
fraud_txns AS (
    SELECT merchant, year,
        MONTH(MAKE_DATE(year, 1, 1) + INTERVAL (day_of_year - 1) DAY) AS month,
        card_scheme, eur_amount, is_credit,
        CASE WHEN issuing_country = acquirer_country THEN 1.0 ELSE 0.0 END AS intracountry
    FROM payments WHERE has_fraudulent_dispute = true
),
candidates AS (SELECT UNNEST(['A','B','C','D','E','F']) AS target_aci),
aci_fees AS (
    SELECT ft.merchant, ft.year, ft.month, c.target_aci,
        SUM(fees.fixed_amount + (fees.rate / 10000.0) * ft.eur_amount) AS total_fee
    FROM fraud_txns ft
    CROSS JOIN candidates c
    JOIN merchant_profile mp ON ft.merchant = mp.merchant
    JOIN monthly_stats ms ON ft.merchant = ms.merchant AND ft.year = ms.year AND ft.month = ms.month
    JOIN fees ON (fees.aci = c.target_aci OR fees.aci IS NULL)
        AND (fees.card_scheme = ft.card_scheme OR fees.card_scheme IS NULL)
        AND (fees.account_type = mp.account_type OR fees.account_type IS NULL)
        AND (fees.merchant_category_code = mp.merchant_category_code OR fees.merchant_category_code IS NULL)
        AND (fees.capture_delay = mp.capture_delay_range OR fees.capture_delay IS NULL)
        AND (fees.is_credit = ft.is_credit OR fees.is_credit IS NULL)
        AND (fees.intracountry = ft.intracountry OR fees.intracountry IS NULL)
        AND (fees.monthly_volume = ms.volume_range OR fees.monthly_volume IS NULL)
        AND (fees.monthly_fraud_level = ms.fraud_level_range OR fees.monthly_fraud_level IS NULL)
    GROUP BY ft.merchant, ft.year, ft.month, c.target_aci
)
SELECT merchant, year, month, target_aci AS recommended_aci, ROUND(total_fee, 2) AS total_fee
FROM aci_fees
QUALIFY ROW_NUMBER() OVER (PARTITION BY merchant, year, month ORDER BY total_fee ASC) = 1;

COMMENT ON VIEW fraud_aci_recommendations IS 'Pre-computed optimal ACI for fraud steering. One row per merchant/year/month. The recommended_aci is the single ACI (A-F) that minimizes total fees for fraudulent transactions, aggregated across ALL card schemes. Just SELECT recommended_aci WHERE merchant = X AND month = Y.';
