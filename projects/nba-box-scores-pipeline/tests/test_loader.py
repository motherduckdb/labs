"""Idempotency tests for the loader.

Runs against an in-memory DuckDB instance so each test is hermetic and
fast. The schema DDL is identical to what runs against MotherDuck — the
primary keys are what give `INSERT OR REPLACE` its idempotency, and they
work the same locally.

These tests are the contract that protects Flight retries: a Flight that
dies mid-run and is restarted must converge to the same end state, not
duplicate rows.
"""

from __future__ import annotations

import json
from pathlib import Path

import duckdb
import pytest

from nba_box_scores_pipeline.db.loader import (
    IngestionLogEntry,
    Loader,
    ScheduleRow,
)
from nba_box_scores_pipeline.db.schema import ensure_tables, ensure_views
from nba_box_scores_pipeline.parsers.nba_box_score import parse_box_score


FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture
def con():
    c = duckdb.connect(":memory:")
    ensure_tables(c)
    yield c
    c.close()


@pytest.fixture
def loader(con):
    return Loader(con)


@pytest.fixture
def regulation_rows():
    return parse_box_score(json.loads((FIXTURES / "0022400061.json").read_text()))


def _count(con, table: str) -> int:
    return con.execute(f"SELECT COUNT(*) FROM main.{table}").fetchone()[0]


class TestBoxScoreIdempotency:
    def test_first_load_writes_all_rows(self, con, loader, regulation_rows):
        loader.load_box_scores(regulation_rows)
        assert _count(con, "box_scores") == len(regulation_rows)

    def test_reload_same_rows_is_a_noop(self, con, loader, regulation_rows):
        loader.load_box_scores(regulation_rows)
        first = _count(con, "box_scores")
        loader.load_box_scores(regulation_rows)
        assert _count(con, "box_scores") == first

    def test_reload_with_changed_stat_overwrites(self, con, loader, regulation_rows):
        loader.load_box_scores(regulation_rows)
        # Mutate one row's points and reload — same PK should overwrite
        target = regulation_rows[0]
        original_points = target.points
        target.points = original_points + 99
        loader.load_box_scores([target])
        (new_points,) = con.execute(
            "SELECT points FROM main.box_scores WHERE game_id = ? AND entity_id = ? AND period = ?",
            [target.game_id, target.entity_id, target.period],
        ).fetchone()
        assert new_points == original_points + 99
        # And the total row count hasn't changed
        assert _count(con, "box_scores") == len(regulation_rows)

    def test_partial_reload_does_not_lose_other_rows(self, con, loader, regulation_rows):
        loader.load_box_scores(regulation_rows)
        before = _count(con, "box_scores")
        # Replay only the first 10 rows — the other ~80 should remain
        loader.load_box_scores(regulation_rows[:10])
        assert _count(con, "box_scores") == before

    def test_empty_load_is_noop(self, con, loader):
        loader.load_box_scores([])
        assert _count(con, "box_scores") == 0


class TestScheduleIdempotency:
    def test_reload_same_schedule_does_not_duplicate(self, con, loader):
        row = ScheduleRow(
            game_id="0022400061",
            game_date="2024-10-22 19:30:00",
            home_team_id=1610612738,
            away_team_id=1610612752,
            home_team_abbreviation="BOS",
            away_team_abbreviation="NYK",
            home_team_score=132,
            away_team_score=109,
            game_status="Final",
            season_year=2024,
            season_type="Regular Season",
        )
        loader.load_schedule([row])
        loader.load_schedule([row])
        assert _count(con, "schedule") == 1

    def test_changed_score_overwrites(self, con, loader):
        row = ScheduleRow(
            game_id="0022400061",
            game_date="2024-10-22 19:30:00",
            home_team_id=1610612738,
            away_team_id=1610612752,
            home_team_abbreviation="BOS",
            away_team_abbreviation="NYK",
            home_team_score=0,
            away_team_score=0,
            game_status="Scheduled",
            season_year=2024,
            season_type="Regular Season",
        )
        loader.load_schedule([row])
        row.home_team_score = 132
        row.away_team_score = 109
        row.game_status = "Final"
        loader.load_schedule([row])
        (status, home, away) = con.execute(
            "SELECT game_status, home_team_score, away_team_score FROM main.schedule WHERE game_id = ?",
            [row.game_id],
        ).fetchone()
        assert (status, home, away) == ("Final", 132, 109)


class TestIngestionLog:
    def test_mark_ingested_then_query(self, loader):
        loader.mark_ingested(IngestionLogEntry(
            game_id="0022400061", season_year=2024, season_type="Regular Season",
        ))
        assert loader.is_game_ingested("0022400061")
        assert not loader.is_game_ingested("0022400062")
        assert loader.get_ingested_game_ids(2024, "Regular Season") == {"0022400061"}
        # Different season filters cleanly
        assert loader.get_ingested_game_ids(2024, "Playoffs") == set()

    def test_remark_overwrites_status(self, con, loader):
        loader.mark_ingested(IngestionLogEntry(
            game_id="0022400061", season_year=2024, season_type="Regular Season",
            ingestion_status="failed", error_message="api timeout",
        ))
        loader.mark_ingested(IngestionLogEntry(
            game_id="0022400061", season_year=2024, season_type="Regular Season",
            ingestion_status="success",
        ))
        assert _count(con, "ingestion_log") == 1
        assert loader.is_game_ingested("0022400061")


class TestRawPbpstats:
    def test_reload_same_raw_does_not_duplicate(self, con, loader):
        payload = {"hello": "world"}
        loader.store_raw_pbpstats(
            game_id="0022400061", season_year=2024, season_type="Regular Season",
            game_json=payload, box_score_json=payload,
        )
        loader.store_raw_pbpstats(
            game_id="0022400061", season_year=2024, season_type="Regular Season",
            game_json=payload, box_score_json=payload,
        )
        assert _count(con, "raw_game_data_pbpstats") == 1

    def test_get_raw_game_ids_filters_by_season(self, loader):
        for game_id, season in [("a", 2023), ("b", 2024), ("c", 2024)]:
            loader.store_raw_pbpstats(
                game_id=game_id, season_year=season, season_type="Regular Season",
                game_json={}, box_score_json={},
            )
        assert loader.get_raw_game_ids(2024, "Regular Season") == {"b", "c"}
        assert loader.get_raw_game_ids(2023, "Regular Season") == {"a"}
        assert loader.get_raw_game_ids(2024, "Playoffs") == set()


class TestSandboxTables:
    """Validation path: write to box_scores_new, leave production box_scores alone."""

    def test_sandbox_loader_targets_alternate_table(self, con, regulation_rows):
        # CTAS doesn't preserve PKs, so spell the sandbox table out explicitly.
        # Same constraint applies in v3: anyone provisioning a `box_scores_new`
        # has to create it with the (game_id, entity_id, period) PK or the
        # loader's INSERT OR REPLACE has no conflict target.
        con.execute(
            """
            CREATE TABLE main.box_scores_new (
              game_id VARCHAR, team_abbreviation VARCHAR, entity_id VARCHAR,
              player_name VARCHAR, period VARCHAR, minutes VARCHAR,
              points INTEGER, rebounds INTEGER, assists INTEGER,
              steals INTEGER, blocks INTEGER, turnovers INTEGER,
              fg_made INTEGER, fg_attempted INTEGER,
              fg3_made INTEGER, fg3_attempted INTEGER,
              ft_made INTEGER, ft_attempted INTEGER, starter INTEGER,
              PRIMARY KEY (game_id, entity_id, period)
            )
            """
        )
        sandbox = Loader(con, box_scores_table="box_scores_new")
        sandbox.load_box_scores(regulation_rows)
        assert _count(con, "box_scores_new") == len(regulation_rows)
        assert _count(con, "box_scores") == 0  # production table untouched


class TestViewsRebind:
    """Cloned databases inherit view DDL pointing at the source DB; ensure_views fixes that."""

    def test_views_compile_against_active_db(self, con, regulation_rows, loader):
        loader.load_box_scores(regulation_rows)
        # In-memory DuckDB names the database "memory"
        ensure_views(con, db="memory")
        # team_stats should aggregate the box_scores we loaded
        teams = con.execute(
            "SELECT DISTINCT team_abbreviation FROM main.team_stats ORDER BY team_abbreviation"
        ).fetchall()
        assert [t[0] for t in teams] == ["BOS", "NYK"]
