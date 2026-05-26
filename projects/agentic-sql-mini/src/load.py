"""Build a DuckDB file for one arm by applying a schema SQL script.

Each arm has a single SQL file in `schemas/`:
- `baseline.sql` — generic table_1 / column_a names, no comments.
- `explicit.sql` — hand-tuned descriptive names.

The script is responsible for creating tables (typically `CREATE TABLE x AS
SELECT ... FROM read_csv/read_parquet(...)`) pointing at `data/dabstep/context/`.
"""

from __future__ import annotations

from pathlib import Path

import duckdb

REPO_ROOT = Path(__file__).resolve().parents[1]
SCHEMAS_DIR = REPO_ROOT / "schemas"
DATA_DIR = REPO_ROOT / "data" / "dabstep"


def build_db(arm: str, target_db: Path, *, overwrite: bool = True) -> Path:
    """Apply `schemas/{arm}.sql` to a fresh DuckDB file.

    The SQL script can reference `${DATA_DIR}` which is substituted before
    execution.
    """
    sql_path = SCHEMAS_DIR / f"{arm}.sql"
    if not sql_path.exists():
        raise FileNotFoundError(f"No schema file for arm '{arm}': {sql_path}")

    if target_db.exists() and overwrite:
        target_db.unlink()

    sql = sql_path.read_text().replace("${DATA_DIR}", str(DATA_DIR))

    conn = duckdb.connect(str(target_db))
    try:
        conn.execute(sql)
    finally:
        conn.close()

    return target_db
