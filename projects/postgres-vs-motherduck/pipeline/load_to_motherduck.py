# /// script
# requires-python = ">=3.10"
# dependencies = ["duckdb==1.5.2", "python-dotenv>=1.0"]
# ///
"""
load_to_motherduck.py — move data from Postgres into MotherDuck.

Same auth + attach method as the tested MotherDuck cookbook
(https://motherduck.com/docs/cookbook/flight-postgres-ingest/): connect to
MotherDuck with `md:` (token from the MOTHERDUCK_TOKEN env var), then read
Postgres through `ATTACH '' AS pg (TYPE postgres, READ_ONLY)` — an *empty*
connection string so the credentials stay in the environment, never in SQL.
Drop it into a MotherDuck Flight unchanged: a `pg` secret (TYPE flights) injects
the same `pg_*` env vars this script reads.

  - dimensions (small)  -> full refresh every run
  - facts (append-only) -> incremental, keyed on a monotonic order_id watermark

Env (.env): MOTHERDUCK_TOKEN, MD_DATABASE (optional), and Postgres creds as either
the cookbook's pg_* vars (pg_HOST, pg_PORT, pg_DATABASE, pg_USER, pg_PASSWORD,
pg_SSLMODE) or a single POSTGRES_URL.

    cp .env.example .env
    uv run load_to_motherduck.py
"""

import os
from urllib.parse import parse_qs, urlparse

import duckdb
from dotenv import load_dotenv

load_dotenv()

MD_DB = os.environ.get("MD_DATABASE", "multishop_commerce")

DIMENSIONS = ["shops", "categories", "products", "customers"]
FACTS = ["orders", "order_items"]


def export_libpq_env() -> None:
    """Match the cookbook: Postgres credentials live in the environment, never in
    the SQL. Accept the cookbook's pg_* names (what the `pg` Flights secret injects)
    or a POSTGRES_URL, and export the standard libpq PG* vars so an empty
    `ATTACH '' (TYPE postgres)` connects with the password kept out of SQL."""
    if os.environ.get("pg_HOST"):
        env = {
            "PGHOST": os.environ["pg_HOST"],
            "PGPORT": os.environ.get("pg_PORT", "5432"),
            "PGDATABASE": os.environ.get("pg_DATABASE", ""),
            "PGUSER": os.environ.get("pg_USER", ""),
            "PGPASSWORD": os.environ.get("pg_PASSWORD", ""),
            "PGSSLMODE": os.environ.get("pg_SSLMODE", "require"),
        }
    elif os.environ.get("POSTGRES_URL"):
        u = urlparse(os.environ["POSTGRES_URL"])
        q = parse_qs(u.query)
        env = {
            "PGHOST": u.hostname or "",
            "PGPORT": str(u.port or 5432),
            "PGDATABASE": (u.path or "").lstrip("/"),
            "PGUSER": u.username or "",
            "PGPASSWORD": u.password or "",
            "PGSSLMODE": (q.get("sslmode") or ["require"])[0],
        }
    else:
        raise SystemExit("Set pg_HOST… (cookbook/Flight vars) or POSTGRES_URL in .env")
    os.environ.update({k: v for k, v in env.items() if v})


def main() -> None:
    export_libpq_env()

    # Token comes from the MOTHERDUCK_TOKEN env var (loaded from .env), not the URL.
    con = duckdb.connect("md:")
    con.execute(f"CREATE DATABASE IF NOT EXISTS {MD_DB}")
    con.execute(f"USE {MD_DB}")

    con.execute("INSTALL postgres")
    con.execute("LOAD postgres")
    # Empty connection string: libpq reads PG* from env. READ_ONLY lets the
    # extension parallelize reads and never writes back to the source.
    con.execute("ATTACH '' AS pg (TYPE postgres, READ_ONLY)")

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
