"""Generic balanced-posting builders.

Account names follow ``docs/spec-v1.1.md`` § 7:

  - ``resource.tokens``  (extension, provider ↔ project, unit ``+tokens``)
  - ``truth.money``      (vendor ↔ project, unit ``$``)
  - ``truth.time``       (agent ↔ project, unit ``ms``)
  - ``truth.state``      (task lifecycle, unit ``tasks``)
  - ``truth.utility``    (task ↔ project, unit ``points``)
"""
from typing import Any, Dict, Optional

from .sdk import event, post, new_id


def model_prompt(
    *,
    task_id: str,
    agent_id: str,
    project_id: str,
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
    """
    if exchange_id is None:
        exchange_id = new_id()

    postings = [
        post("resource.tokens", f"provider:{provider}", "+tokens", -int(prompt_tokens or 0), {"model": model, "phase": "prompt"}),
        post("resource.tokens", f"project:{project_id}", "+tokens", +int(prompt_tokens or 0), {"model": model, "phase": "prompt"}),
    ]
    payload_base: Dict[str, Any] = {
        "provider": provider,
        "model": model,
        "prompt_tokens": prompt_tokens,
        "phase": "prompt",
    }
    if request_text is not None:
        payload_base["request_text"] = request_text

    event(
        kind="model_prompt",
        actor={"agent_id": agent_id, "task_id": task_id},
        run_id=run_id,
        payload={**payload_base, **(payload or {}), "exchange_id": exchange_id},
        postings=postings,
        project_id=project_id,
        source="runtime",
        idempotency_key=f"{exchange_id}:prompt",
    )
    return exchange_id


def model_completion(
    *,
    exchange_id: str,
    task_id: str,
    agent_id: str,
    project_id: str,
    provider: str,
    model: str,
    completion_tokens: int,
    wall_ms: int,
    run_id: Optional[str] = None,
    response_text: Optional[str] = None,
    cost_money: Optional[float] = None,
    upstream_cost_money: Optional[float] = None,
    payload: Optional[Dict[str, Any]] = None,
) -> None:
    """Emit a ``model_completion`` event sharing ``exchange_id`` with its prompt.

    ``exchange_id`` is required (per spec § 5.2 / § 8.3 — exchange
    completeness). Pass the value returned by :func:`model_prompt`.

    ``cost_money`` postings record ``vendor:{provider}``. For aggregator
    setups where the direct vendor differs from the upstream provider,
    pass ``upstream_cost_money`` separately — it lands on ``vendor:upstream``.
    """
    postings = [
        post("resource.tokens", f"provider:{provider}", "+tokens", -int(completion_tokens or 0), {"model": model, "phase": "completion"}),
        post("resource.tokens", f"project:{project_id}", "+tokens", +int(completion_tokens or 0), {"model": model, "phase": "completion"}),
        post("truth.time", f"agent:{agent_id}", "ms", -int(wall_ms or 0), {"kind": "wall"}),
        post("truth.time", f"project:{project_id}", "ms", +int(wall_ms or 0), {"kind": "wall"}),
    ]
    if cost_money is not None:
        postings.extend(
            [
                post("truth.money", f"vendor:{provider}", "$", -float(cost_money), {"model": model}),
                post("truth.money", f"project:{project_id}", "$", +float(cost_money), {"model": model}),
            ]
        )
    if upstream_cost_money is not None:
        postings.extend(
            [
                post("truth.money", f"vendor:upstream", "$", -float(upstream_cost_money), {"model": model}),
                post("truth.money", f"project:{project_id}", "$", +float(upstream_cost_money), {"model": model}),
            ]
        )

    payload_base: Dict[str, Any] = {
        "provider": provider,
        "model": model,
        "completion_tokens": completion_tokens,
        "wall_ms": wall_ms,
        "phase": "completion",
    }
    if response_text is not None:
        payload_base["response_text"] = response_text

    event(
        kind="model_completion",
        actor={"agent_id": agent_id, "task_id": task_id},
        run_id=run_id,
        payload={**payload_base, **(payload or {}), "exchange_id": exchange_id},
        postings=postings,
        project_id=project_id,
        source="runtime",
        idempotency_key=f"{exchange_id}:completion",
    )


def state_move(
    *,
    task_id: str,
    from_: str,
    to: str,
    project_id: str,
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
        project_id=project_id,
        source="runtime",
        idempotency_key=idempotency_key or f"{task_id}:{from_}:{to}",
    )


def utility(
    *,
    task_id: str,
    project_id: str,
    metric: str,
    value: float,
    agent_id: Optional[str] = None,
    run_id: Optional[str] = None,
    payload: Optional[Dict[str, Any]] = None,
) -> None:
    """Emit a balanced ``truth.utility`` posting."""
    postings = [
        post("truth.utility", f"task:{task_id}", "points", +float(value), {"metric": metric}),
        post("truth.utility", f"project:{project_id}", "points", -float(value), {"metric": metric}),
    ]
    event(
        kind="utility",
        actor={"agent_id": agent_id, "task_id": task_id} if agent_id else {"task_id": task_id},
        run_id=run_id,
        payload=payload or {"metric": metric, "value": value},
        postings=postings,
        project_id=project_id,
        source="runtime",
    )
