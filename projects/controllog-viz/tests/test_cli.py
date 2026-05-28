"""CLI behavior, focused on edge cases the unit tests can't reach."""
import json

from click.testing import CliRunner

from controllog_viz.cli import cli


def _write(tmp_path, events):
    cl = tmp_path / "controllog"
    cl.mkdir(parents=True)
    (cl / "events.jsonl").write_text("".join(json.dumps(e) + "\n" for e in events))


def _ev(eid, run, kind="ping"):
    return {"event_id": eid, "event_time": "2026-05-26T10:00:00+00:00",
            "ingest_time": "2026-05-26T10:00:00+00:00", "kind": kind, "project_id": "p",
            "source": "sdk", "idempotency_key": eid, "payload_json": {}, "run_id": run,
            "actor_agent_id": None, "actor_task_id": None}


def test_review_latest_renders_null_run(tmp_path):
    # The newest/only run has run_id=NULL; --latest must render it, not exit "No runs found".
    _write(tmp_path, [_ev("n1", run=None)])
    out = tmp_path / "r.html"
    res = CliRunner().invoke(cli, ["review", "--source", str(tmp_path), "--latest", "-o", str(out)])
    assert res.exit_code == 0, res.output
    assert "No runs found" not in res.output
    assert out.exists() and out.read_text().startswith("<!DOCTYPE html>")


def test_review_requires_run_selector(tmp_path):
    _write(tmp_path, [_ev("a1", run="r")])
    res = CliRunner().invoke(cli, ["review", "--source", str(tmp_path), "-o", str(tmp_path / "x.html")])
    assert res.exit_code != 0
    assert "Specify --run-id or --latest" in res.output


def test_dashboard_renders(tmp_path):
    _write(tmp_path, [_ev("a1", run="r"), _ev("a2", run="r", kind="pong")])
    out = tmp_path / "d.html"
    res = CliRunner().invoke(cli, ["dashboard", "--source", str(tmp_path), "-o", str(out)])
    assert res.exit_code == 0, res.output
    assert out.exists() and "CONTROLLOG DASHBOARD" in out.read_text()
