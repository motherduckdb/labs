"""Tests for controllog.sdk — init / event / post / invariants / idempotency."""
from __future__ import annotations

from pathlib import Path

import pytest

import controllog


# -------------------------
# init() and layout
# -------------------------


def test_init_required_before_use(tmp_path):
    """Use RuntimeError (not assert) so the check survives python -O."""
    with pytest.raises(RuntimeError, match="init"):
        controllog.event(kind="x", postings=[])


def test_is_initialized_round_trip(tmp_path):
    assert controllog.is_initialized() is False
    controllog.init(project_id="t", log_dir=tmp_path)
    assert controllog.is_initialized() is True


def test_flat_layout_is_default(log_dir):
    controllog.state_move(task_id="t1", from_="NEW", to="WIP", project_id="test")
    assert (log_dir / "controllog" / "events.jsonl").exists()
    assert not list((log_dir / "controllog").glob("20*/events.jsonl"))


def test_partition_by_date(tmp_path):
    controllog.init(project_id="t", log_dir=tmp_path, partition_by_date=True)
    controllog.state_move(task_id="t1", from_="NEW", to="WIP", project_id="t")
    found = list((tmp_path / "controllog").glob("*/events.jsonl"))
    assert len(found) == 1, found


# -------------------------
# new_id() / UUIDv7
# -------------------------


def test_new_id_is_uuid7_and_sortable():
    import time
    ids = []
    for _ in range(5):
        ids.append(controllog.new_id())
        time.sleep(0.002)
    # Sortable by time
    assert ids == sorted(ids)
    # UUID format
    import uuid
    for s in ids:
        u = uuid.UUID(s)
        assert u.version == 7


# -------------------------
# post()
# -------------------------


def test_post_returns_only_accounting_fields():
    p = controllog.post("truth.state", "task:t1", "tasks", -1, {"from": "NEW"})
    assert set(p.keys()) == {"account_type", "account_id", "unit", "delta_numeric", "dims_json"}
    assert p["delta_numeric"] == -1.0  # coerced to float
    assert p["dims_json"] == {"from": "NEW"}


def test_post_dims_default_empty():
    p = controllog.post("x", "y", "z", 1)
    assert p["dims_json"] == {}


# -------------------------
# Invariants (§ 8.1)
# -------------------------


def test_balanced_postings_pass(log_dir, read_postings):
    controllog.event(
        kind="t",
        postings=[
            controllog.post("truth.state", "task:1", "tasks", -1),
            controllog.post("truth.state", "task:1", "tasks", +1),
        ],
    )
    assert len(read_postings()) == 2


def test_unbalanced_postings_raise(log_dir):
    with pytest.raises(ValueError, match="UNBALANCED_POSTINGS"):
        controllog.event(
            kind="t",
            postings=[
                controllog.post("truth.state", "task:1", "tasks", -1),
                controllog.post("truth.state", "task:1", "tasks", +2),  # net=+1
            ],
        )


def test_custom_account_namespace_still_balanced(log_dir):
    """Spec § 8.1 — every account_type, including extensions, must balance."""
    with pytest.raises(ValueError, match="mydomain.custom"):
        controllog.event(
            kind="t",
            postings=[
                controllog.post("mydomain.custom", "a", "units", 1.0),
                controllog.post("mydomain.custom", "b", "units", 2.0),  # net=+3
            ],
        )


def test_separate_units_balanced_independently(log_dir, read_postings):
    """Two account_types or two units don't 'borrow' from each other."""
    with pytest.raises(ValueError, match="UNBALANCED_POSTINGS"):
        controllog.event(
            kind="t",
            postings=[
                controllog.post("truth.state", "task:1", "tasks", -1),
                controllog.post("truth.state", "task:1", "tasks", +1),
                controllog.post("truth.money", "vendor:x", "$", -1.0),
                # missing: matching +1.0 to project on truth.money
            ],
        )


def test_empty_postings_no_invariant(log_dir, read_events):
    """Events with no postings are valid (lifecycle markers per spec § 15)."""
    controllog.event(kind="marker", postings=[], idempotency_key="m1")
    assert len(read_events()) == 1


# -------------------------
# default_dims (must land in payload_json / dims_json, not top-level)
# -------------------------


def test_default_dims_merge_into_payload_and_dims(tmp_path, read_events, read_postings):
    controllog.init(
        project_id="t",
        log_dir=tmp_path,
        default_dims={"arm": "baseline", "split": "train"},
    )
    controllog.event(
        kind="x",
        payload={"q": 42},
        postings=[
            controllog.post("truth.state", "task:1", "tasks", -1, {"from": "NEW"}),
            controllog.post("truth.state", "task:1", "tasks", +1, {"to": "WIP"}),
        ],
    )
    e = read_events()[0]
    # NOT spread at top level
    assert "arm" not in e
    assert "split" not in e
    # Merged into payload_json
    assert e["payload_json"]["arm"] == "baseline"
    assert e["payload_json"]["split"] == "train"
    assert e["payload_json"]["q"] == 42

    # Merged into each posting's dims_json
    p = read_postings()
    assert all(row["dims_json"]["arm"] == "baseline" for row in p)
    assert all(row["dims_json"]["split"] == "train" for row in p)
    # Per-posting dims preserved alongside defaults
    assert {row["dims_json"].get("from") or row["dims_json"].get("to") for row in p} == {"NEW", "WIP"}


def test_payload_dim_overrides_default(tmp_path, read_events):
    controllog.init(project_id="t", log_dir=tmp_path, default_dims={"arm": "baseline"})
    controllog.event(kind="x", payload={"arm": "overridden"}, postings=[])
    assert read_events()[0]["payload_json"]["arm"] == "overridden"


# -------------------------
# Idempotency (§ 11)
# -------------------------


def test_deterministic_event_id_from_idempotency_key(log_dir, read_events):
    """Same project + idempotency_key → same event_id (so MD PK dedupes on upload)."""
    controllog.event(kind="x", postings=[], idempotency_key="abc")
    controllog.event(kind="x", postings=[], idempotency_key="abc")  # retry

    events = read_events()
    assert len(events) == 2  # both rows on disk (process doesn't dedupe locally)
    assert events[0]["event_id"] == events[1]["event_id"]


def test_deterministic_posting_id_from_idempotency_key(log_dir, read_postings):
    """Posting IDs collapse on retry too — otherwise dedupe at upload fails."""
    for _ in range(2):
        controllog.event(
            kind="x",
            idempotency_key="k1",
            postings=[
                controllog.post("truth.state", "task:1", "tasks", -1),
                controllog.post("truth.state", "task:1", "tasks", +1),
            ],
        )
    p = read_postings()
    # 4 rows on disk, but only 2 distinct posting_ids
    assert len(p) == 4
    assert len({row["posting_id"] for row in p}) == 2


def test_event_id_differs_across_projects(tmp_path):
    """Same idempotency_key under different project_id must NOT collide."""
    controllog.init(project_id="p1", log_dir=tmp_path)
    controllog.event(kind="x", postings=[], idempotency_key="abc")
    e1_id = (tmp_path / "controllog" / "events.jsonl").read_text().splitlines()[-1]

    controllog.init(project_id="p2", log_dir=tmp_path)
    controllog.event(kind="x", postings=[], idempotency_key="abc")
    e2_id = (tmp_path / "controllog" / "events.jsonl").read_text().splitlines()[-1]

    import json
    assert json.loads(e1_id)["event_id"] != json.loads(e2_id)["event_id"]


def test_no_idempotency_key_gets_random_id(log_dir, read_events):
    """Without idempotency_key, each call gets a fresh random event_id."""
    controllog.event(kind="x", postings=[])
    controllog.event(kind="x", postings=[])
    events = read_events()
    assert events[0]["event_id"] != events[1]["event_id"]
