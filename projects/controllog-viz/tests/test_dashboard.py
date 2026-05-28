"""Dashboard tabs, sortable/filterable table, and the run × question matrix."""
import json
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
    # progression border is white (high contrast on the green/correct cell);
    # regression border is amber (on the red/incorrect cell)
    assert 'stroke="#ffffff"' in html
    assert 'stroke="#ffd23f"' in html


def test_recent_run_ids_scoping(mcon):
    assert q.recent_run_ids(mcon) == ["run-2", "run-1"]
    assert q.recent_run_ids(mcon, limit=1) == ["run-2"]
    # scoped queries return only the requested runs
    scoped = q.runs(mcon, run_ids=["run-2"])
    assert [r["run_id"] for r in scoped] == ["run-2"]
    assert {r["run_id"] for r in q.kind_counts_by_run(mcon, run_ids=["run-1"])} == {"run-1"}
    assert {r["run_id"] for r in q.eval_matrix(mcon, run_ids=["run-2"])} == {"run-2"}


def test_build_matrix_flip_counts(mcon):
    run_rows = q.runs(mcon)
    rows = render._build_matrix(mcon, run_rows)
    by_q = {qid: (seq, flips, trans) for qid, seq, flips, trans in rows}
    # q1 and q2 each flip once; q3 is stable (0 flips)
    assert by_q["1"][1] == 1
    assert by_q["2"][1] == 1
    assert by_q["3"][1] == 0
    # Display is newest-first, so the changed cell is column 0 (run-2, the newer run).
    # q1 went incorrect→correct in time → progression; q2 correct→incorrect → regression.
    assert by_q["1"][2] == {0: "prog"}
    assert by_q["2"][2] == {0: "regr"}
    # most-volatile-first ordering puts the flipping questions ahead of the stable one
    assert rows[-1][0] == "3"


def test_runs_newest_first(mcon):
    # newest run first in the row/column order
    run_rows = q.runs(mcon)
    assert [r["run_id"] for r in run_rows] == ["run-2", "run-1"]


def test_started_column_sorts_chronologically(ucon):
    html = render.render_dashboard(ucon, "fixtures")
    # the started cell carries the raw ISO timestamp as data-sort, so the JS sorts it
    # lexically (chronologically) instead of mis-parsing it as the year 2026
    assert 'data-sort="2026-05-26' in html
    # and the comparator reads data-sort with a strict numeric test
    assert "td.dataset.sort" in html
    assert "Number(va)" in html


def test_null_run_id_not_dropped(tmp_path):
    # run_id is nullable; the default --limit path must not drop the null-run group.
    cl = tmp_path / "controllog"
    cl.mkdir(parents=True)
    (cl / "events.jsonl").write_text(json.dumps({
        "event_id": "n1", "event_time": "2026-05-26T10:00:00+00:00",
        "ingest_time": "2026-05-26T10:00:00+00:00", "kind": "ping", "project_id": "p",
        "source": "sdk", "idempotency_key": "n1", "payload_json": {}, "run_id": None,
        "actor_agent_id": None, "actor_task_id": None,
    }) + "\n")
    con = reader.connect(str(tmp_path))
    try:
        assert q.recent_run_ids(con) == [None]
        assert len(q.runs(con, run_ids=[None])) == 1            # scoped query keeps it
        html = render.render_dashboard(con, "x", limit=50)      # default dashboard path
        assert "no runs found" not in html
    finally:
        con.close()
