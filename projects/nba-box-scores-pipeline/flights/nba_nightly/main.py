"""Entrypoint for the nba_nightly Flight.

Runs the full ingest stack for the current NBA season — both Regular
Season and Playoffs — once per scheduled run. Mirrors the legacy
nightly-sync.yml workflow.

Env vars (all optional unless noted):
  MOTHERDUCK_TOKEN              required; injected by Flight runtime
  NBA_INGEST_SEASON             override the season-start year
  NBA_INGEST_BOX_SCORES_TABLE   target box-score table (default
                                box_scores_new — validation phase;
                                flip to box_scores once parity is
                                confirmed against the cloned baseline)
  NBA_INGEST_FORCE              "1" → ignore skip set
  NBA_INGEST_FILL_RAW           "1" → only fetch raw, skip hydration
  NBA_INGEST_DRY_RUN            "1" → log plan, write nothing
  NBA_INGEST_DELAY_MS / NBA_INGEST_MIN_DELAY_MS / NBA_INGEST_MAX_DELAY_MS
                                rate-limiter tuning
"""

import logging
import os

from nba_box_scores_pipeline.api.nba import PBPStatsClient
from nba_box_scores_pipeline.config import build_config_from_env
from nba_box_scores_pipeline.db.connection import connect
from nba_box_scores_pipeline.db.loader import Loader
from nba_box_scores_pipeline.db.schema import ensure_schema
from nba_box_scores_pipeline.rate_limiter import RateLimiter
from nba_box_scores_pipeline.workers.season_worker import process_season


DATABASE = "nba_box_scores_v3"
DEFAULT_BOX_SCORES_TABLE = "box_scores_new"  # validation phase target


# Same DDL as the canonical box_scores table, but parameterized so the
# sandbox table (default box_scores_new) gets the same PK and therefore
# the same INSERT OR REPLACE idempotency.
_SANDBOX_BOX_SCORES_DDL = """
CREATE TABLE IF NOT EXISTS main.{table} (
  game_id VARCHAR,
  team_abbreviation VARCHAR,
  entity_id VARCHAR,
  player_name VARCHAR,
  period VARCHAR NOT NULL DEFAULT 'FullGame',
  minutes VARCHAR,
  points INTEGER NOT NULL DEFAULT 0,
  rebounds INTEGER NOT NULL DEFAULT 0,
  assists INTEGER NOT NULL DEFAULT 0,
  steals INTEGER NOT NULL DEFAULT 0,
  blocks INTEGER NOT NULL DEFAULT 0,
  turnovers INTEGER NOT NULL DEFAULT 0,
  fg_made INTEGER NOT NULL DEFAULT 0,
  fg_attempted INTEGER NOT NULL DEFAULT 0,
  fg3_made INTEGER NOT NULL DEFAULT 0,
  fg3_attempted INTEGER NOT NULL DEFAULT 0,
  ft_made INTEGER NOT NULL DEFAULT 0,
  ft_attempted INTEGER NOT NULL DEFAULT 0,
  starter INTEGER,
  PRIMARY KEY (game_id, entity_id, period)
);
"""


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    config = build_config_from_env()
    box_scores_table = os.environ.get("NBA_INGEST_BOX_SCORES_TABLE", DEFAULT_BOX_SCORES_TABLE)

    log = logging.getLogger("nba_nightly")
    log.info(
        "starting nightly database=%s box_scores_table=%s seasons=%s force=%s fill_raw=%s dry_run=%s",
        DATABASE, box_scores_table, [(s.year, s.type) for s in config.seasons],
        config.force, config.fill_raw, config.dry_run,
    )

    con = connect(DATABASE)
    ensure_schema(con, db=DATABASE)

    if box_scores_table != "box_scores":
        con.execute(_SANDBOX_BOX_SCORES_DDL.format(table=box_scores_table))
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
        "nightly complete completed=%d skipped=%d failed=%d",
        totals["completed"], totals["skipped"], totals["failed"],
    )


if __name__ == "__main__":
    main()
