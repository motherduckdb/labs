"""One DuckDB reader for any controllog source.

``connect(source)`` returns an in-memory DuckDB connection exposing two temp views,
``events`` and ``postings``, with the schema fixed by ``projects/controllog`` (spec
§ 10.1). Every downstream query is source-agnostic:

- JSONL  — ``connect("logs/")`` or ``connect("logs/**")`` or a direct
  ``.../events.jsonl`` path. Directories/globs resolve recursively to
  ``**/events.jsonl`` and ``**/postings.jsonl``.
- MotherDuck — ``connect("md:my_db")`` (token from ``MOTHERDUCK_TOKEN``).

Both branches normalize to identical column types — notably ``payload_json`` is cast
to ``JSON`` — so the renderers never branch on the source.
"""
from __future__ import annotations

import glob as _glob
from pathlib import Path

import duckdb

# Contract columns, normalized identically for both sources. ``payload_json``/``dims_json``
# are cast to JSON so a JSONL STRUCT and a MotherDuck JSON column render the same way.
_EVENT_SELECT = """
    CAST(event_id AS VARCHAR)                       AS event_id,
    CAST(event_time AS TIMESTAMP WITH TIME ZONE)    AS event_time,
    CAST(ingest_time AS TIMESTAMP WITH TIME ZONE)   AS ingest_time,
    CAST(kind AS VARCHAR)                           AS kind,
    CAST(project_id AS VARCHAR)                      AS project_id,
    CAST(source AS VARCHAR)                          AS source,
    CAST(idempotency_key AS VARCHAR)                 AS idempotency_key,
    CAST(payload_json AS JSON)                       AS payload_json,
    CAST(run_id AS VARCHAR)                          AS run_id,
    CAST(actor_agent_id AS VARCHAR)                  AS actor_agent_id,
    CAST(actor_task_id AS VARCHAR)                   AS actor_task_id
"""

_POSTING_SELECT = """
    CAST(posting_id AS VARCHAR)     AS posting_id,
    CAST(event_id AS VARCHAR)       AS event_id,
    CAST(account_type AS VARCHAR)   AS account_type,
    CAST(account_id AS VARCHAR)     AS account_id,
    CAST(unit AS VARCHAR)           AS unit,
    CAST(delta_numeric AS DOUBLE)   AS delta_numeric,
    CAST(dims_json AS JSON)         AS dims_json
"""

# Typed empty views used when a source has no postings (event-only runs still render).
_EMPTY_POSTINGS = """
    CAST(NULL AS VARCHAR) AS posting_id,
    CAST(NULL AS VARCHAR) AS event_id,
    CAST(NULL AS VARCHAR) AS account_type,
    CAST(NULL AS VARCHAR) AS account_id,
    CAST(NULL AS VARCHAR) AS unit,
    CAST(NULL AS DOUBLE)  AS delta_numeric,
    CAST(NULL AS JSON)    AS dims_json
"""


def connect(source: str) -> duckdb.DuckDBPyConnection:
    """Open an in-memory DuckDB connection with ``events``/``postings`` temp views.

    Args:
        source: ``md:<db>`` for MotherDuck, otherwise a JSONL file, directory, or glob.

    Raises:
        FileNotFoundError: a JSONL source matched no ``events.jsonl`` files.
    """
    con = duckdb.connect()
    if source.startswith("md:"):
        _attach_motherduck(con, source)
    else:
        _attach_jsonl(con, source)
    return con


def _md_db_name(source: str) -> str:
    """Extract the database name from an ``md:<db>[?params]`` source string."""
    name = source[len("md:") :]
    return name.split("?", 1)[0].strip("/")


def _attach_motherduck(con: duckdb.DuckDBPyConnection, source: str) -> None:
    db = _md_db_name(source)
    if not db:
        raise ValueError(f"MotherDuck source must name a database, e.g. 'md:my_db' (got {source!r})")
    con.execute(f"ATTACH '{source}'")
    con.execute(f"CREATE TEMP VIEW events AS SELECT {_EVENT_SELECT} FROM {db}.controllog.events")
    con.execute(f"CREATE TEMP VIEW postings AS SELECT {_POSTING_SELECT} FROM {db}.controllog.postings")


def _sql_str_list(paths: list[str]) -> str:
    """Render file paths as a DuckDB list literal, e.g. ``['a.jsonl', 'b.jsonl']``.

    DDL (``CREATE VIEW``) cannot use bound parameters, so the file list is inlined;
    single quotes in paths are escaped to keep it safe.
    """
    return "[" + ", ".join("'" + p.replace("'", "''") + "'" for p in paths) + "]"


def _resolve_globs(source: str) -> tuple[str, str]:
    """Map a JSONL file/dir/glob to (events_glob, postings_glob)."""
    s = source.rstrip("/")
    if s.endswith("events.jsonl"):
        return s, s[: -len("events.jsonl")] + "postings.jsonl"
    base = s[:-2].rstrip("/") if s.endswith("**") else s
    return f"{base}/**/events.jsonl", f"{base}/**/postings.jsonl"


def _attach_jsonl(con: duckdb.DuckDBPyConnection, source: str) -> None:
    events_glob, postings_glob = _resolve_globs(source)

    event_files = _glob.glob(events_glob, recursive=True)
    if not event_files:
        raise FileNotFoundError(
            f"No controllog events found for source {source!r} "
            f"(looked for {events_glob!r})"
        )
    con.execute(
        f"CREATE TEMP VIEW events AS SELECT {_EVENT_SELECT} "
        f"FROM read_json_auto({_sql_str_list(event_files)}, union_by_name=true)"
    )

    posting_files = _glob.glob(postings_glob, recursive=True)
    if posting_files:
        con.execute(
            f"CREATE TEMP VIEW postings AS SELECT {_POSTING_SELECT} "
            f"FROM read_json_auto({_sql_str_list(posting_files)}, union_by_name=true)"
        )
    else:
        con.execute(f"CREATE TEMP VIEW postings AS SELECT {_EMPTY_POSTINGS} WHERE 1=0")


def source_label(source: str) -> str:
    """Human-friendly label for display in page headers."""
    if source.startswith("md:"):
        return f"MotherDuck · {_md_db_name(source)}"
    return str(Path(source))
