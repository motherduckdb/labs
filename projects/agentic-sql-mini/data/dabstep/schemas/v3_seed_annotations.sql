-- v3 seed annotations: domain knowledge from manual.md that enriches metadata-generator COMMENTs.
-- Split from v3_metadata.sql. Contains only INSERT INTO annotations statements.
-- Only non-obvious facts that the profiler can't infer from data alone.

INSERT OR REPLACE INTO annotations (id, db_name, table_name, column_name, annotation, source)
VALUES
-- fees table
(1,  'dabstep_d', 'fees', NULL,                      'fee = fixed_amount + rate * txn_value / 10000. NULL dimension = wildcard. Multiple rules match per txn, all summed.', 'manual'),
(2,  'dabstep_d', 'fees', 'ID',                      'One ID = one fixed_amount + rate pair.', 'manual'),
(3,  'dabstep_d', 'fees', 'card_scheme',              'NULL = all schemes.', 'manual'),
(4,  'dabstep_d', 'fees', 'account_type',             'R=Retail, D=Digital, H=Hospitality, F=Franchise, S=SaaS, O=Other. NULL = all.', 'manual'),
(5,  'dabstep_d', 'fees', 'capture_delay',            'NULL = all. Faster = costlier.', 'manual'),
(6,  'dabstep_d', 'fees', 'monthly_fraud_level',      'NULL = all. Higher fraud = costlier.', 'manual'),
(7,  'dabstep_d', 'fees', 'monthly_volume',           'NULL = all. Higher vol = cheaper.', 'manual'),
(8,  'dabstep_d', 'fees', 'is_credit',                'NULL = both. Credit = costlier.', 'manual'),
(9,  'dabstep_d', 'fees', 'fixed_amount',             'EUR per txn.', 'manual'),
(10, 'dabstep_d', 'fees', 'rate',                     'Basis points. rate=75 → 0.75%. Multiply by txn_value / 10000.', 'manual'),
(11, 'dabstep_d', 'fees', 'intracountry',             '1.0=domestic, 0.0=intl. NULL = both. Domestic = cheaper.', 'manual'),
(12, 'dabstep_d', 'fees', 'aci',                      'NULL = all ACIs. ACI G has no explicit rules — matches only via NULL.', 'manual'),
(13, 'dabstep_d', 'fees', 'merchant_category_code',   'NULL = all MCCs.', 'manual'),
-- payments table
(14, 'dabstep_d', 'payments', 'merchant',             'FK → merchants.merchant.', 'manual'),
(15, 'dabstep_d', 'payments', 'day_of_year',          'To date: MAKE_DATE(year,1,1) + INTERVAL (day_of_year-1) DAY. "50th of the year" = day_of_year 50, not month.', 'manual'),
(16, 'dabstep_d', 'payments', 'issuing_country',      'intracountry = (issuing_country = acquirer_country).', 'manual'),
(17, 'dabstep_d', 'payments', 'acquirer_country',     'Compare with issuing_country for intracountry.', 'manual'),
(18, 'dabstep_d', 'payments', 'email_address',        '"Customer" = email, not card_number. One customer can have multiple cards.', 'manual'),
(19, 'dabstep_d', 'payments', 'card_number',          'NOT the customer identifier — use email_address.', 'manual'),
(20, 'dabstep_d', 'payments', 'has_fraudulent_dispute', 'Fraud rate (amount-weighted) ≠ fraud percentage (count-based).', 'manual'),
(21, 'dabstep_d', 'payments', 'aci',                  'A=Present non-auth, B=Present auth, C=Tokenized mobile, D=CNP card-on-file, E=CNP recurring, F=CNP 3DS, G=CNP non-3DS.', 'manual'),
-- merchants table
(22, 'dabstep_d', 'merchants', NULL,                  'Only ~5 merchants active in payments. "Merchants in dataset" usually means DISTINCT merchant FROM payments.', 'manual'),
(23, 'dabstep_d', 'merchants', 'merchant',            'PK → payments.merchant.', 'manual'),
(24, 'dabstep_d', 'merchants', 'capture_delay',       'Bucket for fees: TRY_CAST <3→''<3'', 3-5→''3-5'', >5→''>5''. ''immediate''/''manual'' match directly.', 'manual'),
(25, 'dabstep_d', 'merchants', 'acquirer',            'LATERAL UNNEST → JOIN acquirer_countries for country.', 'manual'),
(26, 'dabstep_d', 'merchants', 'merchant_category_code', 'Lookup in merchant_category_codes (mcc is VARCHAR — cast needed).', 'manual'),
(27, 'dabstep_d', 'merchants', 'account_type',        'R=Retail, D=Digital, H=Hospitality, F=Franchise, S=SaaS, O=Other.', 'manual'),
-- acquirer_countries table
(28, 'dabstep_d', 'acquirer_countries', NULL,          'Join via UNNEST(merchants.acquirer).', 'manual'),
(29, 'dabstep_d', 'acquirer_countries', 'acquirer',    'Matches UNNEST(merchants.acquirer).', 'manual'),
-- merchant_category_codes table
(30, 'dabstep_d', 'merchant_category_codes', NULL,     'mcc is VARCHAR, merchants.merchant_category_code is BIGINT — cast needed.', 'manual');
