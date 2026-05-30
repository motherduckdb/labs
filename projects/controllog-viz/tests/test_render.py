from controllog_viz import render


def test_run_review_renders(con):
    html = render.render_run_review(con, "run-a")
    assert html.startswith("<!DOCTYPE html>")
    assert "RUN REVIEW" in html
    assert "run-a" in html
    # kinds present in the timeline
    assert "model_completion" in html
    # postings rollup surfaced
    assert "truth.money" in html
    # run-a is balanced
    assert "invariants balanced" in html


def test_run_review_flags_unbalanced_run(con):
    html = render.render_run_review(con, "run-b")
    assert "invariant violation" in html
    # the violating net value is shown
    assert "truth.money" in html


def test_run_review_escapes_payload(con):
    # e6 payload contains '<boom> & fail' — must be HTML-escaped, not raw.
    html = render.render_run_review(con, "run-b")
    assert "&lt;boom&gt; &amp; fail" in html
    assert "<boom>" not in html


def test_dashboard_renders(con):
    html = render.render_dashboard(con, "fixtures")
    assert html.startswith("<!DOCTYPE html>")
    assert "CONTROLLOG DASHBOARD" in html
    # both runs in the runs table
    assert "run-a" in html and "run-b" in html
    # charts present
    assert "<svg" in html
    assert "Cost per run" in html
    # global invariant violation surfaced
    assert "net (should be 0)" in html


def test_dashboard_empty_source(tmp_path):
    from controllog_viz import reader
    cl = tmp_path / "controllog"
    cl.mkdir(parents=True)
    (cl / "events.jsonl").write_text(
        '{"event_id":"z1","event_time":"2026-05-26T10:00:00+00:00",'
        '"ingest_time":"2026-05-26T10:00:00+00:00","kind":"ping","project_id":"d",'
        '"source":"sdk","idempotency_key":"z1","payload_json":{},"run_id":"solo",'
        '"actor_agent_id":null,"actor_task_id":null}\n'
    )
    con = reader.connect(str(tmp_path))
    try:
        html = render.render_dashboard(con, "solo")
        assert "CONTROLLOG DASHBOARD" in html
        assert "solo" in html
        # single-run line chart degrades gracefully, no crash
        assert "single run" in html
    finally:
        con.close()
