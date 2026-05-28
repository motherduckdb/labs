"""Entrypoint for the nba_backfill Flight.

Placeholder. The real backfill driver ports from `scripts/ingest/backfill-raw.ts`
in the legacy repo (see plan.md §1.2). Reads season-range bounds from
`config` once that's wired up.
"""

import os

import duckdb


def main() -> None:
    start = os.environ.get("BACKFILL_START_SEASON", "<unset>")
    end = os.environ.get("BACKFILL_END_SEASON", "<unset>")
    print(f"nba_backfill placeholder — start={start} end={end}")

    con = duckdb.connect("md:")
    (count,) = con.execute(
        "SELECT COUNT(*) FROM nba_box_scores_v3.main.raw_game_data_pbpstats"
    ).fetchone()
    print(f"raw_game_data_pbpstats current row count: {count:,}")


if __name__ == "__main__":
    main()
