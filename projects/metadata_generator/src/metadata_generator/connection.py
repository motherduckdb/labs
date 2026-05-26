"""
MotherDuck connection management.

Provides shared database connection infrastructure to eliminate
duplicated connection boilerplate across profiler and history modules.
"""

import os
from contextlib import contextmanager
from typing import Generator

import duckdb


class MotherDuckConnection:
    """
    Manages lazy connections to MotherDuck databases.

    Provides context manager support and connection pooling.
    """

    def __init__(
        self,
        database: str = "bird_bench",
        token: str | None = None,
    ):
        """
        Initialize connection manager.

        Args:
            database: MotherDuck database name
            token: MotherDuck API token. Falls back to MOTHERDUCK_TOKEN env var.

        Raises:
            ValueError: If no token is provided or found in environment
        """
        self.database = database
        self.token = token or os.environ.get("MOTHERDUCK_TOKEN")
        if not self.token:
            raise ValueError(
                "MOTHERDUCK_TOKEN not set. "
                "Provide token parameter or set MOTHERDUCK_TOKEN environment variable."
            )
        self._conn: duckdb.DuckDBPyConnection | None = None

    def __repr__(self) -> str:
        """Return a string representation that does not expose the token."""
        return f"MotherDuckConnection(database={self.database!r})"

    @property
    def conn(self) -> duckdb.DuckDBPyConnection:
        """Get or create database connection (lazy initialization)."""
        if self._conn is None:
            # Pass token via env var so it never appears in connection strings or tracebacks
            os.environ["MOTHERDUCK_TOKEN"] = self.token
            self._conn = duckdb.connect(f"md:{self.database}")
        return self._conn

    def close(self) -> None:
        """Close the connection if open."""
        if self._conn is not None:
            self._conn.close()
            self._conn = None

    def __enter__(self) -> "MotherDuckConnection":
        """Context manager entry."""
        return self

    def __exit__(self, exc_type, exc_val, exc_tb) -> None:
        """Context manager exit - ensures connection is closed."""
        self.close()


@contextmanager
def motherduck_connection(
    database: str = "bird_bench",
    token: str | None = None,
) -> Generator[duckdb.DuckDBPyConnection, None, None]:
    """
    Context manager for one-off database operations.

    Args:
        database: MotherDuck database name
        token: MotherDuck API token

    Yields:
        DuckDB connection

    Example:
        with motherduck_connection("bird_bench") as conn:
            result = conn.execute("SELECT 1").fetchone()
    """
    conn_manager = MotherDuckConnection(database, token)
    try:
        yield conn_manager.conn
    finally:
        conn_manager.close()
