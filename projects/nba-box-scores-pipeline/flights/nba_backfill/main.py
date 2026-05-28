"""Entrypoint for the nba_backfill Flight.

On-demand historical-season backfill. Use when v3's raw or hydrated
tables are missing seasons that the nightly didn't cover (Phase 0's
clone preloaded everything through v2's coverage, so this is rarely
needed at cutover).

Env vars (all optional unless noted):
  MOTHERDUCK_TOKEN              required
  NBA_BACKFILL_START_SEASON     required; first season-start year
  NBA_BACKFILL_END_SEASON       required; last season-start year (inclusive)
  NBA_INGEST_BOX_SCORES_TABLE   target box-score table (default
                                box_scores — backfills target prod
                                since they're typically historical)
  NBA_INGEST_FORCE / NBA_INGEST_FILL_RAW / NBA_INGEST_DRY_RUN
                                "1" enables; same semantics as nightly
"""

import logging
import os
from dataclasses import replace

from nba_box_scores_pipeline.api.nba import PBPStatsClient
from nba_box_scores_pipeline.config import (
    PipelineConfig,
    SEASON_TYPES,
    Season,
    build_config_from_env,
)
from nba_box_scores_pipeline.db.connection import connect
from nba_box_scores_pipeline.db.loader import Loader
from nba_box_scores_pipeline.db.schema import ensure_schema
from nba_box_scores_pipeline.rate_limiter import RateLimiter
from nba_box_scores_pipeline.workers.season_worker import process_season


DATABASE = "nba_box_scores_v3"


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    log = logging.getLogger("nba_backfill")

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

    base_config = build_config_from_env()
    config: PipelineConfig = replace(base_config, seasons=seasons)
    box_scores_table = os.environ.get("NBA_INGEST_BOX_SCORES_TABLE", "box_scores")

    log.info(
        "starting backfill database=%s box_scores_table=%s years=%d-%d force=%s fill_raw=%s dry_run=%s",
        DATABASE, box_scores_table, start_year, end_year,
        config.force, config.fill_raw, config.dry_run,
    )

    con = connect(DATABASE)
    ensure_schema(con, db=DATABASE)

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
        "backfill complete completed=%d skipped=%d failed=%d",
        totals["completed"], totals["skipped"], totals["failed"],
    )


if __name__ == "__main__":
    main()
