-- MotherDuck's public Iceberg datasets, queryable from DuckDB with NO credentials.
-- Tested 2026-10-29 with DuckDB v1.5.3 (iceberg + httpfs extensions).
-- Run:  duckdb -f public_iceberg_datasets.sql
INSTALL iceberg; LOAD iceberg; INSTALL httpfs; LOAD httpfs;
.timer on

-- Anonymous S3 access: a config secret with no keys, scoped to the bucket (sets the region).
CREATE SECRET md_open (TYPE s3, PROVIDER config, REGION 'us-east-1', SCOPE 's3://us-prd-motherduck-open-datasets');

------------------------------------------------------------------------------
-- 1. MotherDuck open datasets: TPC-H lineitem (s3, anonymous)
------------------------------------------------------------------------------
SELECT l_returnflag, l_linestatus, count(*) AS n, round(sum(l_extendedprice), 2) AS revenue
FROM iceberg_scan('s3://us-prd-motherduck-open-datasets/iceberg/lineitem_iceberg', allow_moved_paths = true)
GROUP BY ALL ORDER BY ALL;

------------------------------------------------------------------------------
-- 2. MotherDuck open datasets: TPC-DS, 24 tables under iceberg/tpcds/iceberg/default.db/
------------------------------------------------------------------------------
SELECT count(*) AS store_sales_rows
FROM iceberg_scan('s3://us-prd-motherduck-open-datasets/iceberg/tpcds/iceberg/default.db/store_sales', allow_moved_paths = true);

------------------------------------------------------------------------------
-- 3. MotherDuck open datasets: WHO ambient air quality ("ducks" table)
--    No version-hint file, so the metadata version is passed explicitly.
------------------------------------------------------------------------------
SELECT country_name, city, year, pm25_concentration
FROM iceberg_scan('s3://us-prd-motherduck-open-datasets/iceberg/ducks', allow_moved_paths = true,
                  version = '00002-ec00ab72-7a34-4785-a04b-5e6bfcdc100e')
LIMIT 5;
