-- v3 curated views for DABstep
-- Copied from v2_analytics.sql — contains only views that meet the view criteria:
-- (1) highly complex multi-table joins with business logic, AND
-- (2) queried extremely frequently across benchmark questions.
--
-- v3 branches from v1 (not v2). These views are the only pre-computed SQL in v3.
-- NULL values in fee rules act as wildcards (match any value).

-- Drop historical/renamed names for clean slate
DROP VIEW IF EXISTS analytics.fee_rules_expanded;
DROP VIEW IF EXISTS analytics.payment_fees;
DROP VIEW IF EXISTS main.merchant_applicable_fees;
DROP VIEW IF EXISTS analytics.fees_merchants_expanded;
DROP VIEW IF EXISTS analytics.payments_fees_estimated;
DROP VIEW IF EXISTS expert.example_merchant_monthly;
DROP SCHEMA IF EXISTS expert;
DROP VIEW IF EXISTS main.merchants_fees_matched;
DROP VIEW IF EXISTS main.fees_expanded;
DROP VIEW IF EXISTS main.fraud_aci_steering;

-- merchant_transaction_fees: Each row = one payment transaction matched to one applicable fee rule.
-- A single payment appears multiple times (once per matching fee rule).
-- Pre-computes derived_fee_amount per row.
CREATE OR REPLACE VIEW main.merchant_transaction_fees AS
WITH merchant_profile AS (
    SELECT DISTINCT
        m.merchant,
        m.account_type,
        m.merchant_category_code,
        CASE
            WHEN TRY_CAST(m.capture_delay AS INTEGER) < 3 THEN '<3'
            WHEN TRY_CAST(m.capture_delay AS INTEGER) BETWEEN 3 AND 5 THEN '3-5'
            WHEN TRY_CAST(m.capture_delay AS INTEGER) > 5 THEN '>5'
            ELSE m.capture_delay
        END AS capture_delay_range
    FROM merchants m
),
monthly_stats AS (
    SELECT
        merchant,
        year,
        MONTH(MAKE_DATE(year, 1, 1) + INTERVAL (day_of_year - 1) DAY) AS month,
        SUM(eur_amount) AS total_volume,
        SUM(CASE WHEN has_fraudulent_dispute THEN eur_amount ELSE 0 END)
            / NULLIF(SUM(eur_amount), 0) * 100 AS fraud_pct,
        CASE
            WHEN SUM(eur_amount) < 100000 THEN '<100k'
            WHEN SUM(eur_amount) < 1000000 THEN '100k-1m'
            WHEN SUM(eur_amount) < 5000000 THEN '1m-5m'
            ELSE '>5m'
        END AS volume_range,
        CASE
            WHEN SUM(CASE WHEN has_fraudulent_dispute THEN eur_amount ELSE 0 END)
                / NULLIF(SUM(eur_amount), 0) * 100 < 7.2 THEN '<7.2%'
            WHEN SUM(CASE WHEN has_fraudulent_dispute THEN eur_amount ELSE 0 END)
                / NULLIF(SUM(eur_amount), 0) * 100 < 7.7 THEN '7.2%-7.7%'
            WHEN SUM(CASE WHEN has_fraudulent_dispute THEN eur_amount ELSE 0 END)
                / NULLIF(SUM(eur_amount), 0) * 100 < 8.3 THEN '7.7%-8.3%'
            ELSE '>8.3%'
        END AS fraud_level_range
    FROM payments
    GROUP BY merchant, year, month
)
SELECT
    p.merchant AS payments_merchant,
    p.year AS payments_year,
    p.day_of_year AS payments_day_of_year,
    p.eur_amount AS payments_eur_amount,
    p.card_scheme AS payments_card_scheme,
    p.aci AS payments_aci,
    p.is_credit AS payments_is_credit,
    p.issuing_country AS payments_issuing_country,
    p.acquirer_country AS payments_acquirer_country,
    p.has_fraudulent_dispute AS payments_has_fraudulent_dispute,
    CASE WHEN p.issuing_country = p.acquirer_country THEN 1.0 ELSE 0.0 END AS derived_intracountry,
    MONTH(MAKE_DATE(p.year, 1, 1) + INTERVAL (p.day_of_year - 1) DAY) AS derived_month,
    f.fixed_amount + (f.rate / 10000.0) * p.eur_amount AS derived_fee_amount,
    f.ID AS fees_id,
    f.fixed_amount AS fees_fixed_amount,
    f.rate AS fees_rate,
    mp.account_type AS merchants_account_type,
    mp.merchant_category_code AS merchants_mcc,
    mp.capture_delay_range AS derived_capture_delay_range,
    ms.total_volume AS derived_monthly_volume,
    ms.fraud_pct AS derived_monthly_fraud_pct,
    ms.volume_range AS derived_volume_range,
    ms.fraud_level_range AS derived_fraud_level_range
FROM payments p
JOIN merchant_profile mp ON p.merchant = mp.merchant
JOIN monthly_stats ms ON p.merchant = ms.merchant AND p.year = ms.year
    AND MONTH(MAKE_DATE(p.year, 1, 1) + INTERVAL (p.day_of_year - 1) DAY) = ms.month
JOIN fees f
    ON (f.card_scheme = p.card_scheme OR f.card_scheme IS NULL)
    AND (f.aci = p.aci OR f.aci IS NULL)
    AND (f.is_credit = p.is_credit OR f.is_credit IS NULL)
    AND (f.intracountry = CASE WHEN p.issuing_country = p.acquirer_country THEN 1.0 ELSE 0.0 END OR f.intracountry IS NULL)
    AND (f.account_type = mp.account_type OR f.account_type IS NULL)
    AND (f.merchant_category_code = mp.merchant_category_code OR f.merchant_category_code IS NULL)
    AND (f.capture_delay = mp.capture_delay_range OR f.capture_delay IS NULL)
    AND (f.monthly_volume = ms.volume_range OR f.monthly_volume IS NULL)
    AND (f.monthly_fraud_level = ms.fraud_level_range OR f.monthly_fraud_level IS NULL);

-- merchant_transaction_fees comments
COMMENT ON VIEW main.merchant_transaction_fees IS 'Each row = one payment transaction matched to one applicable fee rule. A single payment appears multiple times (once per matching fee rule). derived_fee_amount is pre-computed per row. WARNING: do NOT SUM or COUNT payments_eur_amount directly — rows are duplicated per fee rule. For payment-level queries without fees, use the payments table. Use ask_docs for query patterns.';
COMMENT ON COLUMN main.merchant_transaction_fees.fees_rate IS 'Basis points. Fee per transaction = fees_fixed_amount + (fees_rate / 10000.0) * payments_eur_amount. Pre-computed as derived_fee_amount.';
COMMENT ON COLUMN main.merchant_transaction_fees.derived_capture_delay_range IS 'Bucketed: <3, 3-5, >5, immediate, manual.';
COMMENT ON COLUMN main.merchant_transaction_fees.derived_volume_range IS 'Bucketed: <100k, 100k-1m, 1m-5m, >5m.';
COMMENT ON COLUMN main.merchant_transaction_fees.derived_fraud_level_range IS 'Bucketed: <7.2%, 7.2%-7.7%, 7.7%-8.3%, >8.3%.';
COMMENT ON COLUMN main.merchant_transaction_fees.derived_intracountry IS '1.0=domestic, 0.0=international.';
COMMENT ON COLUMN main.merchant_transaction_fees.derived_monthly_volume IS 'Monthly aggregate for fee rule matching only. Do NOT use for per-transaction fee calculation — use payments_eur_amount instead.';
COMMENT ON COLUMN main.merchant_transaction_fees.derived_fee_amount IS 'Pre-computed: fees_fixed_amount + (fees_rate / 10000.0) * payments_eur_amount. SUM this for total fees.';

-- fee_rules_expanded: Pre-expands NULL wildcards in general dimensions (account_type, aci,
-- is_credit, intracountry) so the model can use simple WHERE equality instead of OR IS NULL.
-- Use for average-fee questions (Pattern 1). For merchant-specific queries, use merchant_transaction_fees.
CREATE OR REPLACE VIEW main.fee_rules_expanded AS
SELECT
    f.ID AS fees_id,
    f.card_scheme AS fees_card_scheme,
    at_dim.val AS expanded_account_type,
    aci_dim.val AS expanded_aci,
    ic_dim.val AS expanded_is_credit,
    intra_dim.val AS expanded_intracountry,
    f.fixed_amount AS fees_fixed_amount,
    f.rate AS fees_rate,
    f.merchant_category_code AS fees_mcc,
    f.capture_delay AS fees_capture_delay,
    f.monthly_volume AS fees_monthly_volume,
    f.monthly_fraud_level AS fees_monthly_fraud_level
FROM fees f,
    (SELECT DISTINCT account_type AS val FROM fees WHERE account_type IS NOT NULL) at_dim,
    (SELECT DISTINCT aci AS val FROM fees WHERE aci IS NOT NULL) aci_dim,
    (SELECT unnest([TRUE, FALSE]) AS val) ic_dim,
    (SELECT unnest([0.0, 1.0]) AS val) intra_dim
WHERE
    (f.account_type = at_dim.val OR f.account_type IS NULL)
    AND (f.aci = aci_dim.val OR f.aci IS NULL)
    AND (f.is_credit = ic_dim.val OR f.is_credit IS NULL)
    AND (f.intracountry = intra_dim.val OR f.intracountry IS NULL);

-- fee_rules_expanded comments
COMMENT ON VIEW main.fee_rules_expanded IS 'General fee rules with NULL wildcards pre-expanded for account_type, aci, is_credit, intracountry — use simple WHERE equality. Each fees_id has multiple rows (one per expanded combo); deduplicate by fees_id when averaging. ACI covers A-F only — for ACI G, query raw fees table with (f.aci = ''G'' OR f.aci IS NULL). For merchant-specific questions, use merchant_transaction_fees instead. Use ask_docs for query patterns (SUM vs AVG depends on question type).';
COMMENT ON COLUMN main.fee_rules_expanded.fees_rate IS 'Basis points. Fee = fees_fixed_amount + (fees_rate * eur_amount / 10000).';
COMMENT ON COLUMN main.fee_rules_expanded.expanded_intracountry IS '1.0=domestic, 0.0=international.';

-- fraud_aci_costs: Pre-computes the total fee if all fraudulent transactions for a
-- merchant/month were redirected to each candidate ACI (A-F). For "which ACI minimizes
-- fraud fees?" questions, just SELECT derived_target_aci ORDER BY derived_total_fee LIMIT 1.
CREATE OR REPLACE VIEW main.fraud_aci_costs AS
WITH merchant_profile AS (
    SELECT DISTINCT
        m.merchant,
        m.account_type,
        m.merchant_category_code,
        CASE
            WHEN TRY_CAST(m.capture_delay AS INTEGER) < 3 THEN '<3'
            WHEN TRY_CAST(m.capture_delay AS INTEGER) BETWEEN 3 AND 5 THEN '3-5'
            WHEN TRY_CAST(m.capture_delay AS INTEGER) > 5 THEN '>5'
            ELSE m.capture_delay
        END AS capture_delay_range
    FROM merchants m
),
monthly_stats AS (
    SELECT
        merchant,
        year,
        MONTH(MAKE_DATE(year, 1, 1) + INTERVAL (day_of_year - 1) DAY) AS month,
        CASE
            WHEN SUM(eur_amount) < 100000 THEN '<100k'
            WHEN SUM(eur_amount) < 1000000 THEN '100k-1m'
            WHEN SUM(eur_amount) < 5000000 THEN '1m-5m'
            ELSE '>5m'
        END AS volume_range,
        CASE
            WHEN SUM(CASE WHEN has_fraudulent_dispute THEN eur_amount ELSE 0 END)
                / NULLIF(SUM(eur_amount), 0) * 100 < 7.2 THEN '<7.2%'
            WHEN SUM(CASE WHEN has_fraudulent_dispute THEN eur_amount ELSE 0 END)
                / NULLIF(SUM(eur_amount), 0) * 100 < 7.7 THEN '7.2%-7.7%'
            WHEN SUM(CASE WHEN has_fraudulent_dispute THEN eur_amount ELSE 0 END)
                / NULLIF(SUM(eur_amount), 0) * 100 < 8.3 THEN '7.7%-8.3%'
            ELSE '>8.3%'
        END AS fraud_level_range
    FROM payments
    GROUP BY merchant, year, month
),
fraud_txns AS (
    SELECT
        p.merchant,
        p.year,
        MONTH(MAKE_DATE(p.year, 1, 1) + INTERVAL (p.day_of_year - 1) DAY) AS month,
        p.card_scheme,
        p.is_credit,
        p.eur_amount,
        CASE WHEN p.issuing_country = p.acquirer_country THEN 1.0 ELSE 0.0 END AS intracountry
    FROM payments p
    WHERE p.has_fraudulent_dispute = true
),
target_acis AS (
    SELECT unnest(['A','B','C','D','E','F']) AS target_aci
),
-- For each fraud txn x target ACI, sum ALL matching fee rules (fees are cumulative)
txn_total_fees AS (
    SELECT
        ft.merchant,
        ft.year,
        ft.month,
        ta.target_aci,
        ft.eur_amount,
        ft.card_scheme,
        ft.is_credit,
        ft.intracountry,
        SUM(f.fixed_amount + f.rate * ft.eur_amount / 10000) AS txn_fee
    FROM fraud_txns ft
    CROSS JOIN target_acis ta
    JOIN merchant_profile mp ON ft.merchant = mp.merchant
    JOIN monthly_stats ms ON ft.merchant = ms.merchant AND ft.year = ms.year AND ft.month = ms.month
    JOIN fees f
        ON f.card_scheme = ft.card_scheme
        AND (f.aci = ta.target_aci OR f.aci IS NULL)
        AND (f.is_credit = ft.is_credit OR f.is_credit IS NULL)
        AND (f.intracountry = ft.intracountry OR f.intracountry IS NULL)
        AND (f.account_type = mp.account_type OR f.account_type IS NULL)
        AND (f.merchant_category_code = mp.merchant_category_code OR f.merchant_category_code IS NULL)
        AND (f.capture_delay = mp.capture_delay_range OR f.capture_delay IS NULL)
        AND (f.monthly_volume = ms.volume_range OR f.monthly_volume IS NULL)
        AND (f.monthly_fraud_level = ms.fraud_level_range OR f.monthly_fraud_level IS NULL)
    GROUP BY ft.merchant, ft.year, ft.month, ta.target_aci,
             ft.eur_amount, ft.card_scheme, ft.is_credit, ft.intracountry
)
-- Aggregate: total fee per merchant x month x target ACI
SELECT
    merchant AS payments_merchant,
    year AS payments_year,
    month AS derived_month,
    target_aci AS derived_target_aci,
    SUM(txn_fee) AS derived_total_fee,
    COUNT(*) AS derived_fraud_txn_count
FROM txn_total_fees
GROUP BY merchant, year, month, target_aci;

COMMENT ON VIEW main.fraud_aci_costs IS 'Pre-computed ACI steering for fraud: total fee if ALL fraudulent transactions for a merchant/month were redirected to each candidate ACI (A-F). One row per merchant/year/month/target_aci. Use ask_docs for query patterns.';
COMMENT ON COLUMN main.fraud_aci_costs.derived_target_aci IS 'Candidate ACI (A-F) that fraud transactions would be redirected to.';
COMMENT ON COLUMN main.fraud_aci_costs.derived_total_fee IS 'Total fee in EUR if all fraud transactions for this merchant/month used this ACI.';
COMMENT ON COLUMN main.fraud_aci_costs.derived_fraud_txn_count IS 'Number of fraudulent transactions for this merchant/month.';
