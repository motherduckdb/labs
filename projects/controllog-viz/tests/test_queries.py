"""Hand-computed expectations for the fixture (see tests/fixtures/controllog).

Canonical projects/controllog accounts: truth.money/$, truth.time/ms, truth.utility/points,
truth.state/tasks.

Run A (run-a): balanced. cost flow 0.002, latency 1500, utility 1.
Run B (run-b): one unbalanced truth.money/$ slice (net -0.001). cost flow 0.005.
Global: truth.money/$ nets to -0.001 — the only trial-balance violation.
"""
import json
import math

from controllog_viz import queries as q
from controllog_viz import reader


def _source(tmp_path, events, postings):
    cl = tmp_path / "controllog"
    cl.mkdir(parents=True)
    (cl / "events.jsonl").write_text("".join(json.dumps(e) + "\n" for e in events))
    if postings:  # skip the file entirely when empty (read_json_auto can't infer a 0-byte file)
        (cl / "postings.jsonl").write_text("".join(json.dumps(p) + "\n" for p in postings))
    return reader.connect(str(tmp_path))


def _ev(eid, run="r", kind="model_completion"):
    return {"event_id": eid, "event_time": "2026-05-26T10:00:00+00:00",
            "ingest_time": "2026-05-26T10:00:00+00:00", "kind": kind, "project_id": "p",
            "source": "sdk", "idempotency_key": eid, "payload_json": {}, "run_id": run,
            "actor_agent_id": None, "actor_task_id": None}


def _po(pid, eid, acct, unit, delta):
    return {"posting_id": pid, "event_id": eid, "account_type": acct, "account_id": "x",
            "unit": unit, "delta_numeric": delta, "dims_json": {}}


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
    assert math.isclose(rollup[("truth.money", "$")]["flow"], 0.002, abs_tol=1e-9)
    assert math.isclose(rollup[("truth.money", "$")]["net"], 0.0, abs_tol=1e-9)
    assert rollup[("truth.money", "$")]["posting_count"] == 2
    assert math.isclose(rollup[("truth.time", "ms")]["flow"], 1500, abs_tol=1e-9)
    assert math.isclose(rollup[("truth.utility", "points")]["flow"], 1, abs_tol=1e-9)


def test_trial_balance_global_flags_only_money(con):
    violations = q.trial_balance(con)
    assert len(violations) == 1
    v = violations[0]
    assert v["account_type"] == "truth.money"
    assert v["unit"] == "$"
    assert math.isclose(v["net"], -0.001, abs_tol=1e-9)


def test_trial_balance_per_run(con):
    assert q.trial_balance(con, "run-a") == []
    run_b = q.trial_balance(con, "run-b")
    assert len(run_b) == 1
    assert run_b[0]["account_type"] == "truth.money"


def test_kind_counts(con):
    counts = {r["kind"]: r["count"] for r in q.kind_counts(con)}
    assert counts == {
        "model_prompt": 2, "model_completion": 2, "task_done": 1, "task_failed": 1,
    }
    run_a = {r["kind"]: r["count"] for r in q.kind_counts(con, "run-a")}
    assert run_a == {"model_prompt": 1, "model_completion": 1, "task_done": 1}


def test_canonical_truth_accounts_total(tmp_path):
    # canonical projects/controllog names produce non-zero cost/latency/utility
    ev = [_ev("e1")]
    po = [
        _po("a", "e1", "truth.money", "$", 0.01), _po("b", "e1", "truth.money", "$", -0.01),
        _po("c", "e1", "truth.time", "ms", 300), _po("d", "e1", "truth.time", "ms", -300),
        _po("g", "e1", "truth.utility", "points", 2), _po("h", "e1", "truth.utility", "points", -2),
    ]
    con = _source(tmp_path, ev, po)
    try:
        r = q.runs(con)[0]
        assert math.isclose(r["cost"], 0.01, abs_tol=1e-9)
        assert math.isclose(r["latency_ms"], 300, abs_tol=1e-9)
        assert math.isclose(r["utility"], 2, abs_tol=1e-9)
        assert r["invariant_ok"] is True
    finally:
        con.close()


def test_legacy_resource_accounts_still_total(tmp_path):
    # older agentic-sql names (resource.money / resource.time_ms / value.utility) still map
    ev = [_ev("e1")]
    po = [
        _po("a", "e1", "resource.money", "usd", 0.02), _po("b", "e1", "resource.money", "usd", -0.02),
        _po("c", "e1", "resource.time_ms", "ms", 50), _po("d", "e1", "resource.time_ms", "ms", -50),
        _po("g", "e1", "value.utility", "score", 1), _po("h", "e1", "value.utility", "score", -1),
    ]
    con = _source(tmp_path, ev, po)
    try:
        r = q.runs(con)[0]
        assert math.isclose(r["cost"], 0.02, abs_tol=1e-9)
        assert math.isclose(r["latency_ms"], 50, abs_tol=1e-9)
        assert math.isclose(r["utility"], 1, abs_tol=1e-9)
    finally:
        con.close()


def test_invariant_is_per_account_type_and_unit(tmp_path):
    # Same account_type, two units, each imbalanced but netting zero ACROSS units.
    # Grouping by account_type alone would falsely pass; per (account_type, unit) flags both.
    ev = [_ev("e1")]
    po = [_po("a", "e1", "truth.money", "$", 1.0), _po("b", "e1", "truth.money", "eur", -1.0)]
    con = _source(tmp_path, ev, po)
    try:
        tb = {(v["account_type"], v["unit"]) for v in q.trial_balance(con)}
        assert tb == {("truth.money", "$"), ("truth.money", "eur")}
        assert q.runs(con)[0]["invariant_ok"] is False
    finally:
        con.close()


def test_null_run_support_and_all_vs_null(tmp_path):
    # run_id is nullable. The null-run postings must attach (null-safe join), and the
    # per-run helpers must treat "omitted" (all runs) differently from "None" (the null run).
    ev = [_ev("e1", run=None, kind="ping"), _ev("e2", run="r", kind="pong")]
    po = [_po("a", "e1", "truth.money", "$", 0.01), _po("b", "e1", "truth.money", "$", -0.01)]
    con = _source(tmp_path, ev, po)
    try:
        null_row = next(r for r in q.runs(con) if r["run_id"] is None)
        assert math.isclose(null_row["cost"], 0.01, abs_tol=1e-9)  # postings attached
        assert null_row["invariant_ok"] is True
        # omitted run_id = all runs; explicit None = only the null run
        assert {r["kind"] for r in q.kind_counts(con)} == {"ping", "pong"}
        assert {r["kind"] for r in q.kind_counts(con, None)} == {"ping"}
        assert {r["kind"] for r in q.kind_counts(con, "r")} == {"pong"}
        assert q.postings_rollup(con, None)[0]["account_type"] == "truth.money"
        assert q.postings_rollup(con, "r") == []          # named run has no postings
        assert q.trial_balance(con, None) == []           # null run is balanced
    finally:
        con.close()


def test_latest_run_id(con):
    assert q.latest_run_id(con) == "run-b"


def test_latest_run_id_null_run_is_not_no_runs(tmp_path):
    # the newest run being the null run must yield None (a real selectable run), not NO_RUNS
    con = _source(tmp_path, [_ev("e1", run=None)], [])
    try:
        assert q.latest_run_id(con) is None
        assert q.latest_run_id(con) is not q.NO_RUNS
    finally:
        con.close()


def test_latest_run_id_no_runs_sentinel():
    import duckdb
    con = duckdb.connect()
    con.execute(
        "CREATE TEMP VIEW events AS "
        "SELECT NULL::VARCHAR AS run_id, NULL::TIMESTAMP AS event_time WHERE 1=0"
    )
    try:
        assert q.latest_run_id(con) is q.NO_RUNS
    finally:
        con.close()


def test_kind_counts_by_run(con):
    by_run = {}
    for row in q.kind_counts_by_run(con):
        by_run.setdefault(row["run_id"], {})[row["kind"]] = row["count"]
    assert by_run["run-a"] == {"model_prompt": 1, "model_completion": 1, "task_done": 1}
    assert by_run["run-b"] == {"model_prompt": 1, "model_completion": 1, "task_failed": 1}
