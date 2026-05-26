CREATE TABLE table_1 AS
SELECT
    psp_reference          AS column_a,
    merchant               AS column_b,
    card_scheme            AS column_c,
    year                   AS column_d,
    hour_of_day            AS column_e,
    minute_of_hour         AS column_f,
    day_of_year            AS column_g,
    is_credit              AS column_h,
    eur_amount             AS column_i,
    ip_country             AS column_j,
    issuing_country        AS column_k,
    device_type            AS column_l,
    ip_address             AS column_m,
    email_address          AS column_n,
    card_number            AS column_o,
    shopper_interaction    AS column_p,
    card_bin               AS column_q,
    has_fraudulent_dispute AS column_r,
    is_refused_by_adyen    AS column_s,
    aci                    AS column_t,
    acquirer_country       AS column_u
FROM read_csv_auto('${DATA_DIR}/context/payments.csv', header=True);

CREATE TABLE table_2 AS
SELECT
    acquirer     AS column_a,
    country_code AS column_b
FROM read_csv_auto('${DATA_DIR}/context/acquirer_countries.csv', header=True);

CREATE TABLE table_3 AS
SELECT
    mcc         AS column_a,
    description AS column_b
FROM read_csv_auto('${DATA_DIR}/context/merchant_category_codes.csv', header=True);

CREATE TABLE table_4 AS
SELECT
    merchant               AS column_a,
    capture_delay          AS column_b,
    acquirer               AS column_c,
    merchant_category_code AS column_d,
    account_type           AS column_e
FROM read_json_auto('${DATA_DIR}/context/merchant_data.json');

CREATE TABLE table_5 AS
SELECT
    ID                     AS column_a,
    card_scheme            AS column_b,
    account_type           AS column_c,
    capture_delay          AS column_d,
    monthly_fraud_level    AS column_e,
    monthly_volume         AS column_f,
    merchant_category_code AS column_g,
    is_credit              AS column_h,
    aci                    AS column_i,
    fixed_amount           AS column_j,
    rate                   AS column_k,
    intracountry           AS column_l
FROM read_json_auto('${DATA_DIR}/context/fees.json');
