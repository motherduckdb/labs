"""Test fixtures.

Each test gets a fresh ``controllog.init()`` against a tmp_path log dir
so module-global state doesn't bleed between cases.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

import controllog
from controllog import sdk as _sdk


@pytest.fixture(autouse=True)
def _reset_controllog():
    """Reset module-global config before each test."""
    _sdk._config = None
    yield
    _sdk._config = None


@pytest.fixture
def log_dir(tmp_path: Path) -> Path:
    """A pristine log_dir, initialized for a 'test' project."""
    controllog.init(project_id="test", log_dir=tmp_path)
    return tmp_path


def read_jsonl(path: Path) -> list[dict]:
    """Load a JSONL file as a list of dicts."""
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


@pytest.fixture
def read_events(log_dir):
    def _read() -> list[dict]:
        return read_jsonl(log_dir / "controllog" / "events.jsonl")
    return _read


@pytest.fixture
def read_postings(log_dir):
    def _read() -> list[dict]:
        return read_jsonl(log_dir / "controllog" / "postings.jsonl")
    return _read
