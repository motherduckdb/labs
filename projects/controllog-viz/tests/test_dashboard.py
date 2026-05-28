"""Dashboard tabs, sortable/filterable table, and the run × question matrix."""
from pathlib import Path

import pytest

from controllog_viz import queries as q
from controllog_viz import reader, render

FIX = Path(__file__).parent / "fixtures"           # universal, no eval
FIX_MATRIX = Path(__file__).parent / "fixtures_matrix"  # 2 runs, progression + regression


@pytest.fixture
def ucon():
    c = reader.connect(str(FIX))
    yield c
    c.close()


@pytest.fixture
def mcon():
    c = reader.connect(str(FIX_MATRIX))
    yield c
    c.close()


# --- tabs / table / filters (universal) -------------------------------------

def test_tabbed_layout(ucon):
    html = render.render_dashboard(ucon, "fixtures")
    assert 'class="tabs"' in html
    for key in ("summary", "trends", "kinds", "invariants"):
        assert f'data-tab="{key}"' in html
        assert f'id="tab-{key}"' in html


def test_sortable_filterable_table(ucon):
    html = render.render_dashboard(ucon, "fixtures")
    assert 'id="summaryTable"' in html
    assert 'class="sortable' in html
    assert 'id="filterRunId"' in html
    assert "function applyFilters" in html
    assert "sorted-asc" in html  # JS toggles this class
    # row carries filter data attributes
    assert 'data-runid="run-a"' in html


def test_universal_dashboard_has_no_matrix_tab(ucon):
    assert q.has_any_eval_results(ucon) is False
    html = render.render_dashboard(ucon, "fixtures")
    assert 'data-tab="matrix"' not in html


# --- matrix (eval-aware) ----------------------------------------------------

def test_matrix_tab_present_with_eval_data(mcon):
    assert q.has_any_eval_results(mcon) is True
    html = render.render_dashboard(mcon, "matrix")
    assert 'data-tab="matrix"' in html
    assert 'id="tab-matrix"' in html


def test_matrix_detects_progression_and_regression(mcon):
    html = render.render_dashboard(mcon, "matrix")
    # q1 went incorrect->correct (progression), q2 correct->incorrect (regression)
    assert "(progression)" in html
    assert "(regression)" in html
    # progression border (cyan) and regression border (amber) both present
    assert "#22d3ee" in html
    assert "#ffd23f" in html


def test_build_matrix_flip_counts(mcon):
    run_rows = q.runs(mcon)
    rows = render._build_matrix(mcon, run_rows)
    by_q = {qid: (seq, flips, trans) for qid, seq, flips, trans in rows}
    # q1 and q2 each flip once; q3 is stable (0 flips)
    assert by_q["1"][1] == 1
    assert by_q["2"][1] == 1
    assert by_q["3"][1] == 0
    # q1's flip at the 2nd column is a progression; q2's is a regression
    assert by_q["1"][2] == {1: "prog"}
    assert by_q["2"][2] == {1: "regr"}
    # most-volatile-first ordering puts the flipping questions ahead of the stable one
    assert rows[-1][0] == "3"


def test_matrix_runs_chronological(mcon):
    # oldest run first in the column order
    run_rows = q.runs(mcon)
    assert [r["run_id"] for r in run_rows] == ["run-1", "run-2"]
