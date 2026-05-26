"""
SQL execution utilities for BIRD-Bench evaluation.

Provides functions for executing SQL queries via MotherDuck MCP
with support for both DuckDB-native and SQLite-dialect SQL.
"""

import json
from typing import Union

from src.mcp_client import MotherDuckMCPClient
from src.sql_utils import sqlite_to_duckdb, qualify_tables
from src.constants import MOTHERDUCK_DATABASE


def execute_sql(
    sql: str,
    schema: str,
    mcp_client: MotherDuckMCPClient,
    translate_from_sqlite: bool = False,
    database: str = MOTHERDUCK_DATABASE,
) -> tuple[list | None, str | None]:
    """
    Execute SQL via MCP and return results.

    Args:
        sql: SQL query to execute
        schema: Database schema (db_id) for table qualification
        mcp_client: MCP client instance
        translate_from_sqlite: If True, translate SQLite SQL to DuckDB.
                              If False, just qualify table names.
        database: MotherDuck database name

    Returns:
        (results, error) tuple where:
        - results is a list of tuples if successful, None on error
        - error is an error message string if failed, None on success
    """
    try:
        # Apply appropriate SQL transformation
        if translate_from_sqlite:
            processed_sql = sqlite_to_duckdb(sql, schema=schema)
        else:
            processed_sql = qualify_tables(sql, schema)

        # Execute via MCP
        result = mcp_client.query(processed_sql, database)

        if not result.success:
            return None, result.error

        # Parse the JSON response
        try:
            data = json.loads(result.content)
            if data.get("success", True):
                rows = data.get("rows", [])
                return [tuple(row) for row in rows], None
            else:
                return None, data.get("error", "Unknown error")
        except json.JSONDecodeError:
            return None, f"Could not parse response: {result.content[:200]}"

    except Exception as e:
        return None, str(e)


def execute_sql_returning_error_string(
    sql: str,
    schema: str,
    mcp_client: MotherDuckMCPClient,
    translate_from_sqlite: bool = False,
    database: str = MOTHERDUCK_DATABASE,
) -> list | str:
    """
    Execute SQL via MCP, returning error as string prefix.

    This is a convenience wrapper around execute_sql() that returns
    errors as "ERROR: <message>" strings instead of a tuple.
    Used by evaluator and optimizer for compatibility.

    Args:
        sql: SQL query to execute
        schema: Database schema (db_id) for table qualification
        mcp_client: MCP client instance
        translate_from_sqlite: If True, translate SQLite SQL to DuckDB.
                              If False, just qualify table names.
        database: MotherDuck database name

    Returns:
        List of tuples on success, "ERROR: <message>" string on failure
    """
    results, error = execute_sql(
        sql=sql,
        schema=schema,
        mcp_client=mcp_client,
        translate_from_sqlite=translate_from_sqlite,
        database=database,
    )

    if error:
        return f"ERROR: {error}"
    return results
