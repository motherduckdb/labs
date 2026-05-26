"""
Schema information extraction for BIRD-Bench evaluation.

Provides schema information to models for text-to-SQL generation.
Uses MotherDuck MCP for all database operations.
"""

import json
import os
from functools import lru_cache
from pathlib import Path

from src.mcp_client import MotherDuckMCPClient
from src.constants import DEV_TABLES_FILE, MOTHERDUCK_DATABASE


# Global MCP client for schema operations
_mcp_client: MotherDuckMCPClient | None = None


def get_mcp_client() -> MotherDuckMCPClient:
    """Get or create the global MCP client."""
    global _mcp_client
    if _mcp_client is None:
        token = os.environ.get("MOTHERDUCK_TOKEN")
        if not token:
            raise ValueError("MOTHERDUCK_TOKEN not set")
        _mcp_client = MotherDuckMCPClient(token)
        _mcp_client.initialize()
    return _mcp_client


@lru_cache(maxsize=32)
def get_schema_info(db_id: str, motherduck_db: str = "bird_bench") -> str:
    """
    Get formatted schema information for a database schema.

    Args:
        db_id: The schema name (e.g., 'california_schools')
        motherduck_db: The MotherDuck database name

    Returns:
        Formatted string containing table and column information
    """
    mcp = get_mcp_client()

    # Get tables in the schema
    tables_result = mcp.list_tables(motherduck_db, db_id)

    if not tables_result.success:
        return f"Error getting schema info: {tables_result.error}"

    try:
        tables_data = json.loads(tables_result.content)
    except json.JSONDecodeError:
        return f"Could not parse tables response: {tables_result.content[:200]}"

    tables = tables_data.get("tables", [])

    if not tables:
        return f"No tables found in schema: {db_id}"

    lines = [
        f"Database: {motherduck_db}",
        f"Schema: {db_id}",
        "=" * 50,
        ""
    ]

    for table_info in tables:
        table_name = table_info.get("name", table_info) if isinstance(table_info, dict) else table_info

        lines.append(f"TABLE: {db_id}.{table_name}")
        lines.append("-" * 40)

        # Get columns for this table
        cols_result = mcp.list_columns(motherduck_db, table_name, db_id)

        if cols_result.success:
            try:
                cols_data = json.loads(cols_result.content)
                columns = cols_data.get("columns", [])

                for col in columns:
                    if isinstance(col, dict):
                        col_name = col.get("name", "")
                        col_type = col.get("type", "")
                        nullable = col.get("nullable", True)
                        null_str = "" if nullable else " NOT NULL"
                        lines.append(f"  {col_name}: {col_type}{null_str}")
                    else:
                        lines.append(f"  {col}")

            except json.JSONDecodeError:
                lines.append(f"  (could not parse columns)")

        lines.append("")

    return "\n".join(lines)


def get_schema_info_compact(db_id: str, motherduck_db: str = "bird_bench") -> str:
    """
    Get compact schema information (no samples).

    Useful for shorter prompts.
    """
    mcp = get_mcp_client()

    tables_result = mcp.list_tables(motherduck_db, db_id)

    if not tables_result.success:
        return f"Error: {tables_result.error}"

    try:
        tables_data = json.loads(tables_result.content)
    except json.JSONDecodeError:
        return f"Parse error"

    tables = tables_data.get("tables", [])

    if not tables:
        return f"No tables found in schema: {db_id}"

    lines = [f"Schema: {db_id}", ""]

    for table_info in tables:
        table_name = table_info.get("name", table_info) if isinstance(table_info, dict) else table_info

        cols_result = mcp.list_columns(motherduck_db, table_name, db_id)

        if cols_result.success:
            try:
                cols_data = json.loads(cols_result.content)
                columns = cols_data.get("columns", [])

                col_strs = []
                for col in columns:
                    if isinstance(col, dict):
                        col_strs.append(f"{col.get('name')} ({col.get('type')})")
                    else:
                        col_strs.append(str(col))

                lines.append(f"{table_name}: {', '.join(col_strs)}")
            except json.JSONDecodeError:
                lines.append(f"{table_name}: (error)")
        else:
            lines.append(f"{table_name}: (error)")

    return "\n".join(lines)


def list_available_schemas(motherduck_db: str = "bird_bench") -> list[str]:
    """List all available schemas in the MotherDuck database."""
    mcp = get_mcp_client()

    # Query to get schemas
    result = mcp.query(
        f"SELECT DISTINCT table_schema FROM information_schema.tables "
        f"WHERE table_catalog = '{motherduck_db}' "
        f"AND table_schema NOT IN ('information_schema', 'pg_catalog', 'main')",
        motherduck_db
    )

    if not result.success:
        return []

    try:
        data = json.loads(result.content)
        rows = data.get("rows", [])
        return [row[0] for row in rows]
    except (json.JSONDecodeError, IndexError):
        return []


@lru_cache(maxsize=1)
def _load_dev_tables() -> list[dict]:
    """Load dev_tables.json metadata."""
    if not DEV_TABLES_FILE.exists():
        return []
    with open(DEV_TABLES_FILE) as f:
        return json.load(f)


def get_table_metadata(db_id: str) -> dict:
    """
    Get FK/PK metadata from dev_tables.json.

    Returns:
        dict with keys:
            - foreign_keys: list of (from_col_idx, to_col_idx) tuples
            - primary_keys: list of column indices
            - column_names: list of [table_idx, col_name] pairs
            - table_names: list of table names
    """
    dev_tables = _load_dev_tables()
    for db in dev_tables:
        if db.get("db_id") == db_id:
            return {
                "foreign_keys": db.get("foreign_keys", []),
                "primary_keys": db.get("primary_keys", []),
                "column_names": db.get("column_names_original", []),
                "table_names": db.get("table_names_original", []),
            }
    return {"foreign_keys": [], "primary_keys": [], "column_names": [], "table_names": []}


def format_foreign_keys(db_id: str) -> str:
    """
    Format FK relationships as human-readable text.

    Returns:
        String like:
        FOREIGN KEY RELATIONSHIPS:
        - transactions.CustomerID → customers.CustomerID
    """
    meta = get_table_metadata(db_id)
    if not meta["foreign_keys"]:
        return ""

    col_names = meta["column_names"]
    table_names = meta["table_names"]

    def get_col_info(col_idx: int) -> tuple[str, str]:
        """Get (table_name, column_name) for a column index."""
        if col_idx < 0 or col_idx >= len(col_names):
            return ("?", "?")
        table_idx, col_name = col_names[col_idx]
        if table_idx < 0 or table_idx >= len(table_names):
            return ("?", col_name)
        return (table_names[table_idx], col_name)

    lines = ["FOREIGN KEY RELATIONSHIPS:"]
    for from_idx, to_idx in meta["foreign_keys"]:
        from_table, from_col = get_col_info(from_idx)
        to_table, to_col = get_col_info(to_idx)
        lines.append(f"  {from_table}.{from_col} → {to_table}.{to_col}")

    return "\n".join(lines)


def get_sample_rows(db_id: str, table_name: str, limit: int = 3, motherduck_db: str = "bird_bench") -> list[dict]:
    """
    Get sample rows from a table via MCP query.

    Returns:
        List of row dictionaries, or empty list on error.
    """
    mcp = get_mcp_client()
    sql = f"SELECT * FROM {motherduck_db}.{db_id}.{table_name} LIMIT {limit}"
    result = mcp.query(sql, motherduck_db)

    if not result.success:
        return []

    try:
        data = json.loads(result.content)
        rows = data.get("rows", [])
        columns = data.get("columns", [])
        # Convert to list of dicts
        return [dict(zip(columns, row)) for row in rows]
    except (json.JSONDecodeError, KeyError):
        return []


def format_sample_rows(rows: list[dict], max_col_width: int = 20) -> str:
    """
    Format sample rows as a markdown table.

    Args:
        rows: List of row dictionaries
        max_col_width: Max width per column (truncates with ...)

    Returns:
        Markdown table string
    """
    if not rows:
        return ""

    columns = list(rows[0].keys())

    def truncate(val: str, width: int) -> str:
        s = str(val) if val is not None else "NULL"
        return s[:width-3] + "..." if len(s) > width else s

    # Header
    header = "| " + " | ".join(truncate(c, max_col_width) for c in columns) + " |"
    separator = "| " + " | ".join("-" * min(len(c), max_col_width) for c in columns) + " |"

    # Rows
    row_lines = []
    for row in rows:
        vals = [truncate(row.get(c), max_col_width) for c in columns]
        row_lines.append("| " + " | ".join(vals) + " |")

    return "\n".join([header, separator] + row_lines)


def get_schema_info_enhanced(db_id: str, motherduck_db: str = "bird_bench",
                              include_samples: bool = True, sample_limit: int = 3,
                              include_fk: bool = True) -> str:
    """
    Get enhanced schema information with sample rows and FK relationships.

    Args:
        db_id: The schema name (e.g., 'california_schools')
        motherduck_db: The MotherDuck database name
        include_samples: Whether to include sample rows
        sample_limit: Number of sample rows per table
        include_fk: Whether to include FK relationships

    Returns:
        Formatted string containing table, column, sample, and FK information
    """
    mcp = get_mcp_client()

    # Get tables in the schema
    tables_result = mcp.list_tables(motherduck_db, db_id)

    if not tables_result.success:
        return f"Error getting schema info: {tables_result.error}"

    try:
        tables_data = json.loads(tables_result.content)
    except json.JSONDecodeError:
        return f"Could not parse tables response: {tables_result.content[:200]}"

    tables = tables_data.get("tables", [])

    if not tables:
        return f"No tables found in schema: {db_id}"

    lines = [
        f"Database: {motherduck_db}",
        f"Schema: {db_id}",
        "=" * 50,
        ""
    ]

    # Add FK relationships at the top if available
    if include_fk:
        fk_info = format_foreign_keys(db_id)
        if fk_info:
            lines.append(fk_info)
            lines.append("")

    for table_info in tables:
        table_name = table_info.get("name", table_info) if isinstance(table_info, dict) else table_info

        lines.append(f"TABLE: {db_id}.{table_name}")
        lines.append("-" * 40)

        # Get columns for this table
        cols_result = mcp.list_columns(motherduck_db, table_name, db_id)

        if cols_result.success:
            try:
                cols_data = json.loads(cols_result.content)
                columns = cols_data.get("columns", [])

                for col in columns:
                    if isinstance(col, dict):
                        col_name = col.get("name", "")
                        col_type = col.get("type", "")
                        nullable = col.get("nullable", True)
                        null_str = "" if nullable else " NOT NULL"
                        lines.append(f"  {col_name}: {col_type}{null_str}")
                    else:
                        lines.append(f"  {col}")

            except json.JSONDecodeError:
                lines.append("  (could not parse columns)")

        # Add sample rows
        if include_samples:
            sample_rows = get_sample_rows(db_id, table_name, sample_limit, motherduck_db)
            if sample_rows:
                lines.append("")
                lines.append("Sample rows:")
                lines.append(format_sample_rows(sample_rows))

        lines.append("")

    return "\n".join(lines)


def get_tables_for_linking(db_id: str, motherduck_db: str = "bird_bench") -> list[dict]:
    """
    Get table information structured for schema linking.

    Returns:
        List of dicts with 'name' and 'columns' keys for each table.
    """
    mcp = get_mcp_client()

    tables_result = mcp.list_tables(motherduck_db, db_id)
    if not tables_result.success:
        return []

    try:
        tables_data = json.loads(tables_result.content)
    except json.JSONDecodeError:
        return []

    tables = tables_data.get("tables", [])
    result = []

    for table_info in tables:
        table_name = table_info.get("name", table_info) if isinstance(table_info, dict) else table_info

        cols_result = mcp.list_columns(motherduck_db, table_name, db_id)
        columns = []

        if cols_result.success:
            try:
                cols_data = json.loads(cols_result.content)
                for col in cols_data.get("columns", []):
                    if isinstance(col, dict):
                        columns.append(col.get("name", ""))
                    else:
                        columns.append(str(col))
            except json.JSONDecodeError:
                pass

        result.append({"name": table_name, "columns": columns})

    return result


def get_linked_schema(db_id: str, relevant_tables: list[str],
                      motherduck_db: str = "bird_bench",
                      include_samples: bool = True, sample_limit: int = 3,
                      include_fk: bool = True) -> str:
    """
    Get schema information filtered to only relevant tables.

    Args:
        db_id: The schema name
        relevant_tables: List of table names to include
        motherduck_db: The MotherDuck database name
        include_samples: Whether to include sample rows
        sample_limit: Number of sample rows per table
        include_fk: Whether to include FK relationships

    Returns:
        Formatted string containing filtered schema information
    """
    mcp = get_mcp_client()

    lines = [
        f"Database: {motherduck_db}",
        f"Schema: {db_id}",
        f"(Showing {len(relevant_tables)} most relevant tables)",
        "=" * 50,
        ""
    ]

    # Add FK relationships (filtered to relevant tables)
    if include_fk:
        meta = get_table_metadata(db_id)
        if meta["foreign_keys"]:
            col_names = meta["column_names"]
            table_names = meta["table_names"]
            relevant_set = set(relevant_tables)

            fk_lines = ["FOREIGN KEY RELATIONSHIPS:"]
            for from_idx, to_idx in meta["foreign_keys"]:
                if from_idx >= len(col_names) or to_idx >= len(col_names):
                    continue
                from_table_idx = col_names[from_idx][0]
                to_table_idx = col_names[to_idx][0]
                if from_table_idx >= len(table_names) or to_table_idx >= len(table_names):
                    continue
                from_table = table_names[from_table_idx]
                to_table = table_names[to_table_idx]
                # Only include if at least one table is relevant
                if from_table in relevant_set or to_table in relevant_set:
                    from_col = col_names[from_idx][1]
                    to_col = col_names[to_idx][1]
                    fk_lines.append(f"  {from_table}.{from_col} → {to_table}.{to_col}")

            if len(fk_lines) > 1:
                lines.extend(fk_lines)
                lines.append("")

    for table_name in relevant_tables:
        lines.append(f"TABLE: {db_id}.{table_name}")
        lines.append("-" * 40)

        cols_result = mcp.list_columns(motherduck_db, table_name, db_id)

        if cols_result.success:
            try:
                cols_data = json.loads(cols_result.content)
                columns = cols_data.get("columns", [])

                for col in columns:
                    if isinstance(col, dict):
                        col_name = col.get("name", "")
                        col_type = col.get("type", "")
                        nullable = col.get("nullable", True)
                        null_str = "" if nullable else " NOT NULL"
                        lines.append(f"  {col_name}: {col_type}{null_str}")
                    else:
                        lines.append(f"  {col}")

            except json.JSONDecodeError:
                lines.append("  (could not parse columns)")

        if include_samples:
            sample_rows = get_sample_rows(db_id, table_name, sample_limit, motherduck_db)
            if sample_rows:
                lines.append("")
                lines.append("Sample rows:")
                lines.append(format_sample_rows(sample_rows))

        lines.append("")

    return "\n".join(lines)


def clear_schema_caches():
    """
    Clear all schema-related caches.

    Call this when database content has been updated and cached
    schema information may be stale.
    """
    get_schema_info.cache_clear()
    _load_dev_tables.cache_clear()


if __name__ == "__main__":
    from dotenv import load_dotenv
    load_dotenv()

    schemas = list_available_schemas()
    print(f"Available schemas: {schemas}")

    if schemas:
        print(f"\nSchema info for {schemas[0]}:")
        print(get_schema_info(schemas[0]))

        print(f"\n\nEnhanced schema info for {schemas[0]}:")
        print(get_schema_info_enhanced(schemas[0]))
