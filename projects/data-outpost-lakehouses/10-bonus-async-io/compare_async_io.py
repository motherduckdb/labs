# Times a remote Parquet scan with whichever DuckDB version uv puts in the environment.
# Run from the workshop folder, once per version:
#   uv run --no-project --python 3.13 --with duckdb==1.5.6 python 10-bonus-async-io/compare_async_io.py
#   uv run --no-project --python 3.13 --with duckdb==2.0.0 python 10-bonus-async-io/compare_async_io.py
# Uses an in-memory database, so it never opens data/workshop.duckdb with DuckDB 2.0.
import time

import duckdb

QUERY = """
SELECT count(*) AS comments, sum(length(text)) AS text_chars
FROM read_parquet('s3://us-prd-motherduck-open-datasets/hacker_news/parquet/comments_stories/comments/dt=*/*.parquet')
"""

con = duckdb.connect()
con.sql("INSTALL httpfs; LOAD httpfs;")
# Read from S3 on every run instead of DuckDB's cache of remote files.
con.sql("SET enable_external_file_cache = false;")

for run in (1, 2, 3):
    start = time.perf_counter()
    rows = con.sql(QUERY).fetchall()
    print(f"DuckDB {duckdb.__version__}  run {run}: {rows[0]}  {time.perf_counter() - start:.2f}s")
