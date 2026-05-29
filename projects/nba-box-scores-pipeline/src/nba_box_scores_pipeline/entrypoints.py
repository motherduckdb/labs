"""Runnable entrypoints for the ingest flights.

These live in the package (not in flights/<name>/main.py) so the flight
bootstrappers can invoke them from the uv-synced venv via:

    python -m nba_box_scores_pipeline.entrypoints nightly
    python -m nba_box_scores_pipeline.entrypoints backfill

The flights/<name>/main.py files are thin bootstrappers: they clone the
repo, `uv sync`, and shell out to the command above. All real work is here
so it's importable and unit-testable.

Config comes entirely from env vars (see config.build_config_from_env and
the per-command notes below) — there's no argv inside a flight.
"""

from __future__ import annotations

import logging
import os
import sys
from dataclasses import replace

from .api.nba import PBPStatsClient
from .config import (
    SEASON_TYPES,
    PipelineConfig,
    Season,
    build_config_from_env,
)
from .db.connection import connect
from .db.loader import Loader
from .db.schema import ensure_box_scores_table, ensure_schema
from .rate_limiter import RateLimiter
from .workers.season_worker import process_season


DATABASE = "nba_box_scores_v3"


def _run(config: PipelineConfig, *, box_scores_table: str, label: str) -> None:
    log = logging.getLogger(label)
    log.info(
        "starting %s database=%s box_scores_table=%s seasons=%s force=%s fill_raw=%s dry_run=%s",
        label, DATABASE, box_scores_table,
        [(s.year, s.type) for s in config.seasons],
        config.force, config.fill_raw, config.dry_run,
    )

    con = connect(DATABASE)
    ensure_schema(con, db=DATABASE)
    if box_scores_table != "box_scores":
        ensure_box_scores_table(con, box_scores_table)
        log.info("ensured sandbox table main.%s exists", box_scores_table)

    loader = Loader(con, box_scores_table=box_scores_table)
    rate_limiter = RateLimiter(
        base_delay_ms=config.delay_ms,
        min_delay_ms=config.min_delay_ms,
        max_delay_ms=config.max_delay_ms,
    )

    totals = {"completed": 0, "skipped": 0, "failed": 0}
    with PBPStatsClient(rate_limiter) as client:
        for season in config.seasons:
            progress = process_season(
                season_year=season.year,
                season_type=season.type,
                client=client,
                loader=loader,
                config=config,
            )
            totals["completed"] += progress.completed
            totals["skipped"] += progress.skipped
            totals["failed"] += progress.failed

    log.info(
        "%s complete completed=%d skipped=%d failed=%d",
        label, totals["completed"], totals["skipped"], totals["failed"],
    )


def run_nightly() -> None:
    """Current-season ingest (Regular Season + Playoffs).

    Defaults to writing the validation sandbox table `box_scores_new`;
    set NBA_INGEST_BOX_SCORES_TABLE=box_scores to write production once
    parity against the cloned baseline is confirmed.
    """
    config = build_config_from_env()
    box_scores_table = os.environ.get("NBA_INGEST_BOX_SCORES_TABLE", "box_scores_new")
    _run(config, box_scores_table=box_scores_table, label="nba_nightly")


def run_backfill() -> None:
    """On-demand historical backfill across a season range.

    Requires NBA_BACKFILL_START_SEASON and NBA_BACKFILL_END_SEASON.
    Defaults to writing the canonical `box_scores` table since backfills
    are typically historical and target prod.
    """
    start = os.environ.get("NBA_BACKFILL_START_SEASON")
    end = os.environ.get("NBA_BACKFILL_END_SEASON")
    if not start or not end:
        raise RuntimeError("NBA_BACKFILL_START_SEASON and NBA_BACKFILL_END_SEASON are required")
    start_year, end_year = int(start), int(end)
    if start_year > end_year:
        raise RuntimeError(f"start ({start_year}) must be <= end ({end_year})")

    seasons = tuple(
        Season(year=y, type=st)
        for y in range(start_year, end_year + 1)
        for st in SEASON_TYPES
    )
    config = replace(build_config_from_env(), seasons=seasons)
    box_scores_table = os.environ.get("NBA_INGEST_BOX_SCORES_TABLE", "box_scores")
    _run(config, box_scores_table=box_scores_table, label="nba_backfill")


_COMMANDS = {"nightly": run_nightly, "backfill": run_backfill}


def main(argv: list[str] | None = None) -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    argv = list(sys.argv[1:] if argv is None else argv)
    if len(argv) != 1 or argv[0] not in _COMMANDS:
        raise SystemExit(f"usage: python -m nba_box_scores_pipeline.entrypoints {{{'|'.join(_COMMANDS)}}}")
    _COMMANDS[argv[0]]()


if __name__ == "__main__":
    main()
