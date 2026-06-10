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

import duckdb
from dotenv import load_dotenv

load_dotenv()

# The ready-made dataset, published as an unrestricted MotherDuck share. Any token
# can attach it read-only; this is the same data the webapp reads as the "after".
SHARE_URL = os.environ.get(
    "MD_SHARE_URL",
    "md:_share/multishop_commerce/ac3d36cc-f295-4c66-bf13-371b998f12e8",
)

PG_URL = os.environ["POSTGRES_URL"]
TOKEN = os.environ["MOTHERDUCK_TOKEN"]

DIMENSIONS = ["shops", "categories", "products", "customers"]
FACTS = ["orders", "order_items"]

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

    con = duckdb.connect(f"md:?motherduck_token={TOKEN}")
    con.execute(f"ATTACH '{SHARE_URL}' AS src (READ_ONLY)")

    con.execute("INSTALL postgres")
    con.execute("LOAD postgres")
    con.execute(f"ATTACH '{PG_URL}' AS pg (TYPE postgres)")

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
