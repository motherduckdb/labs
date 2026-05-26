"""
Controllog v1.1 - Controllable Logging for AI/Agentic Systems

A drop-in replacement for traditional logging based on accounting and
cybernetic control primitives.

Core Primitives:
- Events: immutable facts ("what happened")
- Postings: balanced deltas applied to accounts ("what changed")

The core invariant is conservation: postings must net to zero across
defined surfaces (time, money, state, utility).

Transport:
- Local: JSONL files in <log_dir>/controllog/
- Remote: MotherDuck tables in controllog schema
"""

from __future__ import annotations

import json
import os
import uuid
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

try:
    import duckdb
    HAS_DUCKDB = True
except ImportError:
    HAS_DUCKDB = False


# --- Types ---


@dataclass
class Posting:
    """A posting applies a signed delta to an account."""
    posting_id: str
    event_id: str
    account_type: str  # e.g. truth.money, truth.time, truth.state
    account_id: str    # e.g. project, provider, task:<id>
    unit: str          # e.g. usd, ms, task_status
    delta_numeric: float
    dims_json: dict = field(default_factory=dict)


@dataclass
class Event:
    """An event is an immutable fact."""
    event_id: str
    event_time: str  # ISO format UTC
    kind: str        # string enum
    project_id: str
    source: str      # e.g. runtime
    idempotency_key: str
    payload_json: dict = field(default_factory=dict)
    run_id: str | None = None
    actor_agent_id: str | None = None
    actor_task_id: str | None = None
    postings: list[Posting] = field(default_factory=list)


# --- Global State ---


class ControllogState:
    """Global controllog state."""
    project_id: str | None = None
    log_dir: Path | None = None
    default_dims: dict = {}
    run_id: str | None = None
    initialized: bool = False

    # File handles
    _events_file: Any = None
    _postings_file: Any = None


_state = ControllogState()


# --- Core API ---


def init(
    project_id: str,
    log_dir: Path | str,
    default_dims: dict | None = None,
    run_id: str | None = None
) -> None:
    """
    Initialize controllog.

    Args:
        project_id: Project identifier
        log_dir: Directory for JSONL log files
        default_dims: Default dimensions to include in all events
        run_id: Optional run identifier (generated if not provided)
    """
    _state.project_id = project_id
    _state.log_dir = Path(log_dir)
    _state.default_dims = default_dims or {}
    _state.run_id = run_id or new_id()
    _state.initialized = True

    # Create log directory structure
    controllog_dir = _state.log_dir / "controllog"
    controllog_dir.mkdir(parents=True, exist_ok=True)

    # Open file handles
    _state._events_file = open(controllog_dir / "events.jsonl", "a")
    _state._postings_file = open(controllog_dir / "postings.jsonl", "a")


def close() -> None:
    """Close file handles."""
    if _state._events_file:
        _state._events_file.close()
        _state._events_file = None
    if _state._postings_file:
        _state._postings_file.close()
        _state._postings_file = None
    _state.initialized = False


def is_initialized() -> bool:
    """Check if controllog is initialized."""
    return _state.initialized


def new_id() -> str:
    """Generate a new unique identifier (UUIDv4)."""
    return str(uuid.uuid4())


def event(
    kind: str,
    postings: list[dict],
    idempotency_key: str,
    payload: dict | None = None,
    actor: dict | None = None,
    run_id: str | None = None,
    source: str = "runtime"
) -> str:
    """
    Emit an event with postings.

    Args:
        kind: Event type (string enum)
        postings: List of posting dicts with keys:
            - account_type: e.g. "truth.money"
            - account_id: e.g. "project", "provider"
            - unit: e.g. "usd", "ms"
            - delta: signed numeric value
            - dims: optional dimensions dict
        idempotency_key: Unique key for deduplication
        payload: Optional freeform payload
        actor: Optional actor info (agent_id, task_id)
        run_id: Optional run ID override
        source: Event source (default: "runtime")

    Returns:
        event_id

    Raises:
        ValueError: If postings don't balance
    """
    if not _state.initialized:
        raise RuntimeError("controllog not initialized - call init() first")

    event_id = new_id()
    event_time = datetime.now(timezone.utc).isoformat()

    # Build postings
    posting_objects = []
    for p in postings:
        posting = Posting(
            posting_id=new_id(),
            event_id=event_id,
            account_type=p["account_type"],
            account_id=p["account_id"],
            unit=p["unit"],
            delta_numeric=p["delta"],
            dims_json={**_state.default_dims, **p.get("dims", {})}
        )
        posting_objects.append(posting)

    # Check double-entry invariant
    _check_invariants(posting_objects)

    # Build event
    evt = Event(
        event_id=event_id,
        event_time=event_time,
        kind=kind,
        project_id=_state.project_id,
        source=source,
        idempotency_key=idempotency_key,
        payload_json=payload or {},
        run_id=run_id or _state.run_id,
        actor_agent_id=actor.get("agent_id") if actor else None,
        actor_task_id=actor.get("task_id") if actor else None,
        postings=posting_objects
    )

    # Write to files
    _write_event(evt)
    _write_postings(posting_objects)

    return event_id


def post(
    account_type: str,
    account_id: str,
    unit: str,
    delta: float,
    dims: dict | None = None
) -> dict:
    """
    Helper to create a posting dict for use with event().

    Args:
        account_type: Account type (e.g. "truth.money")
        account_id: Account identifier (e.g. "project", "provider")
        unit: Unit of measure (e.g. "usd", "ms")
        delta: Signed delta value
        dims: Optional dimensions

    Returns:
        Posting dict ready for event()
    """
    return {
        "account_type": account_type,
        "account_id": account_id,
        "unit": unit,
        "delta": delta,
        "dims": dims or {}
    }


# --- Two-Phase Model Call Helpers ---


def model_prompt(
    exchange_id: str,
    prompt_tokens: int,
    model: str,
    provider: str,
    payload: dict | None = None
) -> str:
    """
    Log the prompt phase of a model call.

    Args:
        exchange_id: Unique ID for this prompt/completion pair
        prompt_tokens: Number of input tokens
        model: Model identifier
        provider: Provider name
        payload: Optional additional payload

    Returns:
        event_id
    """
    return event(
        kind="model_prompt",
        idempotency_key=f"{exchange_id}:prompt",
        payload={
            "exchange_id": exchange_id,
            "prompt_tokens": prompt_tokens,
            "model": model,
            "provider": provider,
            **(payload or {})
        },
        postings=[
            post("truth.tokens", "project", "input_tokens", prompt_tokens, {"model": model, "provider": provider, "phase": "prompt"}),
            post("truth.tokens", "provider", "input_tokens", -prompt_tokens, {"model": model, "provider": provider, "phase": "prompt"}),
        ]
    )


def model_completion(
    exchange_id: str,
    completion_tokens: int,
    cost_usd: float,
    duration_ms: int,
    model: str,
    provider: str,
    success: bool = True,
    error: str | None = None,
    payload: dict | None = None,
    upstream_cost_usd: float | None = None
) -> str:
    """
    Log the completion phase of a model call.

    Args:
        exchange_id: Unique ID matching the prompt phase
        completion_tokens: Number of output tokens
        cost_usd: Cost in USD (from OpenRouter/provider)
        duration_ms: Wall-clock duration in milliseconds
        model: Model identifier
        provider: Provider name
        success: Whether the call succeeded
        error: Error message if failed
        payload: Optional additional payload
        upstream_cost_usd: For BYOK, the cost charged by the upstream provider

    Returns:
        event_id
    """
    dims = {"model": model, "provider": provider, "phase": "completion"}

    postings = [
        # Token accounting
        post("truth.tokens", "project", "output_tokens", completion_tokens, dims),
        post("truth.tokens", "provider", "output_tokens", -completion_tokens, dims),
        # Cost accounting (OpenRouter cost)
        post("truth.money", "project", "usd", -cost_usd, dims),
        post("truth.money", "vendor:openrouter", "usd", cost_usd, dims),
        # Time accounting
        post("truth.time", "project", "ms", duration_ms, dims),
        post("truth.time", "provider", "ms", -duration_ms, dims),
    ]

    # Add upstream cost for BYOK (charged by provider like Anthropic/OpenAI directly)
    if upstream_cost_usd is not None and upstream_cost_usd > 0:
        upstream_dims = {**dims, "cost_type": "upstream"}
        postings.extend([
            post("truth.money", "project", "usd", -upstream_cost_usd, upstream_dims),
            post("truth.money", "vendor:upstream", "usd", upstream_cost_usd, upstream_dims),
        ])

    return event(
        kind="model_completion",
        idempotency_key=f"{exchange_id}:completion",
        payload={
            "exchange_id": exchange_id,
            "completion_tokens": completion_tokens,
            "cost_usd": cost_usd,
            "upstream_cost_usd": upstream_cost_usd,
            "duration_ms": duration_ms,
            "model": model,
            "provider": provider,
            "success": success,
            "error": error,
            **(payload or {})
        },
        postings=postings
    )


# --- Task Lifecycle Helpers ---


def task_new(task_id: str, payload: dict | None = None) -> str:
    """
    Log task creation (NEW state).

    Uses balanced double-entry: +1 to task state, -1 from pool.
    Both postings use same (account_type, unit) to maintain invariant.

    Args:
        task_id: Unique task identifier
        payload: Optional additional payload

    Returns:
        event_id
    """
    return event(
        kind="task_new",
        idempotency_key=f"task:{task_id}:new",
        payload={"task_id": task_id, **(payload or {})},
        actor={"task_id": task_id},
        postings=[
            post("truth.state", f"task:{task_id}", "task_status", 1, {"state": "NEW"}),
            post("truth.state", "pool:potential", "task_status", -1, {"state": "POTENTIAL"}),
        ]
    )


def task_start(task_id: str, payload: dict | None = None) -> str:
    """
    Log task start (NEW -> WIP).

    State transition: debit NEW, credit WIP.

    Args:
        task_id: Task identifier
        payload: Optional additional payload

    Returns:
        event_id
    """
    return event(
        kind="task_start",
        idempotency_key=f"task:{task_id}:start",
        payload={"task_id": task_id, **(payload or {})},
        actor={"task_id": task_id},
        postings=[
            post("truth.state", f"task:{task_id}:WIP", "task_status", 1, {"state": "WIP"}),
            post("truth.state", f"task:{task_id}:NEW", "task_status", -1, {"state": "NEW"}),
        ]
    )


def task_complete(task_id: str, success: bool, payload: dict | None = None) -> str:
    """
    Log task completion (WIP -> DONE or WIP -> FAILED).

    State transition: debit WIP, credit terminal state.

    Args:
        task_id: Task identifier
        success: Whether task completed successfully
        payload: Optional additional payload

    Returns:
        event_id
    """
    end_state = "DONE" if success else "FAILED"

    return event(
        kind="task_complete",
        idempotency_key=f"task:{task_id}:complete",
        payload={"task_id": task_id, "success": success, **(payload or {})},
        actor={"task_id": task_id},
        postings=[
            post("truth.state", f"task:{task_id}:{end_state}", "task_status", 1, {"state": end_state}),
            post("truth.state", f"task:{task_id}:WIP", "task_status", -1, {"state": "WIP"}),
        ]
    )


# --- Invariant Checking ---


def _check_invariants(postings: list[Posting]) -> None:
    """
    Check double-entry invariant: for each (account_type, unit),
    SUM(delta_numeric) must equal 0.

    Raises:
        ValueError: If invariant is violated
    """
    # Group by (account_type, unit)
    sums: dict[tuple[str, str], float] = {}

    for p in postings:
        key = (p.account_type, p.unit)
        sums[key] = sums.get(key, 0) + p.delta_numeric

    # Check each group sums to zero
    for key, total in sums.items():
        if abs(total) > 1e-9:  # Allow small floating point tolerance
            account_type, unit = key
            raise ValueError(
                f"Double-entry invariant violated: ({account_type}, {unit}) "
                f"sums to {total}, expected 0"
            )


# --- File Transport ---


def _write_event(evt: Event) -> None:
    """Write event to JSONL file."""
    if not _state._events_file:
        return

    # Convert to dict, excluding postings (written separately)
    data = {
        "event_id": evt.event_id,
        "event_time": evt.event_time,
        "kind": evt.kind,
        "project_id": evt.project_id,
        "source": evt.source,
        "idempotency_key": evt.idempotency_key,
        "payload_json": evt.payload_json,
        "run_id": evt.run_id,
        "actor_agent_id": evt.actor_agent_id,
        "actor_task_id": evt.actor_task_id,
    }

    _state._events_file.write(json.dumps(data, default=str) + "\n")
    _state._events_file.flush()


def _write_postings(postings: list[Posting]) -> None:
    """Write postings to JSONL file."""
    if not _state._postings_file:
        return

    for p in postings:
        data = asdict(p)
        _state._postings_file.write(json.dumps(data, default=str) + "\n")

    _state._postings_file.flush()


# --- MotherDuck Upload ---


def upload_to_motherduck(
    motherduck_token: str | None = None,
    motherduck_db: str = "bird_bench",
    log_dir: Path | str | None = None
) -> dict[str, int]:
    """
    Upload controllog JSONL files to MotherDuck.

    Creates the controllog schema and tables if they don't exist,
    then appends data from local JSONL files.

    Args:
        motherduck_token: MotherDuck API token (defaults to MOTHERDUCK_TOKEN env var)
        motherduck_db: MotherDuck database name
        log_dir: Directory containing controllog/ folder (defaults to _state.log_dir)

    Returns:
        Dictionary with counts: {"events": N, "postings": M}

    Raises:
        RuntimeError: If duckdb not installed or files not found
    """
    if not HAS_DUCKDB:
        raise RuntimeError("duckdb package required for MotherDuck upload. Install with: pip install duckdb")

    token = motherduck_token or os.environ.get("MOTHERDUCK_TOKEN")
    if not token:
        raise ValueError("MOTHERDUCK_TOKEN not set")

    base_dir = Path(log_dir) if log_dir else _state.log_dir
    if not base_dir:
        raise RuntimeError("log_dir not specified and controllog not initialized")

    controllog_dir = base_dir / "controllog"
    events_file = controllog_dir / "events.jsonl"
    postings_file = controllog_dir / "postings.jsonl"

    if not events_file.exists() or not postings_file.exists():
        raise RuntimeError(f"JSONL files not found in {controllog_dir}")

    # Connect to MotherDuck
    print(f"Connecting to MotherDuck database: {motherduck_db}")
    md = duckdb.connect(f"md:{motherduck_db}?motherduck_token={token}")

    try:
        # Create bird_eval schema (separate from controllog to avoid schema conflicts)
        md.execute("CREATE SCHEMA IF NOT EXISTS bird_eval")

        # Create events table
        md.execute("""
            CREATE TABLE IF NOT EXISTS bird_eval.events (
                event_id VARCHAR PRIMARY KEY,
                event_time TIMESTAMP WITH TIME ZONE,
                kind VARCHAR NOT NULL,
                project_id VARCHAR NOT NULL,
                source VARCHAR NOT NULL,
                idempotency_key VARCHAR NOT NULL,
                payload_json JSON,
                run_id VARCHAR,
                actor_agent_id VARCHAR,
                actor_task_id VARCHAR
            )
        """)

        # Create postings table
        md.execute("""
            CREATE TABLE IF NOT EXISTS bird_eval.postings (
                posting_id VARCHAR PRIMARY KEY,
                event_id VARCHAR NOT NULL,
                account_type VARCHAR NOT NULL,
                account_id VARCHAR NOT NULL,
                unit VARCHAR NOT NULL,
                delta_numeric DOUBLE NOT NULL,
                dims_json JSON
            )
        """)

        # Load events from JSONL (skip duplicates)
        # Cast event_id to VARCHAR since read_json_auto infers UUID format as UUID type
        md.execute(f"""
            INSERT INTO bird_eval.events (
                event_id, event_time, kind, project_id, source,
                idempotency_key, payload_json, run_id, actor_agent_id, actor_task_id
            )
            SELECT
                CAST(event_id AS VARCHAR),
                event_time,
                kind,
                project_id,
                source,
                idempotency_key,
                payload_json,
                run_id,
                actor_agent_id,
                actor_task_id
            FROM read_json_auto('{events_file}') AS src
            WHERE CAST(src.event_id AS VARCHAR) NOT IN (SELECT event_id FROM bird_eval.events)
        """)
        events_count = md.execute(f"SELECT COUNT(*) FROM read_json_auto('{events_file}')").fetchone()[0]

        # Load postings from JSONL (skip duplicates)
        # Cast posting_id/event_id to VARCHAR since read_json_auto infers UUID format as UUID type
        md.execute(f"""
            INSERT INTO bird_eval.postings (
                posting_id, event_id, account_type, account_id, unit, delta_numeric, dims_json
            )
            SELECT
                CAST(posting_id AS VARCHAR),
                CAST(event_id AS VARCHAR),
                account_type,
                account_id,
                unit,
                delta_numeric,
                dims_json
            FROM read_json_auto('{postings_file}') AS src
            WHERE CAST(src.posting_id AS VARCHAR) NOT IN (SELECT posting_id FROM bird_eval.postings)
        """)
        postings_count = md.execute(f"SELECT COUNT(*) FROM read_json_auto('{postings_file}')").fetchone()[0]

        print(f"Uploaded to bird_eval schema:")
        print(f"  Events: {events_count}")
        print(f"  Postings: {postings_count}")

        return {"events": events_count, "postings": postings_count}

    finally:
        md.close()


def upload_truth_seeking(
    motherduck_token: str | None = None,
    motherduck_db: str = "my_db",
    log_dir: Path | str | None = None
) -> int:
    """
    Upload truth_seeking analysis JSONL files to MotherDuck.

    Creates a flat truth_seeking table with analysis results.

    Returns:
        Number of records uploaded
    """
    if not HAS_DUCKDB:
        raise RuntimeError("duckdb package required for MotherDuck upload")

    token = motherduck_token or os.environ.get("MOTHERDUCK_TOKEN")
    if not token:
        raise ValueError("MOTHERDUCK_TOKEN not set")

    base_dir = Path(log_dir) if log_dir else _state.log_dir
    if not base_dir:
        raise RuntimeError("log_dir not specified and controllog not initialized")

    truth_seeking_dir = base_dir / "truth_seeking"
    if not truth_seeking_dir.exists():
        print("No truth_seeking directory found, skipping")
        return 0

    jsonl_files = list(truth_seeking_dir.glob("*.jsonl"))
    if not jsonl_files:
        print("No truth_seeking JSONL files found, skipping")
        return 0

    md = duckdb.connect(f"md:{motherduck_db}?motherduck_token={token}")

    try:
        # Ensure bird_eval schema exists
        md.execute("CREATE SCHEMA IF NOT EXISTS bird_eval")

        # Create flat truth_seeking table (schema matches actual JSONL structure)
        md.execute("""
            CREATE TABLE IF NOT EXISTS bird_eval.truth_seeking (
                question_id INTEGER,
                db_id VARCHAR,
                verdict VARCHAR,
                confidence VARCHAR,
                reasoning VARCHAR,
                recommendation VARCHAR,
                gold_sql VARCHAR,
                predicted_sql VARCHAR,
                gold_issues VARCHAR,
                predicted_issues VARCHAR,
                correctness_level VARCHAR,
                inspector_model VARCHAR,
                analyzed_at TIMESTAMP,
                source_file VARCHAR
            )
        """)

        total_count = 0
        for jsonl_file in jsonl_files:
            md.execute(f"""
                INSERT INTO bird_eval.truth_seeking
                SELECT
                    question_id,
                    db_id,
                    verdict,
                    confidence,
                    reasoning,
                    recommendation,
                    gold_sql,
                    predicted_sql,
                    CAST(gold_issues AS VARCHAR),
                    CAST(predicted_issues AS VARCHAR),
                    correctness_level,
                    inspector_model,
                    analyzed_at::TIMESTAMP,
                    '{jsonl_file.name}' as source_file
                FROM read_json_auto('{jsonl_file}', ignore_errors=true)
            """)
            file_count = md.execute(f"SELECT COUNT(*) FROM read_json_auto('{jsonl_file}', ignore_errors=true)").fetchone()[0]
            total_count += file_count

        print(f"Uploaded {total_count} truth_seeking records")
        return total_count

    finally:
        md.close()


def upload_error_investigations(
    motherduck_token: str | None = None,
    motherduck_db: str = "my_db",
    log_dir: Path | str | None = None
) -> int:
    """
    Upload error_logs (introspection) JSONL files to MotherDuck.

    Creates a flat error_investigations table with self-analysis results.

    Returns:
        Number of records uploaded
    """
    if not HAS_DUCKDB:
        raise RuntimeError("duckdb package required for MotherDuck upload")

    token = motherduck_token or os.environ.get("MOTHERDUCK_TOKEN")
    if not token:
        raise ValueError("MOTHERDUCK_TOKEN not set")

    base_dir = Path(log_dir) if log_dir else _state.log_dir
    if not base_dir:
        raise RuntimeError("log_dir not specified and controllog not initialized")

    error_logs_dir = base_dir / "error_logs"
    if not error_logs_dir.exists():
        print("No error_logs directory found, skipping")
        return 0

    jsonl_files = list(error_logs_dir.glob("*.jsonl"))
    if not jsonl_files:
        print("No error_logs JSONL files found, skipping")
        return 0

    md = duckdb.connect(f"md:{motherduck_db}?motherduck_token={token}")

    try:
        # Ensure bird_eval schema exists
        md.execute("CREATE SCHEMA IF NOT EXISTS bird_eval")

        # Create flat error_investigations table (schema matches actual JSONL structure)
        md.execute("""
            CREATE TABLE IF NOT EXISTS bird_eval.error_investigations (
                question_id INTEGER,
                db_id VARCHAR,
                dataset VARCHAR,
                model VARCHAR,
                category VARCHAR,
                short_description VARCHAR,
                detailed_description VARCHAR,
                correctness_level VARCHAR,
                partial_reason VARCHAR,
                gold_sql_duckdb VARCHAR,
                predicted_sql VARCHAR,
                gold_tables VARCHAR,
                predicted_tables VARCHAR,
                source_file VARCHAR
            )
        """)

        total_count = 0
        for jsonl_file in jsonl_files:
            md.execute(f"""
                INSERT INTO bird_eval.error_investigations
                SELECT
                    question_id,
                    db_id,
                    dataset,
                    model,
                    category,
                    short_description,
                    detailed_description,
                    correctness_level,
                    partial_reason,
                    gold_sql_duckdb,
                    predicted_sql,
                    CAST(gold_tables AS VARCHAR),
                    CAST(predicted_tables AS VARCHAR),
                    '{jsonl_file.name}' as source_file
                FROM read_json_auto('{jsonl_file}', ignore_errors=true)
            """)
            file_count = md.execute(f"SELECT COUNT(*) FROM read_json_auto('{jsonl_file}', ignore_errors=true)").fetchone()[0]
            total_count += file_count

        print(f"Uploaded {total_count} error_investigations records")
        return total_count

    finally:
        md.close()


def cleanup_local_logs(
    log_dir: Path | str | None = None,
    verify_uploaded: bool = True,
    delete_html: bool = False,
    dry_run: bool = False,
    motherduck_token: str | None = None,
    motherduck_db: str = "bird_bench",
) -> dict[str, Any]:
    """
    Delete local log files after verifying they exist in MotherDuck.

    Args:
        log_dir: Directory containing controllog/ subdirectory (defaults to _state.log_dir)
        verify_uploaded: If True, verify records exist in MotherDuck before deleting
        delete_html: If True, also delete HTML error reports
        dry_run: If True, report what would be deleted without deleting
        motherduck_token: MotherDuck API token (defaults to MOTHERDUCK_TOKEN env var)
        motherduck_db: MotherDuck database name

    Returns:
        Dict with counts of deleted files and freed bytes

    Raises:
        RuntimeError: If verification fails (local records > remote)
    """
    from eval.config import RESULTS_DIR

    base_dir = Path(log_dir) if log_dir else (_state.log_dir or RESULTS_DIR)
    controllog_dir = base_dir / "controllog"
    error_logs_dir = base_dir / "error_logs"

    result = {
        "files_deleted": 0,
        "bytes_freed": 0,
        "files": [],
        "dry_run": dry_run,
    }

    # Count local records
    events_file = controllog_dir / "events.jsonl"
    postings_file = controllog_dir / "postings.jsonl"

    local_events = 0
    local_postings = 0

    if events_file.exists():
        with open(events_file) as f:
            local_events = sum(1 for line in f if line.strip())

    if postings_file.exists():
        with open(postings_file) as f:
            local_postings = sum(1 for line in f if line.strip())

    print(f"Local logs: {local_events} events, {local_postings} postings")

    # Verify against MotherDuck if requested
    if verify_uploaded:
        if not HAS_DUCKDB:
            raise RuntimeError("duckdb package required for verification. Use --no-verify to skip.")

        token = motherduck_token or os.environ.get("MOTHERDUCK_TOKEN")
        if not token:
            raise RuntimeError("MOTHERDUCK_TOKEN not set. Use --no-verify to skip verification.")

        print(f"Verifying against MotherDuck ({motherduck_db})...")
        md = duckdb.connect(f"md:{motherduck_db}?motherduck_token={token}")

        try:
            remote_events = md.execute("SELECT COUNT(*) FROM controllog.events").fetchone()[0]
            remote_postings = md.execute("SELECT COUNT(*) FROM controllog.postings").fetchone()[0]
            print(f"MotherDuck: {remote_events} events, {remote_postings} postings")

            # Check that remote has at least as many records as local
            if remote_events < local_events:
                raise RuntimeError(
                    f"Verification failed: local has {local_events} events but MotherDuck only has {remote_events}. "
                    f"Run with --upload first, or use --no-verify to skip verification."
                )
            if remote_postings < local_postings:
                raise RuntimeError(
                    f"Verification failed: local has {local_postings} postings but MotherDuck only has {remote_postings}. "
                    f"Run with --upload first, or use --no-verify to skip verification."
                )

            print("Verification passed: MotherDuck has all local records")
        finally:
            md.close()

    # Collect files to delete
    files_to_delete = []

    # Controllog JSONL files
    for f in [events_file, postings_file]:
        if f.exists():
            files_to_delete.append(f)

    # Error logs JSONL files
    if error_logs_dir.exists():
        for f in error_logs_dir.glob("*.jsonl"):
            files_to_delete.append(f)

    # HTML error reports (optional)
    if delete_html:
        for f in base_dir.glob("error_analysis_*.html"):
            files_to_delete.append(f)

    # Calculate total bytes
    total_bytes = sum(f.stat().st_size for f in files_to_delete)

    # Delete or report
    for f in files_to_delete:
        size = f.stat().st_size
        if dry_run:
            print(f"  Would delete: {f} ({size:,} bytes)")
        else:
            f.unlink()
            print(f"  Deleted: {f} ({size:,} bytes)")

        result["files"].append(str(f))
        result["files_deleted"] += 1
        result["bytes_freed"] += size

    # Summary
    action = "Would delete" if dry_run else "Deleted"
    print(f"\n{action} {result['files_deleted']} files, freeing {result['bytes_freed']:,} bytes ({result['bytes_freed'] / 1024 / 1024:.1f} MB)")

    return result


def verify_motherduck_controllog(
    motherduck_token: str | None = None,
    motherduck_db: str = "bird_bench"
) -> dict[str, Any]:
    """
    Verify controllog data in MotherDuck and run trial balance.

    Args:
        motherduck_token: MotherDuck API token
        motherduck_db: MotherDuck database name

    Returns:
        Dictionary with verification results
    """
    if not HAS_DUCKDB:
        raise RuntimeError("duckdb package required")

    token = motherduck_token or os.environ.get("MOTHERDUCK_TOKEN")
    if not token:
        raise ValueError("MOTHERDUCK_TOKEN not set")

    md = duckdb.connect(f"md:{motherduck_db}?motherduck_token={token}")

    try:
        # Count records
        events = md.execute("SELECT COUNT(*) FROM controllog.events").fetchone()[0]
        postings = md.execute("SELECT COUNT(*) FROM controllog.postings").fetchone()[0]

        # Trial balance by (account_type, unit)
        trial_balance = md.execute("""
            SELECT
                account_type,
                unit,
                SUM(delta_numeric) as balance
            FROM controllog.postings
            GROUP BY account_type, unit
            HAVING ABS(SUM(delta_numeric)) > 0.0001
        """).fetchall()

        # Cost summary
        cost_summary = md.execute("""
            SELECT
                dims_json->>'model' as model,
                -SUM(delta_numeric) as total_cost
            FROM controllog.postings
            WHERE account_type = 'truth.money'
              AND account_id = 'project'
              AND unit = 'usd'
            GROUP BY dims_json->>'model'
        """).fetchall()

        # Event kinds
        event_kinds = md.execute("""
            SELECT kind, COUNT(*) as count
            FROM controllog.events
            GROUP BY kind
            ORDER BY count DESC
        """).fetchall()

        result = {
            "events": events,
            "postings": postings,
            "trial_balance_violations": trial_balance,
            "cost_by_model": {row[0]: row[1] for row in cost_summary if row[0]},
            "event_kinds": {row[0]: row[1] for row in event_kinds}
        }

        print(f"Controllog verification:")
        print(f"  Events: {events}")
        print(f"  Postings: {postings}")
        print(f"  Trial balance violations: {len(trial_balance)}")
        if trial_balance:
            for row in trial_balance:
                print(f"    - ({row[0]}, {row[1]}): {row[2]}")
        print(f"  Cost by model:")
        for model, cost in result["cost_by_model"].items():
            print(f"    - {model}: ${cost:.4f}")

        return result

    finally:
        md.close()
