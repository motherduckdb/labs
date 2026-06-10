# /// script
# requires-python = ">=3.10"
# dependencies = ["duckdb==1.5.2", "python-dotenv>=1.0"]
# ///
"""
load_to_motherduck.py — move data from Postgres into MotherDuck.

Runs locally (or anywhere with Python). It uses DuckDB's built-in Postgres scanner
to read your Postgres and write the result into MotherDuck:

  - dimensions (small)  -> full refresh every run
  - facts (append-only) -> incremental, keyed on a monotonic order_id watermark

Env (.env): POSTGRES_URL, MOTHERDUCK_TOKEN, MD_DATABASE (optional).

    cp .env.example .env   # fill it in
    uv run load_to_motherduck.py        # or: pip install -r requirements.txt && python load_to_motherduck.py
"""
import os
import duckdb
from dotenv import load_dotenv

load_dotenv()

MD_DB = os.environ.get("MD_DATABASE", "multishop_commerce")
PG_URL = os.environ["POSTGRES_URL"]
TOKEN = os.environ["MOTHERDUCK_TOKEN"]

DIMENSIONS = ["shops", "categories", "products", "customers"]
FACTS = ["orders", "order_items"]


def main() -> None:
    con = duckdb.connect(f"md:?motherduck_token={TOKEN}")
    con.execute(f"CREATE DATABASE IF NOT EXISTS {MD_DB}")
    con.execute(f"USE {MD_DB}")

    con.execute("INSTALL postgres")
    con.execute("LOAD postgres")
    con.execute(f"ATTACH '{PG_URL}' AS pg (TYPE postgres, READ_ONLY)")

    # 1) dimensions — full refresh. SELECT * stays resilient to new columns.
    for t in DIMENSIONS:
        con.execute(f"CREATE OR REPLACE TABLE {t} AS SELECT * FROM pg.public.{t}")
        n = con.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
        print(f"[dim ] {t}: {n:,} rows (full refresh)")

    # 2) facts — incremental. Compute the watermark before inserting so orders and
    #    their order_items stay consistent against the same cutoff.
    for t in FACTS:
        con.execute(f"CREATE TABLE IF NOT EXISTS {t} AS SELECT * FROM pg.public.{t} WHERE false")
    watermark = con.execute("SELECT COALESCE(MAX(order_id), 0) FROM orders").fetchone()[0]
    for t in FACTS:
        con.execute(f"INSERT INTO {t} SELECT * FROM pg.public.{t} WHERE order_id > {watermark}")
        n = con.execute(f"SELECT COUNT(*) FROM {t} WHERE order_id > {watermark}").fetchone()[0]
        print(f"[fact] {t}: +{n:,} new rows (order_id > {watermark})")

    print(f"\nsync complete -> md:{MD_DB}")


if __name__ == "__main__":
    main()
