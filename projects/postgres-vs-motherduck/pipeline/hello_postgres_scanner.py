# /// script
# requires-python = ">=3.10"
# dependencies = ["duckdb==1.5.2", "python-dotenv>=1.0"]
# ///
"""
hello_postgres_scanner.py — the "hello world" of DuckDB's Postgres scanner.

No MotherDuck, no data movement yet. Just point a *local* DuckDB at your remote
Postgres and read it in place — to prove the connection works and to get a first
look at the source dataset before we move anything.

It prints a "view on the dataset sources": every source table, its row count, and
a tiny sample from the biggest fact table — all read live from Postgres through
the scanner.

Env (.env): POSTGRES_URL.

    cp .env.example .env          # fill in POSTGRES_URL
    uv run hello_postgres_scanner.py
"""
import os
import duckdb
from dotenv import load_dotenv

load_dotenv()

PG_URL = os.environ["POSTGRES_URL"]

# Same tables load_to_motherduck.py will move — here we only *read* them.
DIMENSIONS = ["shops", "categories", "products", "customers"]
FACTS = ["orders", "order_items"]


def main() -> None:
    # A plain in-memory DuckDB — nothing is persisted, nothing is moved.
    con = duckdb.connect()

    con.execute("INSTALL postgres")
    con.execute("LOAD postgres")
    # READ_ONLY: the scanner reads Postgres in place; it never writes back.
    con.execute(f"ATTACH '{PG_URL}' AS pg (TYPE postgres, READ_ONLY)")
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
