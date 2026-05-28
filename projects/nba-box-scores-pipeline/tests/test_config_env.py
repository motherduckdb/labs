"""Tests for `build_config_from_env` — the env-only config builder used inside Flights."""

from __future__ import annotations

import pytest

from nba_box_scores_pipeline.config import (
    SEASON_TYPES,
    build_config_from_env,
    current_season_year,
)


class TestRequiredToken:
    def test_missing_token_raises(self):
        with pytest.raises(RuntimeError, match="MOTHERDUCK_TOKEN"):
            build_config_from_env(env={})


class TestDefaults:
    def test_defaults_to_current_season_both_types(self):
        cfg = build_config_from_env(env={"MOTHERDUCK_TOKEN": "t"})
        year = current_season_year()
        assert cfg.seasons == tuple(
            type(cfg.seasons[0])(year=year, type=st) for st in SEASON_TYPES
        )
        assert cfg.delay_ms == 500
        assert cfg.min_delay_ms == 200
        assert cfg.max_delay_ms == 10_000
        assert cfg.force is False
        assert cfg.fill_raw is False
        assert cfg.dry_run is False
        assert cfg.motherduck_token == "t"


class TestOverrides:
    def test_season_override(self):
        cfg = build_config_from_env(env={"MOTHERDUCK_TOKEN": "t", "NBA_INGEST_SEASON": "2020"})
        assert {s.year for s in cfg.seasons} == {2020}
        assert {s.type for s in cfg.seasons} == set(SEASON_TYPES)

    def test_boolean_flags(self):
        cfg = build_config_from_env(env={
            "MOTHERDUCK_TOKEN": "t",
            "NBA_INGEST_FORCE": "1",
            "NBA_INGEST_FILL_RAW": "1",
            "NBA_INGEST_DRY_RUN": "1",
        })
        assert cfg.force and cfg.fill_raw and cfg.dry_run

    def test_boolean_flag_non_one_does_not_enable(self):
        cfg = build_config_from_env(env={
            "MOTHERDUCK_TOKEN": "t",
            "NBA_INGEST_FORCE": "true",  # only "1" enables
            "NBA_INGEST_FILL_RAW": "0",
        })
        assert cfg.force is False
        assert cfg.fill_raw is False

    def test_delay_overrides(self):
        cfg = build_config_from_env(env={
            "MOTHERDUCK_TOKEN": "t",
            "NBA_INGEST_DELAY_MS": "750",
            "NBA_INGEST_MIN_DELAY_MS": "300",
            "NBA_INGEST_MAX_DELAY_MS": "20000",
        })
        assert cfg.delay_ms == 750
        assert cfg.min_delay_ms == 300
        assert cfg.max_delay_ms == 20_000


class TestFlightMainsImportCleanly:
    """Both flight entrypoints must import without raising — proves all
    package-internal imports resolve from a fresh interpreter."""

    def test_nba_nightly_imports(self):
        import importlib.util
        from pathlib import Path

        path = Path(__file__).parent.parent / "flights" / "nba_nightly" / "main.py"
        spec = importlib.util.spec_from_file_location("nba_nightly_main", path)
        assert spec and spec.loader
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        assert callable(module.main)

    def test_nba_backfill_imports(self):
        import importlib.util
        from pathlib import Path

        path = Path(__file__).parent.parent / "flights" / "nba_backfill" / "main.py"
        spec = importlib.util.spec_from_file_location("nba_backfill_main", path)
        assert spec and spec.loader
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        assert callable(module.main)
