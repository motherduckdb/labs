"""
Database setup for BIRD-Bench evaluation.

Creates and configures the three MotherDuck databases for evaluation:
- bird_bench_baseline: No comments
- bird_bench_comments: Profile-based comments
- bird_bench_full: Comments (initially same as comments, later enriched with history)
"""

import os
import subprocess
from pathlib import Path

import duckdb

from eval.config import DATABASE_CONFIGS, ConfigType, DatabaseConfig


# BIRD databases to load
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


def get_motherduck_connection(database: str | None = None) -> duckdb.DuckDBPyConnection:
    """
    Get a connection to MotherDuck.

    Args:
        database: Specific database to connect to, or None for root

    Returns:
        DuckDB connection to MotherDuck
    """
    token = os.environ.get("MOTHERDUCK_TOKEN")
    if not token:
        raise ValueError(
            "MOTHERDUCK_TOKEN environment variable not set. "
            "Get your token from https://motherduck.com/"
        )

    if database:
        return duckdb.connect(f"md:{database}?motherduck_token={token}")
    else:
        return duckdb.connect(f"md:?motherduck_token={token}")


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


def create_database(database_name: str, drop_if_exists: bool = False) -> None:
    """
    Create a MotherDuck database.

    Args:
        database_name: Name of the database to create
        drop_if_exists: If True, drop existing database first
    """
    md = get_motherduck_connection()

    if drop_if_exists:
        print(f"Dropping database if exists: {database_name}")
        md.execute(f"DROP DATABASE IF EXISTS {database_name}")

    print(f"Creating database: {database_name}")
    md.execute(f"CREATE DATABASE IF NOT EXISTS {database_name}")
    md.close()


def load_sqlite_databases(
    motherduck_db: str,
    sqlite_dir: str = "./mini_dev_data/MINIDEV/dev_databases",
    databases: list[str] | None = None,
) -> dict[str, int]:
    """
    Load SQLite databases into a MotherDuck database.

    Args:
        motherduck_db: Target MotherDuck database name
        sqlite_dir: Directory containing BIRD SQLite databases
        databases: Optional list of specific databases to load

    Returns:
        Dictionary mapping database names to table counts
    """
    dbs_to_load = databases or BIRD_DATABASES
    sqlite_base = Path(sqlite_dir)

    if not sqlite_base.exists():
        raise FileNotFoundError(
            f"SQLite directory not found: {sqlite_base}\n"
            "Please download BIRD databases from:\n"
            "https://drive.google.com/file/d/13VLWIwpw5E3d5DUkMvzw7hvHE67a4XkG/view"
        )

    md = get_motherduck_connection(motherduck_db)
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

        print(f"  Loading {db_name}...")

        try:
            # Create schema for this database
            md.execute(f"CREATE SCHEMA IF NOT EXISTS {db_name}")

            # Attach SQLite database
            md.execute(f"ATTACH '{sqlite_path}' AS src (TYPE sqlite)")

            # Get list of tables
            tables = md.execute(
                "SELECT table_name FROM information_schema.tables "
                "WHERE table_catalog = 'src' AND table_type = 'BASE TABLE'"
            ).fetchall()

            # Copy each table
            for (table_name,) in tables:
                safe_table = f'"{table_name}"' if not table_name.isidentifier() else table_name
                md.execute(
                    f"CREATE OR REPLACE TABLE {db_name}.{safe_table} "
                    f"AS SELECT * FROM src.{safe_table}"
                )

            # Detach source
            md.execute("DETACH src")

            results[db_name] = len(tables)
            print(f"    [OK] {len(tables)} tables loaded")

        except Exception as e:
            print(f"    [ERROR] {e}")
            try:
                md.execute("DETACH src")
            except Exception:
                pass

    md.close()
    return results


def strip_all_comments(motherduck_db: str) -> None:
    """
    Remove all comments from tables and columns in a MotherDuck database.

    Only strips comments that actually exist, for better performance.

    Args:
        motherduck_db: Target database name
    """
    print(f"Stripping comments from {motherduck_db}...")
    md = get_motherduck_connection(motherduck_db)

    # Find tables with comments using duckdb_tables()
    tables_with_comments = md.execute(f"""
        SELECT schema_name, table_name
        FROM duckdb_tables()
        WHERE database_name = '{motherduck_db}'
        AND comment IS NOT NULL
        AND schema_name NOT IN ('information_schema', 'pg_catalog', 'main')
    """).fetchall()

    # Find columns with comments using duckdb_columns()
    columns_with_comments = md.execute(f"""
        SELECT schema_name, table_name, column_name
        FROM duckdb_columns()
        WHERE database_name = '{motherduck_db}'
        AND comment IS NOT NULL
        AND schema_name NOT IN ('information_schema', 'pg_catalog', 'main')
    """).fetchall()

    print(f"  Found {len(tables_with_comments)} tables and {len(columns_with_comments)} columns with comments")

    # Strip table comments
    for schema, table in tables_with_comments:
        try:
            md.execute(f'COMMENT ON TABLE "{schema}"."{table}" IS NULL')
        except Exception:
            pass

    # Strip column comments
    for schema, table, column in columns_with_comments:
        try:
            md.execute(f'COMMENT ON COLUMN "{schema}"."{table}"."{column}" IS NULL')
        except Exception:
            pass

    md.close()
    print(f"  Done stripping comments from {motherduck_db}")


def generate_profile_comments(motherduck_db: str, schemas: list[str] | None = None) -> None:
    """
    Generate profile-based comments using metadata_generator.

    Args:
        motherduck_db: Target database name
        schemas: Optional list of schemas to process (default: all BIRD databases)
    """
    schemas_to_process = schemas or BIRD_DATABASES

    print(f"Generating profile-based comments for {motherduck_db}...")

    for schema in schemas_to_process:
        print(f"  Processing {schema}...")
        try:
            # Run metadata-generator generate command (profile + describe + sql + execute)
            result = subprocess.run(
                [
                    "uv", "run", "metadata-generator", "generate", schema,
                    "--database", motherduck_db,
                    "--execute",  # Apply comments to database
                ],
                capture_output=True,
                text=True,
                cwd=Path.home() / "code" / "metadata_generator",
            )

            if result.returncode != 0:
                print(f"    [ERROR] {result.stderr[:200]}")
            else:
                print(f"    [OK] Comments generated and applied")

        except Exception as e:
            print(f"    [ERROR] {e}")


def setup_database_config(
    config: DatabaseConfig,
    drop_if_exists: bool = False,
    skip_load: bool = False,
) -> None:
    """
    Set up a single database configuration.

    This only loads the SQLite data into MotherDuck. For adding comments,
    use metadata_generator separately:

        cd ~/code/metadata_generator
        uv run metadata-generator generate <schema> -d <database>

    Args:
        config: DatabaseConfig specifying the setup
        drop_if_exists: Whether to drop existing database
        skip_load: Whether to skip loading SQLite databases
    """
    print(f"\n{'='*60}")
    print(f"Setting up: {config.display_name}")
    print(f"Database: {config.database_name}")
    print(f"{'='*60}")

    # Create database
    create_database(config.database_name, drop_if_exists=drop_if_exists)

    # Load SQLite databases
    if not skip_load:
        print(f"\nLoading BIRD databases into {config.database_name}...")
        results = load_sqlite_databases(config.database_name)
        print(f"Loaded {len(results)} databases with {sum(results.values())} total tables")

    # Strip comments for baseline config
    if not config.has_comments:
        strip_all_comments(config.database_name)

    print(f"\n[DONE] {config.display_name} setup complete")

    if config.has_comments:
        print(f"\nNext: Add comments using metadata_generator:")
        print(f"  cd ~/code/metadata_generator")
        print(f"  uv run metadata-generator generate <schema> -d {config.database_name}")


def setup_all_databases(drop_if_exists: bool = False) -> None:
    """
    Set up all three database configurations for evaluation.

    Args:
        drop_if_exists: Whether to drop existing databases
    """
    print("=" * 60)
    print("BIRD-Bench Evaluation Database Setup")
    print("=" * 60)

    for config_type in ConfigType:
        config = DATABASE_CONFIGS[config_type]
        setup_database_config(config, drop_if_exists=drop_if_exists)

    print("\n" + "=" * 60)
    print("All database configurations set up successfully!")
    print("=" * 60)
    print("\nDatabases created:")
    for config_type in ConfigType:
        config = DATABASE_CONFIGS[config_type]
        print(f"  - {config.database_name}: {config.display_name}")


def count_comments(database_name: str, min_length: int = 10) -> dict[str, int]:
    """
    Count table and column comments in a MotherDuck database.

    Args:
        database_name: Database to check
        min_length: Minimum comment length to count (default 10)

    Returns:
        Dictionary with 'table_comments' and 'column_comments' counts
    """
    md = get_motherduck_connection(database_name)

    # Count table comments (non-null, non-empty, minimum length)
    # Must filter by database_name since duckdb_tables() returns ALL databases
    table_comments = md.execute(f"""
        SELECT COUNT(*) FROM duckdb_tables()
        WHERE database_name = '{database_name}'
        AND comment IS NOT NULL
        AND length(comment) >= {min_length}
        AND schema_name NOT IN ('information_schema', 'pg_catalog', 'main')
    """).fetchone()[0]

    # Count column comments (non-null, non-empty, minimum length)
    # Must filter by database_name since duckdb_columns() returns ALL databases
    column_comments = md.execute(f"""
        SELECT COUNT(*) FROM duckdb_columns()
        WHERE database_name = '{database_name}'
        AND comment IS NOT NULL
        AND length(comment) >= {min_length}
        AND schema_name NOT IN ('information_schema', 'pg_catalog', 'main')
    """).fetchone()[0]

    md.close()

    return {
        "table_comments": table_comments,
        "column_comments": column_comments,
        "total_comments": table_comments + column_comments,
    }


def verify_database(database_name: str) -> dict[str, list[str]]:
    """
    Verify contents of a MotherDuck database.

    Args:
        database_name: Database to verify

    Returns:
        Dictionary mapping schema names to list of table names
    """
    md = get_motherduck_connection(database_name)

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
    return results


def print_database_summary(database_name: str, expected_comments: bool | None = None) -> None:
    """Print a summary of a database's contents including comment counts."""
    contents = verify_database(database_name)

    # Count comments (None indicates error)
    total_comments: int | None = None
    table_comments = 0
    column_comments = 0
    try:
        comment_counts = count_comments(database_name)
        total_comments = comment_counts["total_comments"]
        table_comments = comment_counts["table_comments"]
        column_comments = comment_counts["column_comments"]
    except Exception as e:
        print(f"  (Warning: Could not count comments: {e})")

    print(f"\n{database_name}:")
    print("-" * 50)
    total_tables = 0
    for schema, tables in sorted(contents.items()):
        print(f"  {schema}: {len(tables)} tables")
        total_tables += len(tables)
    print("-" * 50)
    print(f"  Schemas: {len(contents)}")
    print(f"  Tables:  {total_tables}")

    # Show comment status
    if total_comments is not None:
        status = ""
        if expected_comments is True and total_comments > 0:
            status = " ✓"
        elif expected_comments is False and total_comments == 0:
            status = " ✓"
        elif expected_comments is True and total_comments == 0:
            status = " ✗ (expected comments)"
        elif expected_comments is False and total_comments > 0:
            status = " ✗ (expected none)"

        print(f"  Comments: {total_comments} ({table_comments} tables, {column_comments} columns){status}")


if __name__ == "__main__":
    import sys
    from dotenv import load_dotenv

    load_dotenv()

    if len(sys.argv) > 1:
        cmd = sys.argv[1]

        if cmd == "--verify":
            # Verify all eval databases
            for config_type in ConfigType:
                config = DATABASE_CONFIGS[config_type]
                print_database_summary(config.database_name)

        elif cmd == "--setup":
            # Full setup with optional --drop flag
            drop = "--drop" in sys.argv
            setup_all_databases(drop_if_exists=drop)

        elif cmd == "--baseline":
            config = DATABASE_CONFIGS[ConfigType.BASELINE]
            setup_database_config(config, drop_if_exists="--drop" in sys.argv)

        elif cmd == "--comments":
            config = DATABASE_CONFIGS[ConfigType.COMMENTS]
            setup_database_config(config, drop_if_exists="--drop" in sys.argv)

        elif cmd == "--full":
            config = DATABASE_CONFIGS[ConfigType.FULL]
            setup_database_config(config, drop_if_exists="--drop" in sys.argv)

        else:
            print("Usage: uv run python -m eval.database_setup [--setup|--verify|--baseline|--comments|--full] [--drop]")

    else:
        print("Usage: uv run python -m eval.database_setup [--setup|--verify|--baseline|--comments|--full] [--drop]")
        print("\nCommands:")
        print("  --setup     Set up all three database configurations")
        print("  --verify    Verify contents of all eval databases")
        print("  --baseline  Set up only baseline (no comments) database")
        print("  --comments  Set up only comments database")
        print("  --full      Set up only full (comments + history) database")
        print("\nFlags:")
        print("  --drop      Drop existing databases before setup")
