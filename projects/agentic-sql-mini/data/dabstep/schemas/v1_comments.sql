-- v1 domain comments for DABstep
-- Adds COMMENT ON statements to expose domain knowledge through schema metadata.
-- Applied to dabstep_b (v1) and dabstep_c (v2) tiers.
-- NULL values in fee rules act as wildcards; column comments explain this.

-- fees table
COMMENT ON TABLE fees IS 'Fee rules. NULL in any dimension = wildcard (matches all values). Fee = fixed_amount + (rate * eur_amount / 10000).';

COMMENT ON COLUMN fees.card_scheme IS 'NULL = matches all.';
COMMENT ON COLUMN fees.account_type IS 'NULL = matches all.';
COMMENT ON COLUMN fees.capture_delay IS 'Bucketed: <3, 3-5, >5, immediate, manual. NULL = matches all.';
COMMENT ON COLUMN fees.monthly_fraud_level IS 'Bucketed: <7.2%, 7.2%-7.7%, 7.7%-8.3%, >8.3%. NULL = matches all.';
COMMENT ON COLUMN fees.monthly_volume IS 'Bucketed (ordered): <100k < 100k-1m < 1m-5m < >5m. Higher volume = cheaper fees (manual §5). >5m is the ceiling. NULL = matches all.';
COMMENT ON COLUMN fees.is_credit IS 'NULL = matches both.';
COMMENT ON COLUMN fees.aci IS 'NULL = matches all.';
COMMENT ON COLUMN fees.intracountry IS '1.0=domestic, 0.0=international. NULL = matches both.';
COMMENT ON COLUMN fees.merchant_category_code IS 'NULL = matches all.';
COMMENT ON COLUMN fees.rate IS 'Basis points. Fee = fixed_amount + (rate * eur_amount / 10000). rate=75 means 0.75%.';
COMMENT ON COLUMN fees.ID IS 'Fee rule ID. Multiple rows per ID (one per MCC/ACI combo); fixed_amount and rate are the same across rows.';

-- merchants table
COMMENT ON TABLE merchants IS 'Dimension table (30 merchants). Only 5 appear in payments. To list merchants "in the dataset": SELECT DISTINCT merchant FROM payments.';
COMMENT ON COLUMN merchants.capture_delay IS 'Raw value. Bucket for fee matching: numeric <3 maps to <3, 3-5 maps to 3-5, >5 maps to >5. Non-numeric (immediate, manual) match directly.';
COMMENT ON COLUMN merchants.acquirer IS 'Array. Use LATERAL UNNEST, then JOIN acquirer_countries for country codes.';

-- payments table
COMMENT ON TABLE payments IS 'Primary dataset: 138K+ transactions for 5 merchants.';
COMMENT ON COLUMN payments.day_of_year IS '1-365. To get date: MAKE_DATE(year, 1, 1) + INTERVAL (day_of_year - 1) DAY.';
COMMENT ON COLUMN payments.issuing_country IS 'Compare with acquirer_country for intracountry: 1.0 if equal, 0.0 if not.';
