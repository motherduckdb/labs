# controllog

Controllable logging for AI/agentic systems. A drop-in replacement for `logger.info(...)` built on two primitives:

- **Events** — immutable facts ("what happened")
- **Postings** — balanced deltas applied to accounts ("what changed")

The core invariant is conservation: postings must net to zero across defined surfaces (time, money, state, utility). This gives you a deterministic audit trail in fundamentally non-deterministic systems.

The full design is in [`docs/spec-v1.1.md`](./docs/spec-v1.1.md).

## Install

```bash
# Core (zero deps)
pip install "controllog @ git+https://github.com/motherduckdb/labs#subdirectory=projects/controllog"

# With MotherDuck upload support
pip install "controllog[duckdb] @ git+https://github.com/motherduckdb/labs#subdirectory=projects/controllog"
```

## Quick start

```python
from pathlib import Path
import controllog

controllog.init(project_id="my-eval", log_dir=Path("logs"))

# model_prompt returns the exchange_id; pass it to the paired completion.
# Spec § 5/§ 8.3 require both events to share one exchange_id.
exchange_id = controllog.model_prompt(
    task_id="q42",
    agent_id="solver",
    run_id="run-2026-05-26",
    project_id="my-eval",
    provider="openai",
    model="gpt-5",
    prompt_tokens=812,
    request_text="What is the capital of France?",
)

controllog.model_completion(
    exchange_id=exchange_id,
    task_id="q42",
    agent_id="solver",
    run_id="run-2026-05-26",
    project_id="my-eval",
    provider="openai",
    model="gpt-5",
    completion_tokens=4,
    wall_ms=1380,
    response_text="Paris.",
    cost_money=0.0024,
)
```

Writes append-only JSONL to `logs/controllog/{events,postings}.jsonl` (the
default flat layout). Pass `partition_by_date=True` to `init()` for
`logs/controllog/YYYY-MM-DD/{events,postings}.jsonl` instead. The uploader
handles both layouts.

## Upload to MotherDuck

```python
from controllog import motherduck

motherduck.upload(
    motherduck_db="my_eval",
    log_dir=Path("logs"),
)
```

Creates `controllog.events` and `controllog.postings` tables and appends new rows (idempotent by `event_id` / `posting_id`).

## Public API

```python
# Core
controllog.init(project_id, log_dir, default_dims=None, partition_by_date=False)
controllog.event(*, kind, actor=None, run_id=None, payload=None, postings=None, ...)
controllog.post(account_type, account_id, unit, delta, dims=None)
controllog.new_id()              # UUIDv7
controllog.is_initialized()

# Generic builders (preferred over raw event/post)
exchange_id = controllog.model_prompt(...)          # returns exchange_id
controllog.model_completion(exchange_id=..., ...)   # pass the paired id
controllog.state_move(task_id, from_, to, ...)
controllog.utility(task_id, project_id, metric, value, ...)
controllog.agent_run(task_id, agent_id, run_id=None)  # contextmanager

# Optional, requires controllog[duckdb]
from controllog import motherduck
motherduck.upload(...)
motherduck.cleanup_local(...)
motherduck.verify(...)
```

## Why not just use a logger?

Standard loggers observe. Controllog enforces. Because postings must balance per event and across slices, you can detect missing, duplicated, or inconsistent work without after-the-fact reconciliation — useful when the work is being done by a non-deterministic model.

See the [spec](./docs/spec-v1.1.md) for the full motivation.

## Status

Alpha. The on-disk JSONL schema and MotherDuck tables follow v1.1 of the spec and are considered stable. Builder signatures may evolve.
