"""Build the MotherDuck database for DABStep from the local source files.

Creates 5 tables in MotherDuck database `$MD_DATABASE` (default
`agentic_sql_claude`) from the copied DABStep sources, keeping the **native
DABStep column names** (the manual, payments-readme, and SQL patterns all
reference `merchant`, `eur_amount`, `has_fraudulent_dispute`, `aci`, etc., so we
do not rename anything).

The local DuckDB process reads the CSV/JSON files and `CREATE OR REPLACE TABLE`s
them into the attached MotherDuck database — DuckDB's MotherDuck integration
uploads the data as the tables are created.

Auth: set `MOTHERDUCK_TOKEN` in the environment (or `.env`).
"""

from __future__ import annotations

import os
from pathlib import Path

import duckdb

REPO_ROOT = Path(__file__).resolve().parents[1]
CONTEXT_DIR = REPO_ROOT / "data" / "dabstep" / "context"

DEFAULT_DATABASE = "agentic_sql_claude"

# Per-table CREATE statements. `{ctx}` is the local context dir; `{db}` the
# target MotherDuck database. Native column names preserved throughout.
_TABLE_SQL: dict[str, str] = {
    "payments": """
        CREATE OR REPLACE TABLE {db}.main.payments AS
        SELECT * FROM read_csv_auto('{ctx}/payments.csv', header=True)
    """,
    "fees": """
        CREATE OR REPLACE TABLE {db}.main.fees AS
        SELECT * FROM read_json_auto('{ctx}/fees.json')
    """,
    "merchants": """
        CREATE OR REPLACE TABLE {db}.main.merchants AS
        SELECT * FROM read_json_auto('{ctx}/merchant_data.json')
    """,
    "acquirer_countries": """
        CREATE OR REPLACE TABLE {db}.main.acquirer_countries AS
        SELECT * FROM read_csv_auto('{ctx}/acquirer_countries.csv', header=True)
    """,
    "merchant_category_codes": """
        CREATE OR REPLACE TABLE {db}.main.merchant_category_codes AS
        SELECT * FROM read_csv_auto('{ctx}/merchant_category_codes.csv', header=True)
    """,
}


def _connect(token: str | None = None) -> duckdb.DuckDBPyConnection:
    token = token or os.environ.get("MOTHERDUCK_TOKEN")
    if not token:
        raise RuntimeError(
            "MOTHERDUCK_TOKEN is not set. Add it to your environment or .env file."
        )
    # Pass the token via the connection string so we don't depend on env timing.
    return duckdb.connect(f"md:?motherduck_token={token}")


def build_db(database: str = DEFAULT_DATABASE, *, token: str | None = None) -> dict[str, int]:
    """(Re)build all tables in the MotherDuck `database`. Returns row counts."""
    if not CONTEXT_DIR.exists():
        raise FileNotFoundError(f"source context dir not found: {CONTEXT_DIR}")
    ctx = str(CONTEXT_DIR)
    conn = _connect(token)
    counts: dict[str, int] = {}
    try:
        conn.execute(f"CREATE DATABASE IF NOT EXISTS {database}")
        for table, sql in _TABLE_SQL.items():
            conn.execute(sql.format(db=database, ctx=ctx))
            n = conn.execute(f"SELECT count(*) FROM {database}.main.{table}").fetchone()[0]
            counts[table] = int(n)
    finally:
        conn.close()
    return counts
