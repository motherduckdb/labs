"""Hand-computed expectations for the fixture (see tests/fixtures/controllog).

Run A (run-a): balanced. cost flow 0.002, latency 1500, utility 1.
Run B (run-b): one unbalanced resource.money/usd slice (net -0.001). cost flow 0.005.
Global: resource.money/usd nets to -0.001 — the only trial-balance violation.
"""
import math

from controllog_viz import queries as q


def _by_run(rows):
    return {r["run_id"]: r for r in rows}


def test_runs_summary(con):
    runs = _by_run(q.runs(con))
    assert set(runs) == {"run-a", "run-b"}

    a = runs["run-a"]
    assert a["event_count"] == 3
    assert a["kind_count"] == 3
    assert math.isclose(a["cost"], 0.002, abs_tol=1e-9)
    assert math.isclose(a["latency_ms"], 1500, abs_tol=1e-9)
    assert math.isclose(a["utility"], 1, abs_tol=1e-9)
    assert a["invariant_ok"] is True

    b = runs["run-b"]
    assert b["event_count"] == 3
    assert math.isclose(b["cost"], 0.005, abs_tol=1e-9)
    assert math.isclose(b["latency_ms"], 2200, abs_tol=1e-9)
    assert b["utility"] == 0
    assert b["invariant_ok"] is False


def test_postings_rollup_for_run_a(con):
    rollup = {(r["account_type"], r["unit"]): r for r in q.postings_rollup(con, "run-a")}
    assert math.isclose(rollup[("resource.money", "usd")]["flow"], 0.002, abs_tol=1e-9)
    assert math.isclose(rollup[("resource.money", "usd")]["net"], 0.0, abs_tol=1e-9)
    assert rollup[("resource.money", "usd")]["posting_count"] == 2
    assert math.isclose(rollup[("resource.time_ms", "ms")]["flow"], 1500, abs_tol=1e-9)
    assert math.isclose(rollup[("value.utility", "score")]["flow"], 1, abs_tol=1e-9)


def test_trial_balance_global_flags_only_money(con):
    violations = q.trial_balance(con)
    assert len(violations) == 1
    v = violations[0]
    assert v["account_type"] == "resource.money"
    assert v["unit"] == "usd"
    assert math.isclose(v["net"], -0.001, abs_tol=1e-9)


def test_trial_balance_per_run(con):
    assert q.trial_balance(con, "run-a") == []
    run_b = q.trial_balance(con, "run-b")
    assert len(run_b) == 1
    assert run_b[0]["account_type"] == "resource.money"


def test_kind_counts(con):
    counts = {r["kind"]: r["count"] for r in q.kind_counts(con)}
    assert counts == {
        "model_prompt": 2, "model_completion": 2, "task_done": 1, "task_failed": 1,
    }
    run_a = {r["kind"]: r["count"] for r in q.kind_counts(con, "run-a")}
    assert run_a == {"model_prompt": 1, "model_completion": 1, "task_done": 1}


def test_latest_run_id(con):
    assert q.latest_run_id(con) == "run-b"


def test_kind_counts_by_run(con):
    by_run = {}
    for row in q.kind_counts_by_run(con):
        by_run.setdefault(row["run_id"], {})[row["kind"]] = row["count"]
    assert by_run["run-a"] == {"model_prompt": 1, "model_completion": 1, "task_done": 1}
    assert by_run["run-b"] == {"model_prompt": 1, "model_completion": 1, "task_failed": 1}
