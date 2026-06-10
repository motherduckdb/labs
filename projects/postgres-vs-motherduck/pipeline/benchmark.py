# /// script
# requires-python = ">=3.10"
# dependencies = ["psycopg[binary]>=3.2", "python-dotenv>=1.0"]
# ///
"""
benchmark.py — time the same query on Postgres vs MotherDuck.

Uses the SAME driver (psycopg) for both: Postgres directly, and MotherDuck via its
Postgres wire-protocol endpoint. Same SQL, only the connection host changes.

    uv run benchmark.py            # both queries, shop 1
    uv run benchmark.py --shop 42  # single-shop query for shop 42

Env (.env): POSTGRES_URL, MOTHERDUCK_TOKEN, MD_PG_HOST, MD_DATABASE.
"""
import os
import sys
import time
import psycopg
from dotenv import load_dotenv
from queries import PLATFORM_MONTHLY_REVENUE, SHOP_CATEGORY_TREND

load_dotenv()
RUNS = 3  # 1 cold + 2 warm per engine


def pg_conn():
    return psycopg.connect(os.environ["POSTGRES_URL"])


def md_conn():
    return psycopg.connect(
        host=os.environ.get("MD_PG_HOST", "pg.us-east-1-aws.motherduck.com"),
        port=int(os.environ.get("MD_PG_PORT", "5432")),
        user=os.environ.get("MD_PG_USER", "motherduck"),
        password=os.environ["MOTHERDUCK_TOKEN"],
        dbname=os.environ.get("MD_DATABASE", "multishop_commerce"),
        sslmode="require",
    )


def time_it(conn_factory, sql):
    times, rows = [], 0
    with conn_factory() as conn:
        for _ in range(RUNS):
            with conn.cursor() as cur:
                start = time.perf_counter()
                cur.execute(sql)
                rows = len(cur.fetchall())
                times.append(time.perf_counter() - start)
    return {"cold": times[0], "best": min(times), "rows": rows}


def fmt(s):
    return f"{s * 1000:.0f} ms" if s < 1 else f"{s:.2f} s"


def run_case(label, sql):
    print(f"\n-- {label}")
    pg = time_it(pg_conn, sql)
    print(f"  Postgres    cold {fmt(pg['cold']):>9}  best {fmt(pg['best']):>9}  ({pg['rows']} rows)")
    md = time_it(md_conn, sql)
    print(f"  MotherDuck  cold {fmt(md['cold']):>9}  best {fmt(md['best']):>9}  ({md['rows']} rows)")
    speedup = pg["best"] / md["best"] if md["best"] else float("inf")
    parity = "rows match" if pg["rows"] == md["rows"] else "ROW COUNT MISMATCH"
    print(f"  -> MotherDuck is {speedup:.0f}x faster (best of {RUNS}); {parity}")


def main():
    shop = int(sys.argv[sys.argv.index("--shop") + 1]) if "--shop" in sys.argv else 1
    run_case("Platform-wide monthly revenue", PLATFORM_MONTHLY_REVENUE)
    run_case(f"Single-shop category trend, 12 months (shop {shop})",
             SHOP_CATEGORY_TREND.format(shop=shop))
    print("\n(cold = first run; best = fastest of repeated runs)\n")


if __name__ == "__main__":
    main()
