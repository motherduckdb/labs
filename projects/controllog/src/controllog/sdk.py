import json
import os
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional


@dataclass
class SDKConfig:
    project_id: str
    log_dir: Path
    default_dims: Dict[str, Any] = field(default_factory=dict)


_config: Optional[SDKConfig] = None


def init(
    project_id: str,
    log_dir: Path,
    default_dims: Optional[Dict[str, Any]] = None,
) -> None:
    """Initialize controllog SDK for JSONL transport.

    Writes append-only JSONL to ``log_dir/controllog/{events,postings}.jsonl``
    (spec § 3.2).

    Args:
        project_id: Logical project identifier.
        log_dir: Base directory where JSONL logs will be written.
        default_dims: Default dimensions merged into every event's
            ``payload_json`` and every posting's ``dims_json``.
    """
    global _config

    log_dir = Path(log_dir)
    log_dir.mkdir(parents=True, exist_ok=True)
    _config = SDKConfig(
        project_id=project_id,
        log_dir=log_dir,
        default_dims=default_dims or {},
    )


def _require_config() -> SDKConfig:
    """Return the active SDKConfig or raise if init() was never called.

    Plain ``assert`` would be stripped under ``python -O``, turning the
    helpful error into a later AttributeError when callers touch
    ``_config.something``.
    """
    if _config is None:
        raise RuntimeError("controllog.init() must be called before use")
    return _config


def _events_dir() -> Path:
    cfg = _require_config()
    part = cfg.log_dir / "controllog"
    part.mkdir(parents=True, exist_ok=True)
    return part


def _events_file() -> Path:
    return _events_dir() / "events.jsonl"


def _postings_file() -> Path:
    return _events_dir() / "postings.jsonl"


def _write_jsonl(path: Path, obj: Dict[str, Any]) -> None:
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(obj, ensure_ascii=False) + "\n")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _uuid7_str() -> str:
    """Generate a UUIDv7 string (sortable by time) without relying on stdlib uuid7.

    Layout (per draft RFC 4122 v7):
      - 48 bits: unix time in milliseconds
      - 4 bits: version (0b0111)
      - 12 bits: random
      - 2 bits: variant (0b10)
      - 62 bits: random
    """
    ts_ms = int(time.time() * 1000) & ((1 << 48) - 1)
    rand_a = int.from_bytes(os.urandom(2), "big") & 0x0FFF
    rand_b = int.from_bytes(os.urandom(8), "big")  # 64 bits

    b = bytearray(16)
    # 48-bit timestamp big-endian
    b[0:6] = ts_ms.to_bytes(6, "big")
    # version (0x7) in high nibble of byte 6, top 4 bits of rand_a in low nibble
    b[6] = (0x70 | ((rand_a >> 8) & 0x0F))
    b[7] = rand_a & 0xFF
    # variant '10' in top two bits of byte 8, then top 6 bits of rand_b
    b[8] = 0x80 | ((rand_b >> 56) & 0x3F)
    # remaining 56 bits of rand_b into bytes 9..15
    lower_56 = rand_b & ((1 << 56) - 1)
    for i in range(7):
        shift = (6 - i) * 8
        b[9 + i] = (lower_56 >> shift) & 0xFF

    return str(uuid.UUID(bytes=bytes(b)))


def new_id() -> str:
    """Public UUIDv7 generator for correlation (e.g., exchange_id)."""
    return _uuid7_str()


def is_initialized() -> bool:
    """Return True if ``init()`` has been called in this process."""
    return _config is not None


# Fixed namespace UUID for deriving stable v5 IDs from idempotency keys.
# Anchors the controllog id-space; any UUID is fine here as long as it's stable.
_CONTROLLOG_NAMESPACE = uuid.UUID("8ba6b5dc-1c1c-5d29-9b0e-43c4d2c3a9f1")


def _deterministic_event_id(project_id: str, idempotency_key: str) -> str:
    """Derive a stable event_id from (project_id, idempotency_key).

    Per spec § 11, idempotency_key dedupes emission. To actually enforce that
    on retries we anchor event_id to the key — so the MotherDuck PRIMARY KEY
    on event_id rejects duplicates instead of letting them accumulate.
    """
    return str(uuid.uuid5(_CONTROLLOG_NAMESPACE, f"{project_id}\0{idempotency_key}"))


def _deterministic_posting_id(event_id: str, index: int) -> str:
    """Derive a stable posting_id from (event_id, position).

    Postings within an event are unordered for accounting purposes, but the
    list order is stable for a given builder call. Pinning posting_id to
    position keeps retries idempotent at upload.
    """
    return str(uuid.uuid5(_CONTROLLOG_NAMESPACE, f"{event_id}\0posting:{index}"))


def post(
    account_type: str,
    account_id: str,
    unit: str,
    delta: float,
    dims: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Create a posting line (not yet persisted).

    Returns a plain dict; the caller passes the collection to event().
    """
    return {
        "account_type": account_type,
        "account_id": account_id,
        "unit": unit,
        "delta_numeric": float(delta),
        "dims_json": dims or {},
    }


def _check_invariants(kind: str, postings: List[Dict[str, Any]]) -> None:
    """Enforce per-event double-entry invariant (spec § 8.1).

    For every (account_type, unit) pair within a single event,
    sum(delta_numeric) must be zero within a reasonable epsilon. This
    applies to all account types — the spec's minimum set
    (``truth.money`` / ``truth.time`` / ``truth.state`` / ``truth.utility``)
    and any extension namespaces (``resource.*``, custom domains) alike.
    """
    if not postings:
        return

    sums: Dict[tuple, float] = {}
    for p in postings:
        key = (p["account_type"], p["unit"])
        sums[key] = sums.get(key, 0.0) + float(p["delta_numeric"])

    epsilon = 1e-9
    for (acct, unit), total in sums.items():
        if abs(total) > epsilon:
            raise ValueError(
                f"UNBALANCED_POSTINGS: account_type={acct}, unit={unit}, "
                f"net={total} for event kind={kind}"
            )


def event(
    *,
    kind: str,
    actor: Optional[Dict[str, str]] = None,
    run_id: Optional[str] = None,
    payload: Optional[Dict[str, Any]] = None,
    postings: Optional[List[Dict[str, Any]]] = None,
    source: str = "runtime",
    idempotency_key: Optional[str] = None,
) -> Dict[str, Any]:
    """Emit a structured event and balanced postings to JSONL.

    ``project_id`` is taken from :func:`init` — one project per SDK instance,
    per spec § 3.1. ``source`` matches what builders pass so mixed raw/builder
    logs stay readable.

    Returns the persisted event dict.
    """
    cfg = _require_config()

    actor = actor or {}
    payload = payload or {}
    postings = postings or []
    project = cfg.project_id

    _check_invariants(kind, postings)

    # When the caller provides an idempotency_key, derive event_id and
    # posting_ids deterministically from it so retries collapse to the same
    # row at MotherDuck (PRIMARY KEY on event_id / posting_id). Without
    # this, retries write fresh random IDs and upload accumulates duplicate
    # postings, defeating the spec § 11 dedupe contract.
    if idempotency_key is not None:
        event_id = _deterministic_event_id(project, idempotency_key)
    else:
        event_id = _uuid7_str()
        idempotency_key = event_id  # event_id IS the key in this case

    event_time = _now_iso()

    # default_dims merge into payload_json (events) and dims_json (postings)
    # rather than spreading top-level — top-level fields aren't carried into
    # MotherDuck (the upload only selects the fixed event columns and the
    # postings.dims_json field), so spreading top-level would silently drop
    # them after upload and leave them unqueryable.
    defaults = cfg.default_dims or {}

    event_row = {
        "event_id": event_id,
        "event_time": event_time,
        "ingest_time": _now_iso(),
        "kind": kind,
        "actor_agent_id": actor.get("agent_id"),
        "actor_task_id": actor.get("task_id"),
        "project_id": project,
        "run_id": run_id,
        "source": source,
        "idempotency_key": idempotency_key,
        "payload_json": {**defaults, **payload},
    }
    _write_jsonl(_events_file(), event_row)

    for i, p in enumerate(postings):
        p_out = dict(p)
        p_out["event_id"] = event_id
        p_out["posting_id"] = _deterministic_posting_id(event_id, i)
        p_out["dims_json"] = {**defaults, **(p_out.get("dims_json") or {})}
        _write_jsonl(_postings_file(), p_out)

    return event_row
