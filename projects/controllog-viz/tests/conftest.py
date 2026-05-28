from pathlib import Path

import pytest

from controllog_viz import reader

FIXTURE_DIR = Path(__file__).parent / "fixtures"


@pytest.fixture
def con():
    """Connection over the JSONL fixture (2 runs, one unbalanced money slice)."""
    c = reader.connect(str(FIXTURE_DIR))
    yield c
    c.close()
