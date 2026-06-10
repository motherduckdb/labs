# /// script
# requires-python = ">=3.10"
# dependencies = ["duckdb==1.5.2", "python-dotenv>=1.0"]
# ///
"""
hello_postgres_scanner.py — the "hello world" of DuckDB's Postgres scanner.

No MotherDuck, no data movement yet. Just point a *local* DuckDB at your remote
Postgres and read it in place — to prove the connection works and to get a first
look at the source dataset before we move anything.

Auth matches the tested cookbook
(https://motherduck.com/docs/cookbook/flight-postgres-ingest/): the credentials
live in the environment and the attach uses an *empty* connection string —
`ATTACH '' AS pg (TYPE postgres, READ_ONLY)` — so the password never lands in SQL.

It prints a "view on the dataset sources": every source table, its row count, and
a tiny sample from the biggest fact table — all read live from Postgres.

Env (.env): Postgres creds as the cookbook's pg_* vars (pg_HOST, pg_PORT,
pg_DATABASE, pg_USER, pg_PASSWORD, pg_SSLMODE) or a single POSTGRES_URL.

    cp .env.example .env
    uv run hello_postgres_scanner.py
"""

import os
from urllib.parse import parse_qs, urlparse

import duckdb
from dotenv import load_dotenv

load_dotenv()

# Same tables load_to_motherduck.py will move — here we only *read* them.
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

    # A plain in-memory DuckDB — nothing is persisted, nothing is moved.
    con = duckdb.connect()

    con.execute("INSTALL postgres")
    con.execute("LOAD postgres")
    # Empty connection string: libpq reads PG* from env. READ_ONLY: the scanner
    # reads Postgres in place; it never writes back.
    con.execute("ATTACH '' AS pg (TYPE postgres, READ_ONLY)")
    print("attached remote Postgres via the scanner (read-only)\n")

    # A view on the dataset sources: count rows in each source table, live.
    print("source tables")
    print("-" * 40)
    for t in DIMENSIONS + FACTS:
        n = con.execute(f"SELECT COUNT(*) FROM pg.public.{t}").fetchone()[0]
        kind = "dim " if t in DIMENSIONS else "fact"
        print(f"  [{kind}] {t:<13} {n:>12,} rows")

    # Peek at the biggest table — querying Postgres directly from DuckDB SQL.
    print("\nsample — order_items (read straight from Postgres)")
    print("-" * 40)
    cur = con.execute("SELECT * FROM pg.public.order_items LIMIT 5")
    cols = [d[0] for d in cur.description]
    print("  " + " | ".join(cols))
    for row in cur.fetchall():
        print("  " + " | ".join(str(v) for v in row))

    print("\nhello world OK — the scanner can read your Postgres.")
    print("next: `uv run load_to_motherduck.py` to move it into MotherDuck.")


if __name__ == "__main__":
    main()
