# /// script
# requires-python = ">=3.10"
# dependencies = ["duckdb==1.5.2", "python-dotenv>=1.0"]
# ///
"""
attach_share.py — the zero-data "after". Attach the ready-made public MotherDuck
share into your account so the webapp's MotherDuck side works without loading
anything. This is the fast path: no Postgres, no pipeline — just a token.

It attaches the share under MD_DATABASE (default `multishop_commerce`), which is the
database the webapp reads. Run it once; the attachment persists in your account.

Env (.env): MOTHERDUCK_TOKEN, MD_DATABASE (optional), MD_SHARE_URL (optional).

    uv run attach_share.py
"""

import os

import duckdb
from dotenv import load_dotenv

load_dotenv()

SHARE_URL = os.environ.get(
    "MD_SHARE_URL",
    "md:_share/multishop_commerce/ac3d36cc-f295-4c66-bf13-371b998f12e8",
)
MD_DB = os.environ.get("MD_DATABASE", "multishop_commerce")


def main() -> None:
    con = duckdb.connect("md:")  # token from MOTHERDUCK_TOKEN env

    already = con.execute(
        "SELECT COUNT(*) FROM duckdb_databases() WHERE database_name = ?", [MD_DB]
    ).fetchone()[0]
    if already:
        print(f"'{MD_DB}' already exists in your account — leaving it as is.")
        print("(Detach it first if you want to re-point it at the share.)")
    else:
        con.execute(f"ATTACH '{SHARE_URL}' AS {MD_DB} (READ_ONLY)")
        print(f"attached share -> {MD_DB}")

    for t, label in [("shops", "dim "), ("orders", "fact"), ("order_items", "fact")]:
        n = con.execute(f"SELECT COUNT(*) FROM {MD_DB}.main.{t}").fetchone()[0]
        print(f"  [{label}] {t}: {n:,} rows")

    print(f"\nready — the webapp's MotherDuck side can now read '{MD_DB}'.")


if __name__ == "__main__":
    main()
