# Agent notes for this workshop folder

- Query `data/workshop.duckdb` and the public Iceberg tables through the `duckdb` MCP tools.
- If you need the DuckDB CLI, run `uvx --from duckdb-cli==1.5.6 duckdb ...`, not a bare `duckdb`.
  Another DuckDB may be first on PATH, and a DuckDB 2.0 CLI writes files the 1.5.6 MCP server
  can't open.
- Don't write to `data/workshop.duckdb` while the MCP server is running; the server opens it
  read-only and a read-write session locks it.
- For Python, use this folder's `.venv`: `uv run --python .venv python ...`.
