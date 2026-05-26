"""Controllog: structured event logging with balanced double-entry postings.

Events capture what happened. Postings capture the balanced accounting of
resources (tokens, time, money) and state changes. Every posting set must
balance to zero per (account_type, unit) — enforced at write time.

Account types:
  - resource.tokens: provider <-> project (conservation of tokens)
  - resource.time_ms: agent <-> project (conservation of wall time)
  - resource.money: vendor <-> project (conservation of money)
  - truth.state: task state transitions (balanced +1/-1)
"""

import json
import os
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from eval_shared import locked_file


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

@dataclass
class _Config:
    project_id: str
    log_dir: Path
    default_dims: dict[str, Any] = field(default_factory=dict)


_config: Optional[_Config] = None


def init(project_id: str, log_dir: Path, default_dims: Optional[dict[str, Any]] = None) -> None:
    """Initialize controllog. Must be called before emitting events."""
    global _config
    log_dir = Path(log_dir)
    log_dir.mkdir(parents=True, exist_ok=True)
    _config = _Config(project_id=project_id, log_dir=log_dir, default_dims=default_dims or {})


# ---------------------------------------------------------------------------
# JSONL transport
# ---------------------------------------------------------------------------

def _date_partition_dir(base: Path) -> Path:
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    part = base / "controllog" / today
    part.mkdir(parents=True, exist_ok=True)
    return part


def _events_file() -> Path:
    assert _config is not None, "controllog.init() must be called first"
    return _date_partition_dir(_config.log_dir) / "events.jsonl"


def _postings_file() -> Path:
    assert _config is not None, "controllog.init() must be called first"
    return _date_partition_dir(_config.log_dir) / "postings.jsonl"


def _write_jsonl(path: Path, obj: dict[str, Any]) -> None:
    with locked_file(path, mode="a", encoding="utf-8") as locked:
        locked.handle.write(json.dumps(obj, ensure_ascii=False) + "\n")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _uuid7_str() -> str:
    """Generate a UUIDv7 (time-sortable) without requiring stdlib uuid7."""
    ts_ms = int(time.time() * 1000) & ((1 << 48) - 1)
    rand_a = int.from_bytes(os.urandom(2), "big") & 0x0FFF
    rand_b = int.from_bytes(os.urandom(8), "big")

    b = bytearray(16)
    b[0:6] = ts_ms.to_bytes(6, "big")
    b[6] = 0x70 | ((rand_a >> 8) & 0x0F)
    b[7] = rand_a & 0xFF
    b[8] = 0x80 | ((rand_b >> 56) & 0x3F)
    lower_56 = rand_b & ((1 << 56) - 1)
    for i in range(7):
        b[9 + i] = (lower_56 >> ((6 - i) * 8)) & 0xFF

    return str(uuid.UUID(bytes=bytes(b)))


# ---------------------------------------------------------------------------
# Core primitives
# ---------------------------------------------------------------------------

def new_id() -> str:
    """Public UUIDv7 generator for correlation IDs."""
    return _uuid7_str()


def post(
    account_type: str, account_id: str, unit: str, delta: float,
    dims: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    """Create a posting line. Caller passes these to event()."""
    return {
        "posting_id": _uuid7_str(),
        "event_id": None,  # filled by event()
        "account_type": account_type,
        "account_id": account_id,
        "unit": unit,
        "delta_numeric": float(delta),
        "dims_json": dims or {},
    }


def _check_invariants(kind: str, postings: list[dict[str, Any]]) -> None:
    """Enforce double-entry balance: sum(delta) must be zero per (account_type, unit)."""
    if not postings:
        return
    sums: dict[tuple, float] = {}
    for p in postings:
        key = (p["account_type"], p["unit"])
        sums[key] = sums.get(key, 0.0) + float(p["delta_numeric"])

    for (acct, unit), total in sums.items():
        if acct.startswith("resource.") or acct in ("value.utility", "truth.state"):
            if abs(total) > 1e-9:
                raise ValueError(f"UNBALANCED: {acct}/{unit} net={total} in event kind={kind}")


def event(
    *, kind: str, actor: Optional[dict[str, str]] = None,
    run_id: Optional[str] = None, payload: Optional[dict[str, Any]] = None,
    postings: Optional[list[dict[str, Any]]] = None,
    project_id: Optional[str] = None, source: str = "sdk",
    idempotency_key: Optional[str] = None,
) -> dict[str, Any]:
    """Emit a structured event with balanced postings to JSONL."""
    assert _config is not None, "controllog.init() must be called first"

    event_id = _uuid7_str()
    postings = postings or []
    _check_invariants(kind, postings)

    event_row = {
        "event_id": event_id, "event_time": _now_iso(), "ingest_time": _now_iso(),
        "kind": kind,
        "actor_agent_id": (actor or {}).get("agent_id"),
        "actor_task_id": (actor or {}).get("task_id"),
        "project_id": project_id or _config.project_id,
        "run_id": run_id, "source": source,
        "idempotency_key": idempotency_key or event_id,
        "payload_json": {**(payload or {})},
    }
    _write_jsonl(_events_file(), {**_config.default_dims, **event_row})

    for p in postings:
        p_out = dict(p)
        p_out["event_id"] = event_id
        _write_jsonl(_postings_file(), {**_config.default_dims, **p_out})

    return event_row


# ---------------------------------------------------------------------------
# High-level builders
# ---------------------------------------------------------------------------

def model_prompt(
    *, task_id: str, agent_id: str, run_id: Optional[str],
    project_id: Optional[str], provider: str, model: str,
    prompt_tokens: int, request_text: Optional[str] = None,
    payload: Optional[dict[str, Any]] = None, exchange_id: Optional[str] = None,
) -> None:
    """Emit a model_prompt event with balanced token postings."""
    postings = [
        post("resource.tokens", f"provider:{provider}", "+tokens", -int(prompt_tokens or 0), {"model": model, "phase": "prompt"}),
        post("resource.tokens", f"project:{project_id}", "+tokens", +int(prompt_tokens or 0), {"model": model, "phase": "prompt"}),
    ]
    payload_base: dict[str, Any] = {"provider": provider, "model": model, "prompt_tokens": prompt_tokens, "phase": "prompt"}
    if request_text is not None:
        payload_base["request_text"] = request_text
    if exchange_id is None:
        exchange_id = new_id()
    event(
        kind="model_prompt", actor={"agent_id": agent_id, "task_id": task_id},
        run_id=run_id, payload={**payload_base, **(payload or {}), "exchange_id": exchange_id},
        postings=postings, project_id=project_id, source="runtime",
        idempotency_key=f"{exchange_id}:prompt",
    )


def model_completion(
    *, task_id: str, agent_id: str, run_id: Optional[str],
    project_id: Optional[str], provider: str, model: str,
    completion_tokens: int, wall_ms: int,
    response_text: Optional[str] = None, cost_money: Optional[float] = None,
    payload: Optional[dict[str, Any]] = None, exchange_id: Optional[str] = None,
) -> None:
    """Emit a model_completion event with tokens, time, and optional cost postings."""
    postings = [
        post("resource.tokens", f"provider:{provider}", "+tokens", -int(completion_tokens or 0), {"model": model, "phase": "completion"}),
        post("resource.tokens", f"project:{project_id}", "+tokens", +int(completion_tokens or 0), {"model": model, "phase": "completion"}),
        post("resource.time_ms", f"agent:{agent_id}", "ms", -int(wall_ms or 0), {"kind": "wall"}),
        post("resource.time_ms", f"project:{project_id}", "ms", +int(wall_ms or 0), {"kind": "wall"}),
    ]
    if cost_money is not None:
        postings.extend([
            post("resource.money", f"vendor:openrouter", "$", -float(cost_money), {"model": model}),
            post("resource.money", f"project:{project_id}", "$", +float(cost_money), {"model": model}),
        ])
    payload_base: dict[str, Any] = {"provider": provider, "model": model, "completion_tokens": completion_tokens, "wall_ms": wall_ms, "phase": "completion"}
    if response_text is not None:
        payload_base["response_text"] = response_text
    if exchange_id is None:
        exchange_id = new_id()
    event(
        kind="model_completion", actor={"agent_id": agent_id, "task_id": task_id},
        run_id=run_id, payload={**payload_base, **(payload or {}), "exchange_id": exchange_id},
        postings=postings, project_id=project_id, source="runtime",
        idempotency_key=f"{exchange_id}:completion",
    )


def state_move(
    *, task_id: str, from_: str, to: str, project_id: Optional[str],
    agent_id: Optional[str] = None, run_id: Optional[str] = None,
    payload: Optional[dict[str, Any]] = None,
) -> None:
    """Emit a state transition with balanced truth.state postings."""
    postings = [
        post("truth.state", f"task:{task_id}", "tasks", -1, {"from": from_}),
        post("truth.state", f"task:{task_id}", "tasks", +1, {"to": to}),
    ]
    event(
        kind="state_move",
        actor={"agent_id": agent_id, "task_id": task_id} if agent_id else {"task_id": task_id},
        run_id=run_id, payload=payload or {"reason": None},
        postings=postings, project_id=project_id, source="runtime",
    )
