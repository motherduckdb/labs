-- Builds data/workshop.duckdb: a small local DuckDB file for the MCP exercises,
-- materialized from MotherDuck's public Iceberg tables (no credentials needed).
-- Run from the workshop folder:  duckdb data/workshop.duckdb -f mcp/build_workshop_db.sql
INSTALL iceberg; LOAD iceberg; INSTALL httpfs; LOAD httpfs;
CREATE OR REPLACE SECRET md_open (TYPE s3, PROVIDER config, REGION 'us-east-1', SCOPE 's3://us-prd-motherduck-open-datasets');

-- TPC-H lineitem
CREATE OR REPLACE TABLE lineitem AS
FROM iceberg_scan('s3://us-prd-motherduck-open-datasets/iceberg/lineitem_iceberg', allow_moved_paths = true);

-- TPC-DS dimension tables
CREATE OR REPLACE TABLE store AS
FROM iceberg_scan('s3://us-prd-motherduck-open-datasets/iceberg/tpcds/iceberg/default.db/store', allow_moved_paths = true);

CREATE OR REPLACE TABLE item AS
FROM iceberg_scan('s3://us-prd-motherduck-open-datasets/iceberg/tpcds/iceberg/default.db/item', allow_moved_paths = true);

CREATE OR REPLACE TABLE date_dim AS
FROM iceberg_scan('s3://us-prd-motherduck-open-datasets/iceberg/tpcds/iceberg/default.db/date_dim', allow_moved_paths = true);

COMMENT ON TABLE lineitem IS 'TPC-H lineitem, from s3://us-prd-motherduck-open-datasets/iceberg/lineitem_iceberg';
COMMENT ON TABLE store IS 'TPC-DS store, from s3://us-prd-motherduck-open-datasets/iceberg/tpcds/iceberg/default.db/store';
COMMENT ON TABLE item IS 'TPC-DS item, from s3://us-prd-motherduck-open-datasets/iceberg/tpcds/iceberg/default.db/item';
COMMENT ON TABLE date_dim IS 'TPC-DS date_dim, from s3://us-prd-motherduck-open-datasets/iceberg/tpcds/iceberg/default.db/date_dim';

SELECT table_name, estimated_size AS approx_rows FROM duckdb_tables() ORDER BY 1;
