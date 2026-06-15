"""Generic balanced-posting builders.

Account names follow ``docs/spec-v1.1.md`` § 7:

  - ``resource.tokens``  (extension, provider ↔ project, unit ``+tokens``)
  - ``truth.money``      (vendor ↔ project, unit ``$``)
  - ``truth.time``       (agent ↔ project, unit ``ms``)
  - ``truth.state``      (task lifecycle, unit ``tasks``)
  - ``truth.utility``    (task ↔ project, unit ``points``)

``project_id`` is resolved from ``init()``'s config — builders don't accept
it per call. One configured project per SDK instance per spec § 3.1.
"""
import hashlib
import json
from typing import Any, Dict, Optional

from .sdk import _require_config, event, new_id, post


def _stable_hash(obj: Any) -> str:
    """Return a deterministic SHA-256 hash for resolved config payloads."""
    encoded = json.dumps(obj, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _compact(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Drop absent optional metadata while preserving explicit false/zero values."""
    return {k: v for k, v in payload.items() if v is not None}


def model_prompt(
    *,
    task_id: str,
    agent_id: str,
    provider: str,
    model: str,
    prompt_tokens: int,
    run_id: Optional[str] = None,
    exchange_id: Optional[str] = None,
    request_text: Optional[str] = None,
    payload: Optional[Dict[str, Any]] = None,
) -> str:
    """Emit a ``model_prompt`` event with balanced token postings.

    Per spec § 5, every model call is two events sharing one ``exchange_id``.
    If ``exchange_id`` is omitted, one is generated here and **returned** so
    the caller can pass the same value to :func:`model_completion`. Pairing
    the two is required for the spec's exchange-completeness invariant.

    Caller-supplied ``payload`` keys are overridden by the canonical builder
    fields (``provider``, ``model``, ``phase``, ``prompt_tokens``,
    ``exchange_id``) — otherwise a stray ``payload={"phase": "completion"}``
    could disagree with the postings.
    """
    project_id = _require_config().project_id
    if exchange_id is None:
        exchange_id = new_id()

    postings = [
        post("resource.tokens", f"provider:{provider}", "+tokens", -int(prompt_tokens), {"model": model, "phase": "prompt"}),
        post("resource.tokens", f"project:{project_id}", "+tokens", +int(prompt_tokens), {"model": model, "phase": "prompt"}),
    ]
    canonical: Dict[str, Any] = {
        "provider": provider,
        "model": model,
        "prompt_tokens": prompt_tokens,
        "phase": "prompt",
        "exchange_id": exchange_id,
    }
    if request_text is not None:
        canonical["request_text"] = request_text

    event(
        kind="model_prompt",
        actor={"agent_id": agent_id, "task_id": task_id},
        run_id=run_id,
        # Caller payload first, canonical fields override.
        payload={**(payload or {}), **canonical},
        postings=postings,
        idempotency_key=f"{exchange_id}:prompt",
    )
    return exchange_id


def model_completion(
    *,
    exchange_id: str,
    task_id: str,
    agent_id: str,
    provider: str,
    model: str,
    completion_tokens: int,
    wall_ms: int,
    run_id: Optional[str] = None,
    response_text: Optional[str] = None,
    cost_money: Optional[float] = None,
    payload: Optional[Dict[str, Any]] = None,
) -> None:
    """Emit a ``model_completion`` event sharing ``exchange_id`` with its prompt.

    ``exchange_id`` is required (per spec § 5.2 / § 8.3 — exchange
    completeness). Pass the value returned by :func:`model_prompt`.

    ``cost_money`` postings record ``vendor:{provider}``. Callers needing
    aggregator-vs-upstream accounting can emit additional ``truth.money``
    postings via raw :func:`event` / :func:`post`.
    """
    project_id = _require_config().project_id
    postings = [
        post("resource.tokens", f"provider:{provider}", "+tokens", -int(completion_tokens), {"model": model, "phase": "completion"}),
        post("resource.tokens", f"project:{project_id}", "+tokens", +int(completion_tokens), {"model": model, "phase": "completion"}),
        post("truth.time", f"agent:{agent_id}", "ms", -int(wall_ms), {"kind": "wall"}),
        post("truth.time", f"project:{project_id}", "ms", +int(wall_ms), {"kind": "wall"}),
    ]
    if cost_money is not None:
        postings.extend(
            [
                post("truth.money", f"vendor:{provider}", "$", -float(cost_money), {"model": model}),
                post("truth.money", f"project:{project_id}", "$", +float(cost_money), {"model": model}),
            ]
        )

    canonical: Dict[str, Any] = {
        "provider": provider,
        "model": model,
        "completion_tokens": completion_tokens,
        "wall_ms": wall_ms,
        "phase": "completion",
        "exchange_id": exchange_id,
    }
    if response_text is not None:
        canonical["response_text"] = response_text

    event(
        kind="model_completion",
        actor={"agent_id": agent_id, "task_id": task_id},
        run_id=run_id,
        payload={**(payload or {}), **canonical},
        postings=postings,
        idempotency_key=f"{exchange_id}:completion",
    )


def run_metadata(
    *,
    run_id: str,
    commit_sha: Optional[str] = None,
    repo: Optional[str] = None,
    dirty: Optional[bool] = None,
    effort: Optional[Any] = None,
    resolved_config: Optional[Dict[str, Any]] = None,
    config_hash: Optional[str] = None,
    run_parameters: Optional[Dict[str, Any]] = None,
    job_id: Optional[str] = None,
    trial_id: Optional[str] = None,
    trial_index: Optional[int] = None,
    agent_name: Optional[str] = None,
    agent_version: Optional[str] = None,
    runtime: Optional[str] = None,
    image_digest: Optional[str] = None,
    os: Optional[str] = None,
    dataset_name: Optional[str] = None,
    dataset_version: Optional[str] = None,
    payload: Optional[Dict[str, Any]] = None,
    idempotency_key: Optional[str] = None,
) -> Dict[str, Any]:
    """Emit run-level provenance as a ``run_metadata`` event.

    The core events table has no separate runs table, so this builder records one
    posting-free event scoped by ``run_id``. Renderers and query layers can join it
    back to the run while older consumers simply ignore the event kind.
    """
    _require_config()
    if config_hash is None and resolved_config is not None:
        config_hash = _stable_hash(resolved_config)

    canonical = _compact(
        {
            "commit_sha": commit_sha,
            "repo": repo,
            "dirty": dirty,
            "effort": effort,
            "resolved_config": resolved_config,
            "config_hash": config_hash,
            "run_parameters": run_parameters,
            "job_id": job_id,
            "trial_id": trial_id,
            "trial_index": trial_index,
            "agent_name": agent_name,
            "agent_version": agent_version,
            "runtime": runtime,
            "image_digest": image_digest,
            "os": os,
            "dataset_name": dataset_name,
            "dataset_version": dataset_version,
        }
    )
    return event(
        kind="run_metadata",
        run_id=run_id,
        payload={**(payload or {}), **canonical},
        postings=[],
        idempotency_key=idempotency_key or f"{run_id}:run_metadata",
    )


def tool_call(
    *,
    task_id: str,
    agent_id: str,
    name: str,
    call_id: Optional[str] = None,
    run_id: Optional[str] = None,
    arguments: Any = None,
    payload: Optional[Dict[str, Any]] = None,
) -> str:
    """Emit a timestamped ``tool_call`` event and return its ``call_id``.

    Pair this with :func:`tool_result`. The event's ``event_time`` marks the call
    start; the result event marks the end and can carry ``duration_ms``.
    """
    _require_config()
    if call_id is None:
        call_id = new_id()

    canonical = _compact(
        {
            "call_id": call_id,
            "name": name,
            "arguments": arguments,
            "phase": "call",
        }
    )
    event(
        kind="tool_call",
        actor={"agent_id": agent_id, "task_id": task_id},
        run_id=run_id,
        payload={**(payload or {}), **canonical},
        postings=[],
        idempotency_key=f"{call_id}:tool_call",
    )
    return call_id


def tool_result(
    *,
    call_id: str,
    task_id: str,
    agent_id: str,
    name: Optional[str] = None,
    run_id: Optional[str] = None,
    output: Any = None,
    status: Optional[str] = None,
    duration_ms: Optional[int] = None,
    payload: Optional[Dict[str, Any]] = None,
) -> None:
    """Emit a timestamped ``tool_result`` event paired with a ``tool_call``.

    When ``duration_ms`` is supplied it is also posted to ``truth.time`` so tool
    latency participates in the same balanced accounting as model latency.
    """
    project_id = _require_config().project_id
    postings = []
    if duration_ms is not None:
        postings = [
            post("truth.time", f"agent:{agent_id}", "ms", -int(duration_ms), {"kind": "tool", "tool": name}),
            post("truth.time", f"project:{project_id}", "ms", +int(duration_ms), {"kind": "tool", "tool": name}),
        ]

    canonical = _compact(
        {
            "call_id": call_id,
            "name": name,
            "output": output,
            "status": status,
            "duration_ms": duration_ms,
            "phase": "result",
        }
    )
    event(
        kind="tool_result",
        actor={"agent_id": agent_id, "task_id": task_id},
        run_id=run_id,
        payload={**(payload or {}), **canonical},
        postings=postings,
        idempotency_key=f"{call_id}:tool_result",
    )


def state_move(
    *,
    task_id: str,
    from_: str,
    to: str,
    agent_id: Optional[str] = None,
    run_id: Optional[str] = None,
    payload: Optional[Dict[str, Any]] = None,
    idempotency_key: Optional[str] = None,
) -> None:
    """Emit a balanced ``truth.state`` transition for a task.

    Per spec § 6, ``NEW → WIP`` happens exactly once and terminal transitions
    are unique. Without a deterministic idempotency key, retries would emit
    duplicate events with fresh ``event_id`` s — each duplicate is locally
    balanced, so trial balance can't catch the drift.

    Defaults to ``f"{task_id}:{from_}:{to}"``; pass an explicit
    ``idempotency_key`` if you need a different correlation (e.g., when the
    same transition is legitimately recorded by multiple actors).
    """
    _require_config()  # surface missing init() now, not inside event()
    postings = [
        post("truth.state", f"task:{task_id}", "tasks", -1, {"from": from_}),
        post("truth.state", f"task:{task_id}", "tasks", +1, {"to": to}),
    ]
    event(
        kind="state_move",
        actor={"agent_id": agent_id, "task_id": task_id} if agent_id else {"task_id": task_id},
        run_id=run_id,
        payload=payload,
        postings=postings,
        idempotency_key=idempotency_key or f"{task_id}:{from_}:{to}",
    )


def utility(
    *,
    task_id: str,
    metric: str,
    value: float,
    agent_id: Optional[str] = None,
    run_id: Optional[str] = None,
    payload: Optional[Dict[str, Any]] = None,
) -> None:
    """Emit a balanced ``truth.utility`` posting.

    ``metric`` and ``value`` are already recorded on the postings' dims_json
    and delta_numeric; the event payload only carries what the caller passes.
    """
    project_id = _require_config().project_id
    postings = [
        post("truth.utility", f"task:{task_id}", "points", +float(value), {"metric": metric}),
        post("truth.utility", f"project:{project_id}", "points", -float(value), {"metric": metric}),
    ]
    event(
        kind="utility",
        actor={"agent_id": agent_id, "task_id": task_id} if agent_id else {"task_id": task_id},
        run_id=run_id,
        payload=payload,
        postings=postings,
    )
