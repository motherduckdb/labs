from pathlib import Path

import pytest

from controllog_viz import reader

FIXTURE_DIR = Path(__file__).parent / "fixtures"
EVENT_COLS = {
    "event_id", "event_time", "ingest_time", "kind", "project_id", "source",
    "idempotency_key", "payload_json", "run_id", "actor_agent_id", "actor_task_id",
}
POSTING_COLS = {
    "posting_id", "event_id", "account_type", "account_id", "unit", "delta_numeric", "dims_json",
}


def _columns(con, view):
    return {row[0] for row in con.execute(f"DESCRIBE {view}").fetchall()}


def test_views_expose_contract_columns(con):
    assert _columns(con, "events") == EVENT_COLS
    assert _columns(con, "postings") == POSTING_COLS


def test_event_and_posting_counts(con):
    assert con.execute("SELECT COUNT(*) FROM events").fetchone()[0] == 6
    assert con.execute("SELECT COUNT(*) FROM postings").fetchone()[0] == 15


def test_payload_json_is_normalized_json(con):
    # JSON type means we can extract a field with the JSON arrow operator.
    answer = con.execute(
        "SELECT payload_json->>'answer' FROM events WHERE event_id = 'e2'"
    ).fetchone()[0]
    assert answer == "yo"


def test_event_time_is_timestamp(con):
    col_type = con.execute("DESCRIBE events").fetchall()
    types = {name: dtype for name, dtype, *_ in col_type}
    assert "TIMESTAMP" in types["event_time"].upper()


def test_directory_resolves_recursively_to_events_glob():
    # A bare directory should find tests/fixtures/controllog/events.jsonl.
    con = reader.connect(str(FIXTURE_DIR))
    try:
        assert con.execute("SELECT COUNT(*) FROM events").fetchone()[0] == 6
    finally:
        con.close()


def test_direct_events_file_path_finds_sibling_postings():
    con = reader.connect(str(FIXTURE_DIR / "controllog" / "events.jsonl"))
    try:
        assert con.execute("SELECT COUNT(*) FROM postings").fetchone()[0] == 15
    finally:
        con.close()


def test_missing_source_raises():
    with pytest.raises(FileNotFoundError):
        reader.connect(str(FIXTURE_DIR / "does-not-exist"))


def test_jsonl_dedupes_by_id(tmp_path):
    # Idempotent retries repeat the same event_id / posting_id locally; the reader must
    # collapse them (one row per id), matching MotherDuck's primary-key dedupe, so a
    # source renders the same before and after upload.
    cl = tmp_path / "controllog"
    cl.mkdir(parents=True)
    ev = (
        '{"event_id":"d1","event_time":"2026-05-26T10:00:00+00:00",'
        '"ingest_time":"2026-05-26T10:00:00+00:00","kind":"k","project_id":"p",'
        '"source":"sdk","idempotency_key":"d1","payload_json":{},"run_id":"r",'
        '"actor_agent_id":null,"actor_task_id":null}\n'
    )
    # second copy with a later ingest_time (the retry)
    ev2 = ev.replace("10:00:00+00:00\",\"ingest_time\":\"2026-05-26T10:00:00",
                     "10:00:00+00:00\",\"ingest_time\":\"2026-05-26T10:00:05")
    (cl / "events.jsonl").write_text(ev + ev2)
    po = (
        '{"posting_id":"pp","event_id":"d1","account_type":"truth.money","account_id":"x",'
        '"unit":"$","delta_numeric":0.01,"dims_json":{}}\n'
    )
    (cl / "postings.jsonl").write_text(po + po)  # exact duplicate posting
    con = reader.connect(str(tmp_path))
    try:
        assert con.execute("SELECT COUNT(*) FROM events").fetchone()[0] == 1
        assert con.execute("SELECT COUNT(*) FROM postings").fetchone()[0] == 1
    finally:
        con.close()


def test_empty_postings_file_treated_as_no_postings(tmp_path):
    # A zero-byte postings.jsonl must not be sent to read_json_auto (can't infer columns).
    cl = tmp_path / "controllog"
    cl.mkdir(parents=True)
    (cl / "events.jsonl").write_text(
        '{"event_id":"x1","event_time":"2026-05-26T10:00:00+00:00",'
        '"ingest_time":"2026-05-26T10:00:00+00:00","kind":"ping","project_id":"d",'
        '"source":"sdk","idempotency_key":"x1","payload_json":{},"run_id":"r",'
        '"actor_agent_id":null,"actor_task_id":null}\n'
    )
    (cl / "postings.jsonl").write_text("")  # empty file present
    con = reader.connect(str(tmp_path))
    try:
        assert con.execute("SELECT COUNT(*) FROM events").fetchone()[0] == 1
        assert con.execute("SELECT COUNT(*) FROM postings").fetchone()[0] == 0
    finally:
        con.close()


def test_missing_postings_yields_empty_view(tmp_path):
    # Events only, no postings.jsonl — postings view should exist and be empty.
    cl = tmp_path / "controllog"
    cl.mkdir(parents=True)
    (cl / "events.jsonl").write_text(
        '{"event_id":"x1","event_time":"2026-05-26T10:00:00+00:00",'
        '"ingest_time":"2026-05-26T10:00:00+00:00","kind":"ping","project_id":"d",'
        '"source":"sdk","idempotency_key":"x1","payload_json":{},"run_id":"r",'
        '"actor_agent_id":null,"actor_task_id":null}\n'
    )
    con = reader.connect(str(tmp_path))
    try:
        assert con.execute("SELECT COUNT(*) FROM events").fetchone()[0] == 1
        assert con.execute("SELECT COUNT(*) FROM postings").fetchone()[0] == 0
    finally:
        con.close()
