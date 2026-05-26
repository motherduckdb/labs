CREATE TABLE payments AS
SELECT
    psp_reference          AS transaction_id,
    merchant               AS merchant_id,
    card_scheme,
    year,
    day_of_year,
    hour_of_day,
    minute_of_hour,
    is_credit,
    eur_amount             AS transaction_amount_eur,
    ip_country             AS ip_country_code,
    issuing_country        AS card_issuing_country_code,
    device_type,
    ip_address,
    email_address,
    card_number,
    shopper_interaction,
    card_bin,
    has_fraudulent_dispute AS is_fraudulent_dispute,
    is_refused_by_adyen,
    aci                    AS authorization_characteristics_indicator,
    acquirer_country       AS acquirer_country_code
FROM read_csv_auto('${DATA_DIR}/context/payments.csv', header=True);

CREATE TABLE acquirer_countries AS
SELECT
    acquirer     AS acquirer_name,
    country_code
FROM read_csv_auto('${DATA_DIR}/context/acquirer_countries.csv', header=True);

CREATE TABLE merchant_category_codes AS
SELECT
    mcc,
    description AS mcc_description
FROM read_csv_auto('${DATA_DIR}/context/merchant_category_codes.csv', header=True);

CREATE TABLE merchants AS
SELECT
    merchant               AS merchant_id,
    capture_delay          AS capture_delay_days_or_immediate_or_manual,
    acquirer               AS acquirers,
    merchant_category_code,
    account_type
FROM read_json_auto('${DATA_DIR}/context/merchant_data.json');

CREATE TABLE fee_rules AS
SELECT
    ID                       AS fee_rule_id,
    card_scheme              AS card_scheme_filter,
    account_type             AS account_types_filter_empty_means_any,
    capture_delay            AS capture_delay_bucket_filter_null_means_any,
    monthly_fraud_level      AS monthly_fraud_level_bucket_filter_null_means_any,
    monthly_volume           AS monthly_volume_bucket_filter_null_means_any,
    merchant_category_code   AS mccs_filter_empty_means_any,
    is_credit                AS is_credit_filter_null_means_any,
    aci                      AS acis_filter_empty_means_any,
    fixed_amount             AS fixed_fee_eur,
    rate                     AS variable_rate_bps,
    intracountry             AS intracountry_filter_null_means_any
FROM read_json_auto('${DATA_DIR}/context/fees.json');
