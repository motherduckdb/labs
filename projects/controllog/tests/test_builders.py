"""Tests for controllog.builders — model_prompt/completion, state_move, utility."""
from __future__ import annotations

import pytest

import controllog


# -------------------------
# model_prompt / model_completion (spec § 5: two-phase, shared exchange_id)
# -------------------------


def test_model_prompt_returns_exchange_id(log_dir):
    xid = controllog.model_prompt(
        task_id="t1", agent_id="a", run_id="r",
        provider="openai", model="gpt-5", prompt_tokens=100,
    )
    assert isinstance(xid, str)
    # UUIDv7-ish
    import uuid
    uuid.UUID(xid)


def test_model_prompt_and_completion_share_exchange_id(log_dir, read_events):
    xid = controllog.model_prompt(
        task_id="t1", agent_id="a", run_id="r",
        provider="openai", model="gpt-5", prompt_tokens=100,
    )
    controllog.model_completion(
        exchange_id=xid,
        task_id="t1", agent_id="a", run_id="r",
        provider="openai", model="gpt-5", completion_tokens=10, wall_ms=500,
    )
    events = read_events()
    kinds = {e["kind"] for e in events}
    assert kinds == {"model_prompt", "model_completion"}
    xids = {e["payload_json"]["exchange_id"] for e in events}
    assert xids == {xid}


def test_model_completion_requires_exchange_id(log_dir):
    with pytest.raises(TypeError):
        controllog.model_completion(  # type: ignore[call-arg]
            task_id="t1", agent_id="a", run_id="r",
            provider="openai", model="gpt-5", completion_tokens=10, wall_ms=500,
        )


def test_model_call_idempotency_keys_use_exchange_id(log_dir, read_events):
    """Spec § 5.1 — idempotency keys are {exchange_id}:prompt and :completion."""
    xid = controllog.model_prompt(
        task_id="t1", agent_id="a", run_id="r",
        provider="openai", model="gpt-5", prompt_tokens=10,
    )
    controllog.model_completion(
        exchange_id=xid,
        task_id="t1", agent_id="a", run_id="r",
        provider="openai", model="gpt-5", completion_tokens=5, wall_ms=100,
    )
    events = read_events()
    by_kind = {e["kind"]: e for e in events}
    assert by_kind["model_prompt"]["idempotency_key"] == f"{xid}:prompt"
    assert by_kind["model_completion"]["idempotency_key"] == f"{xid}:completion"


def test_canonical_fields_override_caller_payload(log_dir, read_events):
    """A stray payload={"phase": "completion"} on model_prompt must not flip
    the event's recorded phase — postings already say 'prompt'."""
    controllog.model_prompt(
        task_id="t1", agent_id="a",
        provider="openai", model="gpt-5", prompt_tokens=100,
        payload={"phase": "completion", "provider": "anthropic", "extra": "kept"},
    )
    e = read_events()[0]
    assert e["payload_json"]["phase"] == "prompt"
    assert e["payload_json"]["provider"] == "openai"
    # Non-conflicting caller keys still pass through
    assert e["payload_json"]["extra"] == "kept"


def test_model_completion_postings_balance(log_dir, read_postings):
    """Tokens, time, money must all sum to zero per (account_type, unit)."""
    xid = controllog.model_prompt(
        task_id="t1", agent_id="a", run_id="r",
        provider="openai", model="gpt-5", prompt_tokens=100,
    )
    controllog.model_completion(
        exchange_id=xid,
        task_id="t1", agent_id="a", run_id="r",
        provider="openai", model="gpt-5", completion_tokens=10, wall_ms=500,
        cost_money=0.002,
    )
    by_key: dict[tuple[str, str], float] = {}
    for p in read_postings():
        key = (p["account_type"], p["unit"])
        by_key[key] = by_key.get(key, 0.0) + p["delta_numeric"]
    # Every (account_type, unit) must sum to zero
    assert all(abs(v) < 1e-9 for v in by_key.values()), by_key


# -------------------------
# state_move (spec § 6 — exactly-once lifecycle)
# -------------------------


def test_state_move_default_idempotency_key(log_dir, read_events):
    controllog.state_move(task_id="t1", from_="NEW", to="WIP")
    e = read_events()[0]
    assert e["idempotency_key"] == "t1:NEW:WIP"


def test_state_move_retry_collapses_event_id(log_dir, read_events):
    """Retried state_move keeps same event_id so MD PK dedupes on upload."""
    controllog.state_move(task_id="t1", from_="NEW", to="WIP")
    controllog.state_move(task_id="t1", from_="NEW", to="WIP")
    events = read_events()
    assert len(events) == 2  # local JSONL keeps both rows
    assert events[0]["event_id"] == events[1]["event_id"]


def test_state_move_different_transitions_distinct(log_dir, read_events):
    controllog.state_move(task_id="t1", from_="NEW", to="WIP")
    controllog.state_move(task_id="t1", from_="WIP", to="DONE")
    events = read_events()
    keys = {e["idempotency_key"] for e in events}
    assert keys == {"t1:NEW:WIP", "t1:WIP:DONE"}


def test_state_move_custom_idempotency_key(log_dir, read_events):
    controllog.state_move(
        task_id="t1", from_="NEW", to="WIP",
        idempotency_key="custom-key",
    )
    assert read_events()[0]["idempotency_key"] == "custom-key"


# -------------------------
# utility
# -------------------------


def test_utility_balances(log_dir, read_postings):
    controllog.utility(task_id="t1", metric="reward", value=0.7)
    p = read_postings()
    assert len(p) == 2
    assert all(row["account_type"] == "truth.utility" for row in p)
    assert sum(row["delta_numeric"] for row in p) == pytest.approx(0.0)


def test_utility_omits_payload_when_none(log_dir, read_events):
    """metric and value are already on the postings — no need for a payload placeholder."""
    controllog.utility(task_id="t1", metric="reward", value=1.0)
    e = read_events()[0]
    # No {"metric": ..., "value": ...} placeholder when caller passes no payload
    assert e["payload_json"] == {}


# -------------------------
# vendor account uses provider (not hardcoded openrouter)
# -------------------------


def test_cost_posting_uses_provider_argument(log_dir, read_postings):
    """truth.money should land on vendor:{provider}, not vendor:openrouter."""
    xid = controllog.model_prompt(
        task_id="t1", agent_id="a",
        provider="anthropic", model="claude-sonnet", prompt_tokens=100,
    )
    controllog.model_completion(
        exchange_id=xid,
        task_id="t1", agent_id="a",
        provider="anthropic", model="claude-sonnet",
        completion_tokens=10, wall_ms=500, cost_money=0.005,
    )
    money_postings = [p for p in read_postings() if p["account_type"] == "truth.money"]
    vendors = {p["account_id"] for p in money_postings if p["account_id"].startswith("vendor:")}
    assert vendors == {"vendor:anthropic"}, f"unexpected vendors: {vendors}"


# -------------------------
# project_id resolution
# -------------------------


def test_builders_use_configured_project_id(log_dir, read_postings):
    """Builders pull project_id from init() rather than per-call kwargs."""
    controllog.utility(task_id="t1", metric="reward", value=1.0)
    project_postings = [p for p in read_postings() if p["account_id"].startswith("project:")]
    assert all(p["account_id"] == "project:test" for p in project_postings)


def test_builders_reject_per_call_project_id(log_dir):
    """project_id was dropped; passing it is now a TypeError."""
    with pytest.raises(TypeError):
        controllog.state_move(  # type: ignore[call-arg]
            task_id="t1", from_="NEW", to="WIP", project_id="other",
        )


def test_builders_raise_when_init_missing(tmp_path):
    """Calling a builder before init() surfaces RuntimeError, not AttributeError."""
    # autouse fixture clears _config; no init() call here
    with pytest.raises(RuntimeError, match="init"):
        controllog.utility(task_id="t1", metric="reward", value=1.0)


# -------------------------
# No placeholder payloads
# -------------------------


def test_state_move_omits_payload_when_none(log_dir, read_events):
    """Spec § 6 transitions shouldn't carry a placeholder reason=null."""
    controllog.state_move(task_id="t1", from_="NEW", to="WIP")
    e = read_events()[0]
    assert "reason" not in e["payload_json"]
    assert e["payload_json"] == {}


def test_state_move_preserves_caller_payload(log_dir, read_events):
    controllog.state_move(
        task_id="t1", from_="NEW", to="WIP",
        payload={"reason": "operator-resumed"},
    )
    assert read_events()[0]["payload_json"]["reason"] == "operator-resumed"
