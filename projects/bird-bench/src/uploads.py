"""Bird-bench-specific upload helpers.

The generic events/postings upload + cleanup + verify live in ``controllog.motherduck``.
This module adds the bird-bench-only tables (``truth_seeking``,
``error_investigations``) and the cleanup wrapper that also handles
``error_logs/`` and HTML reports.
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import duckdb

from controllog import motherduck


def upload_truth_seeking(
    motherduck_db: str,
    log_dir: Path | str,
    motherduck_token: str | None = None,
    schema: str = "bird_eval",
) -> int:
    """Upload truth_seeking analysis JSONL into ``{schema}.truth_seeking``."""
    base_dir = Path(log_dir)
    truth_seeking_dir = base_dir / "truth_seeking"
    if not truth_seeking_dir.exists():
        print("No truth_seeking directory found, skipping")
        return 0

    jsonl_files = list(truth_seeking_dir.glob("*.jsonl"))
    if not jsonl_files:
        print("No truth_seeking JSONL files found, skipping")
        return 0

    token = motherduck_token or os.environ.get("MOTHERDUCK_TOKEN")
    if not token:
        raise ValueError("MOTHERDUCK_TOKEN not set")

    md = duckdb.connect(f"md:{motherduck_db}?motherduck_token={token}")
    try:
        md.execute(f"CREATE SCHEMA IF NOT EXISTS {schema}")
        md.execute(f"""
            CREATE TABLE IF NOT EXISTS {schema}.truth_seeking (
                question_id INTEGER,
                db_id VARCHAR,
                verdict VARCHAR,
                confidence VARCHAR,
                reasoning VARCHAR,
                recommendation VARCHAR,
                gold_sql VARCHAR,
                predicted_sql VARCHAR,
                gold_issues VARCHAR,
                predicted_issues VARCHAR,
                correctness_level VARCHAR,
                inspector_model VARCHAR,
                analyzed_at TIMESTAMP,
                source_file VARCHAR
            )
        """)

        total = 0
        for jf in jsonl_files:
            md.execute(f"""
                INSERT INTO {schema}.truth_seeking
                SELECT
                    question_id, db_id, verdict, confidence, reasoning,
                    recommendation, gold_sql, predicted_sql,
                    CAST(gold_issues AS VARCHAR),
                    CAST(predicted_issues AS VARCHAR),
                    correctness_level, inspector_model,
                    analyzed_at::TIMESTAMP,
                    '{jf.name}' as source_file
                FROM read_json_auto('{jf}', ignore_errors=true)
            """)
            total += md.execute(
                f"SELECT COUNT(*) FROM read_json_auto('{jf}', ignore_errors=true)"
            ).fetchone()[0]

        print(f"Uploaded {total} truth_seeking records")
        return total
    finally:
        md.close()


def upload_error_investigations(
    motherduck_db: str,
    log_dir: Path | str,
    motherduck_token: str | None = None,
    schema: str = "bird_eval",
) -> int:
    """Upload error_logs JSONL into ``{schema}.error_investigations``."""
    base_dir = Path(log_dir)
    error_logs_dir = base_dir / "error_logs"
    if not error_logs_dir.exists():
        print("No error_logs directory found, skipping")
        return 0

    jsonl_files = list(error_logs_dir.glob("*.jsonl"))
    if not jsonl_files:
        print("No error_logs JSONL files found, skipping")
        return 0

    token = motherduck_token or os.environ.get("MOTHERDUCK_TOKEN")
    if not token:
        raise ValueError("MOTHERDUCK_TOKEN not set")

    md = duckdb.connect(f"md:{motherduck_db}?motherduck_token={token}")
    try:
        md.execute(f"CREATE SCHEMA IF NOT EXISTS {schema}")
        md.execute(f"""
            CREATE TABLE IF NOT EXISTS {schema}.error_investigations (
                question_id INTEGER,
                db_id VARCHAR,
                dataset VARCHAR,
                model VARCHAR,
                category VARCHAR,
                short_description VARCHAR,
                detailed_description VARCHAR,
                correctness_level VARCHAR,
                partial_reason VARCHAR,
                gold_sql_duckdb VARCHAR,
                predicted_sql VARCHAR,
                gold_tables VARCHAR,
                predicted_tables VARCHAR,
                source_file VARCHAR
            )
        """)

        total = 0
        for jf in jsonl_files:
            md.execute(f"""
                INSERT INTO {schema}.error_investigations
                SELECT
                    question_id, db_id, dataset, model, category,
                    short_description, detailed_description,
                    correctness_level, partial_reason,
                    gold_sql_duckdb, predicted_sql,
                    CAST(gold_tables AS VARCHAR),
                    CAST(predicted_tables AS VARCHAR),
                    '{jf.name}' as source_file
                FROM read_json_auto('{jf}', ignore_errors=true)
            """)
            total += md.execute(
                f"SELECT COUNT(*) FROM read_json_auto('{jf}', ignore_errors=true)"
            ).fetchone()[0]

        print(f"Uploaded {total} error_investigations records")
        return total
    finally:
        md.close()


def cleanup_local(
    log_dir: Path | str,
    motherduck_db: str,
    motherduck_token: str | None = None,
    verify_uploaded: bool = True,
    delete_html: bool = False,
    dry_run: bool = False,
) -> dict[str, Any]:
    """Clean up bird-bench local logs: controllog JSONL + error_logs + optional HTML."""
    base_dir = Path(log_dir)

    # Delegate JSONL cleanup to the library
    result = motherduck.cleanup_local(
        log_dir=base_dir,
        motherduck_db=motherduck_db,
        motherduck_token=motherduck_token,
        verify_uploaded=verify_uploaded,
        dry_run=dry_run,
    )

    # Bird-bench-specific: error_logs/*.jsonl and optional HTML reports
    extra_files: list[Path] = []
    error_logs_dir = base_dir / "error_logs"
    if error_logs_dir.exists():
        extra_files.extend(error_logs_dir.glob("*.jsonl"))
    if delete_html:
        extra_files.extend(base_dir.glob("error_analysis_*.html"))

    extra_bytes = sum(f.stat().st_size for f in extra_files)
    if not dry_run:
        for f in extra_files:
            f.unlink()

    result["files"].extend(str(f) for f in extra_files)
    result["files_deleted"] += 0 if dry_run else len(extra_files)
    result["bytes_freed"] += extra_bytes
    return result
