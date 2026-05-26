"""
Load SQLite databases from BIRD benchmark into MotherDuck.

Each SQLite database is loaded as a schema in the MotherDuck database,
allowing all tables to be accessed via schema.table_name syntax.
"""

import os
from pathlib import Path

import duckdb


# Databases included in BIRD Mini-Dev
BIRD_DATABASES = [
    "california_schools",
    "card_games",
    "codebase_community",
    "debit_card_specializing",
    "european_football_2",
    "financial",
    "formula_1",
    "student_club",
    "superhero",
    "thrombosis_prediction",
    "toxicology",
]


def find_sqlite_file(db_path: Path, db_name: str) -> Path | None:
    """Find the SQLite file within a database directory."""
    possible_paths = [
        db_path / f"{db_name}.sqlite",
        db_path / "sqlite" / f"{db_name}.sqlite",
        db_path / f"{db_name}.db",
    ]

    for path in possible_paths:
        if path.exists():
            return path

    # Try finding any .sqlite file
    sqlite_files = list(db_path.glob("*.sqlite"))
    if sqlite_files:
        return sqlite_files[0]

    return None


def load_databases_to_motherduck(
    sqlite_dir: str = "./mini_dev_data/MINIDEV/dev_databases",
    motherduck_db: str = "bird_bench",
    databases: list[str] | None = None
) -> dict[str, int]:
    """
    Load SQLite databases into MotherDuck.

    Args:
        sqlite_dir: Directory containing BIRD SQLite databases
        motherduck_db: Name of the MotherDuck database to create
        databases: Optional list of specific databases to load

    Returns:
        Dictionary mapping database names to table counts
    """
    token = os.environ.get("MOTHERDUCK_TOKEN")
    if not token:
        raise ValueError(
            "MOTHERDUCK_TOKEN environment variable not set. "
            "Get your token from https://motherduck.com/"
        )

    dbs_to_load = databases or BIRD_DATABASES
    sqlite_base = Path(sqlite_dir)

    if not sqlite_base.exists():
        raise FileNotFoundError(
            f"SQLite directory not found: {sqlite_base}\n"
            f"Please download BIRD databases from:\n"
            f"https://drive.google.com/file/d/13VLWIwpw5E3d5DUkMvzw7hvHE67a4XkG/view"
        )

    # First connect to MotherDuck and create database if needed
    print(f"Connecting to MotherDuck...")
    md = duckdb.connect(f"md:?motherduck_token={token}")
    md.execute(f"CREATE DATABASE IF NOT EXISTS {motherduck_db}")
    md.close()

    # Now connect to the specific database
    print(f"Using database: {motherduck_db}")
    md = duckdb.connect(f"md:{motherduck_db}?motherduck_token={token}")

    results = {}

    for db_name in dbs_to_load:
        db_path = sqlite_base / db_name

        if not db_path.exists():
            print(f"  [SKIP] {db_name}: directory not found")
            continue

        sqlite_path = find_sqlite_file(db_path, db_name)
        if not sqlite_path:
            print(f"  [SKIP] {db_name}: no SQLite file found")
            continue

        print(f"Loading {db_name}...")

        try:
            # Create schema for this database
            md.execute(f"CREATE SCHEMA IF NOT EXISTS {db_name}")

            # Attach SQLite database
            md.execute(f"ATTACH '{sqlite_path}' AS src (TYPE sqlite)")

            # Get list of tables using DuckDB's introspection
            tables = md.execute(
                "SELECT table_name FROM information_schema.tables "
                "WHERE table_catalog = 'src' AND table_type = 'BASE TABLE'"
            ).fetchall()

            # Copy each table
            for (table_name,) in tables:
                # Handle reserved keywords and special characters
                safe_table = f'"{table_name}"' if not table_name.isidentifier() else table_name
                md.execute(
                    f"CREATE OR REPLACE TABLE {db_name}.{safe_table} "
                    f"AS SELECT * FROM src.{safe_table}"
                )

            # Detach source
            md.execute("DETACH src")

            results[db_name] = len(tables)
            print(f"  [OK] {db_name}: {len(tables)} tables loaded")

        except Exception as e:
            print(f"  [ERROR] {db_name}: {e}")
            try:
                md.execute("DETACH src")
            except duckdb.Error:
                pass  # Database may not be attached

    md.close()

    print(f"\nLoaded {len(results)} databases with {sum(results.values())} total tables")
    return results


def verify_motherduck_data(motherduck_db: str = "bird_bench") -> dict[str, list[str]]:
    """Verify data loaded into MotherDuck."""
    token = os.environ.get("MOTHERDUCK_TOKEN")
    if not token:
        raise ValueError("MOTHERDUCK_TOKEN not set")

    md = duckdb.connect(f"md:{motherduck_db}?motherduck_token={token}")

    # Get all schemas
    schemas = md.execute(
        "SELECT schema_name FROM information_schema.schemata "
        "WHERE schema_name NOT IN ('information_schema', 'pg_catalog', 'main')"
    ).fetchall()

    results = {}
    for (schema,) in schemas:
        tables = md.execute(
            f"SELECT table_name FROM information_schema.tables "
            f"WHERE table_schema = '{schema}'"
        ).fetchall()
        results[schema] = [t[0] for t in tables]

    md.close()

    print("MotherDuck database contents:")
    for schema, tables in sorted(results.items()):
        print(f"\n{schema}:")
        for table in sorted(tables):
            print(f"  - {table}")

    return results


if __name__ == "__main__":
    import sys
    from dotenv import load_dotenv

    load_dotenv()

    if len(sys.argv) > 1 and sys.argv[1] == "--verify":
        verify_motherduck_data()
    else:
        load_databases_to_motherduck()
