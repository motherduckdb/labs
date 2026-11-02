-- Builds data/hacker_news.ducklake: a frozen (read-only) DuckLake over Parquet files that
-- already sit in MotherDuck's public bucket. No data is copied: the .ducklake file only holds
-- the catalog, and every data file path points at s3://us-prd-motherduck-open-datasets.
-- Based on https://ducklake.select/2025/10/24/frozen-ducklake/
-- Run from the workshop folder:  uvx --from duckdb-cli==1.5.6 duckdb -f frozen/build_frozen_ducklake.sql
INSTALL ducklake; INSTALL httpfs; LOAD ducklake; LOAD httpfs;
CREATE OR REPLACE SECRET md_open (TYPE s3, PROVIDER config, REGION 'us-east-1', SCOPE 's3://us-prd-motherduck-open-datasets');

-- DATA_PATH is required but never receives data files, so point it at a throwaway folder.
ATTACH 'ducklake:data/hacker_news.ducklake' AS hn (DATA_PATH 'data/frozen_unused/');

-- 1. Empty tables whose schema comes from one Parquet file each. The dt=... folder names are
--    not columns inside the files, so hive_partitioning stays off.
CREATE TABLE hn.stories AS
FROM read_parquet('s3://us-prd-motherduck-open-datasets/hacker_news/parquet/comments_stories/stories/dt=2024-12-21/data0.parquet', hive_partitioning = false)
WITH NO DATA;
CREATE TABLE hn.comments AS
FROM read_parquet('s3://us-prd-motherduck-open-datasets/hacker_news/parquet/comments_stories/comments/dt=2024-12-21/data0.parquet', hive_partitioning = false)
WITH NO DATA;

-- 2. Register the existing files. A glob adds every matching file in one call.
--    Register December, then January.
--    Each call adds files again if repeated, so run this script once per fresh .ducklake file.
CALL ducklake_add_data_files('hn', 'stories',  's3://us-prd-motherduck-open-datasets/hacker_news/parquet/comments_stories/stories/dt=2024-12-*/*.parquet');
CALL ducklake_add_data_files('hn', 'comments', 's3://us-prd-motherduck-open-datasets/hacker_news/parquet/comments_stories/comments/dt=2024-12-*/*.parquet');
CALL ducklake_add_data_files('hn', 'stories',  's3://us-prd-motherduck-open-datasets/hacker_news/parquet/comments_stories/stories/dt=2025-01-*/*.parquet');
CALL ducklake_add_data_files('hn', 'comments', 's3://us-prd-motherduck-open-datasets/hacker_news/parquet/comments_stories/comments/dt=2025-01-*/*.parquet');

SELECT table_name, count(*) AS files, sum(record_count) AS rows
FROM __ducklake_metadata_hn.ducklake_data_file JOIN __ducklake_metadata_hn.ducklake_table USING (table_id)
GROUP BY ALL ORDER BY ALL;
