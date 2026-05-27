"""Tests for controllog.motherduck — runs against an in-memory DuckDB.

The real MotherDuck client connects via ``duckdb.connect("md:...")``; we
monkeypatch ``_connect`` to hand back an in-memory DuckDB instance so the
SQL paths (table creation, upload dedupe, ID verification) run end-to-end
without a MotherDuck token.
"""
from __future__ import annotations

from pathlib import Path

import duckdb
import pytest

import controllog
from controllog import motherduck


class _SharedConn:
    """Proxy that no-ops close() so the in-memory DB survives across calls.

    motherduck.upload / verify / cleanup_local each wrap their work in
    ``try / finally: md.close()``. DuckDB connection attributes are
    read-only, so we proxy instead of patching.
    """

    def __init__(self, conn):
        self._conn = conn

    def __getattr__(self, name):
        return getattr(self._conn, name)

    def close(self):
        pass  # leave the underlying conn alive for the test


@pytest.fixture
def md_conn(monkeypatch):
    """In-memory DuckDB that mimics MotherDuck across multiple calls."""
    real_conn = duckdb.connect(":memory:")
    proxy = _SharedConn(real_conn)
    monkeypatch.setattr(motherduck, "_connect", lambda *a, **k: proxy)
    yield real_conn
    real_conn.close()


def _emit_sample(project: str = "test") -> str:
    """Emit one paired model call. Returns the exchange_id."""
    xid = controllog.model_prompt(
        task_id="t1", agent_id="a", run_id="r",
        provider="openai", model="gpt-5", prompt_tokens=100,
    )
    controllog.model_completion(
        exchange_id=xid,
        task_id="t1", agent_id="a", run_id="r",
        provider="openai", model="gpt-5",
        completion_tokens=10, wall_ms=500, cost_money=0.002,
    )
    return xid


# -------------------------
# upload()
# -------------------------


def test_upload_creates_schema_and_inserts(log_dir, md_conn):
    _emit_sample()
    result = motherduck.upload(motherduck_db="x", log_dir=log_dir)
    assert result["events"] == 2
    assert result["postings"] > 0

    assert md_conn.execute("SELECT COUNT(*) FROM controllog.events").fetchone()[0] == 2
    n_postings = md_conn.execute("SELECT COUNT(*) FROM controllog.postings").fetchone()[0]
    assert n_postings > 0


def test_upload_is_idempotent(log_dir, md_conn):
    _emit_sample()
    first = motherduck.upload(motherduck_db="x", log_dir=log_dir)
    second = motherduck.upload(motherduck_db="x", log_dir=log_dir)
    # Second pass inserts nothing — same IDs already there
    assert second["events"] == 0
    assert second["postings"] == 0
    # Total still matches first pass
    assert md_conn.execute("SELECT COUNT(*) FROM controllog.events").fetchone()[0] == first["events"]


def test_upload_handles_duplicate_local_rows(log_dir, md_conn, read_events):
    """Retries write duplicate event_ids locally — QUALIFY ROW_NUMBER dedupes
    inside the batch so the PRIMARY KEY constraint doesn't reject the INSERT."""
    # Two retries of the same state transition → same event_id on disk
    controllog.state_move(task_id="t1", from_="NEW", to="WIP")
    controllog.state_move(task_id="t1", from_="NEW", to="WIP")
    events = read_events()
    assert len(events) == 2
    assert events[0]["event_id"] == events[1]["event_id"]

    result = motherduck.upload(motherduck_db="x", log_dir=log_dir)
    assert result["events"] == 1
    assert md_conn.execute("SELECT COUNT(*) FROM controllog.events").fetchone()[0] == 1


def test_upload_raises_on_missing_files(log_dir, md_conn):
    with pytest.raises(FileNotFoundError):
        motherduck.upload(motherduck_db="x", log_dir=log_dir)


# -------------------------
# verify()
# -------------------------


def test_verify_reports_counts_and_kinds(log_dir, md_conn):
    _emit_sample()
    motherduck.upload(motherduck_db="x", log_dir=log_dir)
    out = motherduck.verify(motherduck_db="x")

    assert out["events"] == 2
    assert out["postings"] > 0
    assert out["event_kinds"] == {"model_prompt": 1, "model_completion": 1}
    # Per spec § 8.2 trial balance: no violations on a clean upload
    assert out["trial_balance_violations"] == []


def test_verify_catches_trial_balance_violation(log_dir, md_conn):
    """If postings.dims_json gets corrupted s.t. totals don't net to zero,
    verify() must surface the slice that's off."""
    _emit_sample()
    motherduck.upload(motherduck_db="x", log_dir=log_dir)
    # Manually insert an unbalanced posting (bypassing the SDK)
    md_conn.execute("""
        INSERT INTO controllog.postings VALUES (
            'bad-id', 'unknown-event', 'truth.money', 'project:test',
            '$', 99.99, '{}'::JSON
        )
    """)
    out = motherduck.verify(motherduck_db="x")
    assert any(v["account_type"] == "truth.money" for v in out["trial_balance_violations"])


# -------------------------
# cleanup_local()
# -------------------------


def test_cleanup_local_deletes_after_verification(log_dir, md_conn):
    _emit_sample()
    motherduck.upload(motherduck_db="x", log_dir=log_dir)

    events_file = log_dir / "controllog" / "events.jsonl"
    postings_file = log_dir / "controllog" / "postings.jsonl"
    assert events_file.exists() and postings_file.exists()

    result = motherduck.cleanup_local(log_dir=log_dir, motherduck_db="x")
    assert result["files_deleted"] == 2
    assert not events_file.exists()
    assert not postings_file.exists()


def test_cleanup_local_refuses_when_ids_missing(log_dir, md_conn):
    """Naïve count comparison would pass spuriously if unrelated rows exist.
    Per-ID verification must catch this."""
    _emit_sample()
    # Don't upload. Instead, plant unrelated rows so the remote count >= local count.
    motherduck.upload(motherduck_db="x", log_dir=log_dir)  # populates schema
    md_conn.execute("DELETE FROM controllog.events")
    md_conn.execute("DELETE FROM controllog.postings")
    md_conn.execute("""
        INSERT INTO controllog.events VALUES (
            'unrelated-1', NOW(), NOW(), 'x', 'other', 'sdk', 'k1', '{}'::JSON,
            NULL, NULL, NULL
        )
    """)
    md_conn.execute("""
        INSERT INTO controllog.events VALUES (
            'unrelated-2', NOW(), NOW(), 'x', 'other', 'sdk', 'k2', '{}'::JSON,
            NULL, NULL, NULL
        )
    """)

    with pytest.raises(RuntimeError, match="not present"):
        motherduck.cleanup_local(log_dir=log_dir, motherduck_db="x")
    # Files still on disk
    assert (log_dir / "controllog" / "events.jsonl").exists()


def test_cleanup_local_dry_run(log_dir, md_conn):
    _emit_sample()
    motherduck.upload(motherduck_db="x", log_dir=log_dir)
    result = motherduck.cleanup_local(log_dir=log_dir, motherduck_db="x", dry_run=True)
    assert result["dry_run"] is True
    assert result["files_deleted"] == 0
    assert (log_dir / "controllog" / "events.jsonl").exists()


def test_cleanup_local_skip_verification(log_dir, md_conn):
    _emit_sample()
    # No upload — verify_uploaded=False bypasses the check
    result = motherduck.cleanup_local(
        log_dir=log_dir, motherduck_db="x", verify_uploaded=False
    )
    assert result["files_deleted"] == 2


def test_cleanup_local_empty_dir_is_true_no_op(tmp_path, monkeypatch):
    """No JSONL → no MotherDuck connection should be opened at all."""
    calls = []
    monkeypatch.setattr(
        motherduck, "_connect",
        lambda *a, **k: calls.append((a, k)) or (_ for _ in ()).throw(
            AssertionError("should not connect on empty dir")
        ),
    )
    # No init(), no files written — dir is bare.
    result = motherduck.cleanup_local(log_dir=tmp_path, motherduck_db="x")
    assert calls == []
    assert result["files_deleted"] == 0
    assert result["local_events"] == 0


# -------------------------
# Schema is hardcoded per spec §10.1
# -------------------------


def test_schema_is_hardcoded(log_dir, md_conn):
    """The library writes to controllog.events / controllog.postings — no override."""
    _emit_sample()
    motherduck.upload(motherduck_db="x", log_dir=log_dir)
    n = md_conn.execute("SELECT COUNT(*) FROM controllog.events").fetchone()[0]
    assert n == 2
    # No schema= kwarg accepted on any public function
    with pytest.raises(TypeError):
        motherduck.upload(motherduck_db="x", log_dir=log_dir, schema="other")  # type: ignore[call-arg]
