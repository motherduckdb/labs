"""MotherDuck transport for controllog.

Uploads append-only JSONL into ``controllog.events`` and ``controllog.postings``
(default schema per spec v1.1 section 10.1). Idempotent on ``event_id`` and
``posting_id`` — re-running is safe.

Requires the ``[duckdb]`` extra::

    pip install "controllog[duckdb]"
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any

try:
    import duckdb
except ImportError as e:
    raise ImportError(
        "controllog.motherduck requires the [duckdb] extra. "
        "Install with: pip install 'controllog[duckdb]'"
    ) from e


def _connect(motherduck_db: str, motherduck_token: str | None) -> "duckdb.DuckDBPyConnection":
    token = motherduck_token or os.environ.get("MOTHERDUCK_TOKEN")
    if not token:
        raise ValueError("MOTHERDUCK_TOKEN not set")
    return duckdb.connect(f"md:{motherduck_db}?motherduck_token={token}")


def _iter_jsonl_files(log_dir: Path, name: str) -> list[Path]:
    """Find all ``{name}.jsonl`` files under date-partitioned controllog dirs.

    Looks under both ``log_dir/controllog/{name}.jsonl`` (legacy flat layout)
    and ``log_dir/controllog/YYYY-MM-DD/{name}.jsonl`` (current layout).
    """
    base = log_dir / "controllog"
    if not base.exists():
        return []
    files = []
    flat = base / f"{name}.jsonl"
    if flat.exists():
        files.append(flat)
    files.extend(sorted(base.glob(f"*/{name}.jsonl")))
    return files


def _ensure_schema(md: "duckdb.DuckDBPyConnection", schema: str) -> None:
    md.execute(f"CREATE SCHEMA IF NOT EXISTS {schema}")
    md.execute(f"""
        CREATE TABLE IF NOT EXISTS {schema}.events (
            event_id VARCHAR PRIMARY KEY,
            event_time TIMESTAMP WITH TIME ZONE,
            ingest_time TIMESTAMP WITH TIME ZONE,
            kind VARCHAR NOT NULL,
            project_id VARCHAR NOT NULL,
            source VARCHAR NOT NULL,
            idempotency_key VARCHAR NOT NULL,
            payload_json JSON,
            run_id VARCHAR,
            actor_agent_id VARCHAR,
            actor_task_id VARCHAR
        )
    """)
    md.execute(f"""
        CREATE TABLE IF NOT EXISTS {schema}.postings (
            posting_id VARCHAR PRIMARY KEY,
            event_id VARCHAR NOT NULL,
            account_type VARCHAR NOT NULL,
            account_id VARCHAR NOT NULL,
            unit VARCHAR NOT NULL,
            delta_numeric DOUBLE NOT NULL,
            dims_json JSON
        )
    """)


def upload(
    *,
    motherduck_db: str,
    log_dir: Path | str,
    schema: str = "controllog",
    motherduck_token: str | None = None,
) -> dict[str, int]:
    """Upload all local JSONL logs under ``log_dir`` into MotherDuck.

    Idempotent: existing ``event_id`` / ``posting_id`` rows are skipped.

    Returns a dict with the number of rows inserted (not total rows in table).
    """
    log_dir = Path(log_dir)
    event_files = _iter_jsonl_files(log_dir, "events")
    posting_files = _iter_jsonl_files(log_dir, "postings")
    if not event_files and not posting_files:
        raise FileNotFoundError(f"No controllog JSONL files found under {log_dir}/controllog/")

    md = _connect(motherduck_db, motherduck_token)
    try:
        _ensure_schema(md, schema)

        events_inserted = 0
        for ef in event_files:
            before = md.execute(f"SELECT COUNT(*) FROM {schema}.events").fetchone()[0]
            md.execute(f"""
                INSERT INTO {schema}.events (
                    event_id, event_time, ingest_time, kind, project_id, source,
                    idempotency_key, payload_json, run_id, actor_agent_id, actor_task_id
                )
                SELECT
                    CAST(event_id AS VARCHAR),
                    event_time,
                    ingest_time,
                    kind,
                    project_id,
                    source,
                    idempotency_key,
                    payload_json,
                    run_id,
                    actor_agent_id,
                    actor_task_id
                FROM read_json_auto('{ef}') AS src
                WHERE CAST(src.event_id AS VARCHAR)
                    NOT IN (SELECT event_id FROM {schema}.events)
            """)
            after = md.execute(f"SELECT COUNT(*) FROM {schema}.events").fetchone()[0]
            events_inserted += after - before

        postings_inserted = 0
        for pf in posting_files:
            before = md.execute(f"SELECT COUNT(*) FROM {schema}.postings").fetchone()[0]
            md.execute(f"""
                INSERT INTO {schema}.postings (
                    posting_id, event_id, account_type, account_id,
                    unit, delta_numeric, dims_json
                )
                SELECT
                    CAST(posting_id AS VARCHAR),
                    CAST(event_id AS VARCHAR),
                    account_type,
                    account_id,
                    unit,
                    delta_numeric,
                    dims_json
                FROM read_json_auto('{pf}') AS src
                WHERE CAST(src.posting_id AS VARCHAR)
                    NOT IN (SELECT posting_id FROM {schema}.postings)
            """)
            after = md.execute(f"SELECT COUNT(*) FROM {schema}.postings").fetchone()[0]
            postings_inserted += after - before

        return {"events": events_inserted, "postings": postings_inserted}
    finally:
        md.close()


def verify(
    *,
    motherduck_db: str,
    schema: str = "controllog",
    motherduck_token: str | None = None,
) -> dict[str, Any]:
    """Run trial-balance checks against the uploaded controllog data.

    Returns row counts, any (account_type, unit) slices that fail the
    trial-balance invariant, and a histogram of event kinds.
    """
    md = _connect(motherduck_db, motherduck_token)
    try:
        events = md.execute(f"SELECT COUNT(*) FROM {schema}.events").fetchone()[0]
        postings = md.execute(f"SELECT COUNT(*) FROM {schema}.postings").fetchone()[0]

        violations = md.execute(f"""
            SELECT account_type, unit, SUM(delta_numeric) AS net
            FROM {schema}.postings
            GROUP BY account_type, unit
            HAVING ABS(SUM(delta_numeric)) > 0.0001
        """).fetchall()

        event_kinds = md.execute(f"""
            SELECT kind, COUNT(*) AS count
            FROM {schema}.events
            GROUP BY kind
            ORDER BY count DESC
        """).fetchall()

        return {
            "events": events,
            "postings": postings,
            "trial_balance_violations": [
                {"account_type": r[0], "unit": r[1], "net": r[2]} for r in violations
            ],
            "event_kinds": {row[0]: row[1] for row in event_kinds},
        }
    finally:
        md.close()


def cleanup_local(
    *,
    log_dir: Path | str,
    motherduck_db: str,
    schema: str = "controllog",
    motherduck_token: str | None = None,
    verify_uploaded: bool = True,
    dry_run: bool = False,
) -> dict[str, Any]:
    """Delete local controllog JSONL files after confirming MotherDuck has them.

    Set ``verify_uploaded=False`` to skip the row-count check (e.g., if you
    are running offline or trust an earlier upload).
    """
    log_dir = Path(log_dir)
    event_files = _iter_jsonl_files(log_dir, "events")
    posting_files = _iter_jsonl_files(log_dir, "postings")

    local_events = sum(1 for ef in event_files for line in open(ef) if line.strip())
    local_postings = sum(1 for pf in posting_files for line in open(pf) if line.strip())

    if verify_uploaded:
        md = _connect(motherduck_db, motherduck_token)
        try:
            remote_events = md.execute(f"SELECT COUNT(*) FROM {schema}.events").fetchone()[0]
            remote_postings = md.execute(f"SELECT COUNT(*) FROM {schema}.postings").fetchone()[0]
        finally:
            md.close()
        if remote_events < local_events:
            raise RuntimeError(
                f"Verification failed: local has {local_events} events, "
                f"MotherDuck has {remote_events}. Run upload() first or pass verify_uploaded=False."
            )
        if remote_postings < local_postings:
            raise RuntimeError(
                f"Verification failed: local has {local_postings} postings, "
                f"MotherDuck has {remote_postings}. Run upload() first or pass verify_uploaded=False."
            )

    to_delete = event_files + posting_files
    bytes_freed = sum(f.stat().st_size for f in to_delete)
    if not dry_run:
        for f in to_delete:
            f.unlink()

    return {
        "files_deleted": 0 if dry_run else len(to_delete),
        "files": [str(f) for f in to_delete],
        "bytes_freed": bytes_freed,
        "dry_run": dry_run,
        "local_events": local_events,
        "local_postings": local_postings,
    }
