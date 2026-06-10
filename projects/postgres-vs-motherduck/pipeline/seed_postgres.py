# /// script
# requires-python = ">=3.10"
# dependencies = ["duckdb==1.5.2", "python-dotenv>=1.0"]
# ///
"""
seed_postgres.py — manufacture a "before" Postgres from the public MotherDuck share.

OPTIONAL. The real demo offloads data OUT of Postgres into MotherDuck — you do not
move data INTO Postgres for this. This script exists only so the walkthrough has a
slow "before" to measure when you don't already have a big Postgres lying around.

DuckDB reads the ready-made public share, writes it into your (throwaway) Postgres,
then creates the indexes a real OLTP Postgres would have — so the comparison is a
fair row-store-vs-columnar fight, not a strawman against an unindexed table.

Env (.env): POSTGRES_URL, MOTHERDUCK_TOKEN.

    cp .env.example .env
    uv run seed_postgres.py                  # load the full share (~3.9M order_items)
    uv run seed_postgres.py --fraction 0.25  # quarter of the facts, for a quicker load
"""

import argparse
import os
from urllib.parse import parse_qs, urlparse

import duckdb
from dotenv import load_dotenv

load_dotenv()

# The ready-made dataset, published as an unrestricted MotherDuck share. Any token
# can attach it read-only; this is the same data the webapp reads as the "after".
SHARE_URL = os.environ.get(
    "MD_SHARE_URL",
    "md:_share/multishop_commerce/ac3d36cc-f295-4c66-bf13-371b998f12e8",
)

DIMENSIONS = ["shops", "categories", "products", "customers"]
FACTS = ["orders", "order_items"]


def export_libpq_env() -> None:
    """Postgres credentials via env (cookbook style) — pg_* vars or POSTGRES_URL —
    so the destination attach uses an empty connection string, no creds in SQL."""
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

# Indexes a real transactional Postgres would carry — primary keys + the foreign
# keys the analytics query joins/filters on. Created after the bulk load (faster).
INDEXES = [
    "CREATE INDEX IF NOT EXISTS ix_shops_pk        ON shops(shop_id)",
    "CREATE INDEX IF NOT EXISTS ix_categories_pk   ON categories(category_id)",
    "CREATE INDEX IF NOT EXISTS ix_products_pk      ON products(product_id)",
    "CREATE INDEX IF NOT EXISTS ix_products_cat     ON products(category_id)",
    "CREATE INDEX IF NOT EXISTS ix_customers_pk     ON customers(customer_id)",
    "CREATE INDEX IF NOT EXISTS ix_orders_pk        ON orders(order_id)",
    "CREATE INDEX IF NOT EXISTS ix_orders_shop      ON orders(shop_id)",
    "CREATE INDEX IF NOT EXISTS ix_orders_status    ON orders(status)",
    "CREATE INDEX IF NOT EXISTS ix_orders_ordered   ON orders(ordered_at)",
    "CREATE INDEX IF NOT EXISTS ix_order_items_order ON order_items(order_id)",
    "CREATE INDEX IF NOT EXISTS ix_order_items_shop  ON order_items(shop_id)",
    "CREATE INDEX IF NOT EXISTS ix_order_items_prod  ON order_items(product_id)",
]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--fraction",
        type=float,
        default=1.0,
        help="fraction of the fact rows to load (0 < f <= 1), keyed on order_id; default 1.0",
    )
    args = ap.parse_args()
    frac = max(0.0, min(1.0, args.fraction))

    export_libpq_env()

    con = duckdb.connect("md:")  # token from MOTHERDUCK_TOKEN env
    con.execute(f"ATTACH '{SHARE_URL}' AS src (READ_ONLY)")

    con.execute("INSTALL postgres")
    con.execute("LOAD postgres")
    # Empty connection string: libpq reads PG* from env (writable — seed creates tables).
    con.execute("ATTACH '' AS pg (TYPE postgres)")

    # 1) dimensions — full copy.
    for t in DIMENSIONS:
        con.execute(f"CREATE OR REPLACE TABLE pg.public.{t} AS SELECT * FROM src.main.{t}")
        n = con.execute(f"SELECT COUNT(*) FROM pg.public.{t}").fetchone()[0]
        print(f"[dim ] {t}: {n:,} rows")

    # 2) facts — keep orders and their order_items consistent against one order_id
    #    cutoff so a partial load stays referentially sane.
    cutoff = con.execute(
        "SELECT MIN(order_id) + CAST((MAX(order_id) - MIN(order_id)) * ? AS BIGINT) "
        "FROM src.main.orders",
        [frac],
    ).fetchone()[0]
    for t in FACTS:
        con.execute(
            f"CREATE OR REPLACE TABLE pg.public.{t} AS "
            f"SELECT * FROM src.main.{t} WHERE order_id <= {cutoff}"
        )
        n = con.execute(f"SELECT COUNT(*) FROM pg.public.{t}").fetchone()[0]
        print(f"[fact] {t}: {n:,} rows (order_id <= {cutoff})")

    # 3) indexes — make the "before" a fairly-tuned Postgres, not a strawman.
    print("\ncreating indexes on Postgres...")
    for ddl in INDEXES:
        con.execute(f"CALL postgres_execute('pg', {ddl!r})")
    print(f"  {len(INDEXES)} indexes created")

    print(f"\nseed complete -> Postgres now holds the 'before' (fraction={frac})")


if __name__ == "__main__":
    main()
