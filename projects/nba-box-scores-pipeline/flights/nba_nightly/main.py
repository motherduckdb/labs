"""Entrypoint for the nba_nightly Flight.

Placeholder: connects to MotherDuck and prints row counts for the v3 base
tables, proving the runtime + token wiring. The real ingest logic ports
incrementally from the legacy TS pipeline (see plan.md §1.2).
"""

import duckdb


TABLES = [
    "raw_game_data_pbpstats",
    "schedule",
    "box_scores",
    "ingestion_log",
]


def main() -> None:
    con = duckdb.connect("md:")
    for table in TABLES:
        (count,) = con.execute(
            f"SELECT COUNT(*) FROM nba_box_scores_v3.main.{table}"
        ).fetchone()
        print(f"nba_box_scores_v3.main.{table}: {count:,}")


if __name__ == "__main__":
    main()
