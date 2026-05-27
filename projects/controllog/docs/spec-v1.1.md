# Controllog v1.1
## Telemetry Is Not Enough for Non-Deterministic Systems

A drop-in replacement for traditional logging in AI / agentic systems, based on
accounting and cybernetic control primitives.

This spec reflects real-world implementation learnings from
`based-eval/shared/controllog` and is intended to be reused across projects.

---

## 0. What This Is

Controllog is a controllable logging system built around two primitives:

- Events: immutable facts ("what happened")
- Postings: balanced deltas applied to accounts ("what changed")

The core invariant is conservation: postings must net to zero across defined
surfaces (time, money, state, utility). This enables deterministic auditability
in fundamentally non-deterministic systems.

---

## 1. Goals / Non-Goals

### Goals
- Drop-in replacement for `logger.info(...)`
- Deterministic audit trail for AI agents
- Early detection of missing, duplicated, or inconsistent work
- Cheap to operate (append-only JSONL → MotherDuck)

### Non-Goals
- Not a tracing/APM system
- Not metrics-first (metrics are derived)
- Not a scheduler, router, or evaluator

---

## 2. Core Primitives

### 2.1 Event

An event is an immutable fact.

Required fields (logical schema):
- event_id (unique)
- event_time (UTC)
- kind (string enum)
- project_id
- source (e.g. runtime)
- idempotency_key
- payload_json (freeform)

Optional but recommended:
- run_id
- actor_agent_id
- actor_task_id

Events are written to:

controllog.events

---

### 2.2 Posting

A posting applies a signed delta to an account.

Logical fields:
- posting_id
- event_id (FK)
- account_type (e.g. truth.money)
- account_id, namespaced by role (e.g. `project:<project_id>`, `provider:<name>`, `vendor:<name>`, `agent:<agent_id>`, `task:<task_id>`)
- unit (e.g. usd, ms, task_status)
- delta_numeric (signed)
- dims_json (dimensions)

Postings are written to:

controllog.postings

---

## 3. Transport: JSONL (Append-Only)

### 3.1 Initialization

```python
controllog.init(
  project_id: str,
  log_dir: Path,
  default_dims: dict | None
)
```

* Writes JSONL locally
* Uploads asynchronously (optional)
* Raw payloads preserved by default

### 3.2 File Layout

```
<log_dir>/
  controllog/
    events.jsonl
    postings.jsonl
```

Each line is one JSON object.

---

## 4. API Surface

### 4.1 Core Emit

```python
controllog.event(
  kind: str,
  actor: dict | None,
  run_id: str | None,
  payload: dict | None,
  postings: list[dict],
  idempotency_key: str,
  source: str = "runtime"
)
```

Rules:

* Events with postings must balance
* idempotency_key is required for retriable work

---

## 5. Model Calls: Two-Phase Pattern (Required)

### 5.1 Phases

Every model call is represented as two events:

1. model_prompt
2. model_completion

Both share a common exchange_id.

Each has its own idempotency key:

* `<exchange_id>:prompt`
* `<exchange_id>:completion`

### 5.2 Why This Matters

* Prompt is logged even if completion fails
* Clean reconciliation with provider data
* Phase-specific latency and cost attribution

---

## 6. Task Lifecycle: truth.state

Required lifecycle per task:

1. NEW → WIP (exactly once)
2. One terminal transition:

   * WIP → DONE
   * WIP → FAILED

Rules:

* Terminal transitions are unique
* Retries do not leave WIP
* State transitions must be balanced postings

---

## 7. Accounts (Minimum Set)

### 7.1 truth.money

Tracks cost.

Convention:

* \* provider
* \* project

### 7.2 truth.time

Tracks latency/time.

* Completion events carry agent-side wall time

### 7.3 truth.state

Tracks lifecycle transitions (conserved)

### 7.4 truth.utility (optional)

Tracks reward/score

### 7.5 Extension namespaces

Implementations MAY add account types outside the `truth.*` namespace. The
convention is:

* `truth.*` — accounts whose unit is comparable across models, runs, and
  vendors (USD, wall-clock ms, lifecycle state, normalized utility).
  Always meaningful to sum, average, or compare cross-run.
* `resource.*` — accounts whose unit is system-specific and **not**
  comparable across implementations. Tokens are the canonical example:
  1000 GPT tokens ≠ 1000 Claude tokens ≠ 1000 Gemini tokens because
  tokenizers differ.

Extension accounts MUST still balance per event (§ 8.1) and across slices
(§ 8.2). The invariant checker treats `truth.*` and `resource.*` identically;
the distinction is semantic, not enforcement.

Reference implementation uses `resource.tokens` (unit `+tokens`) to track
prompt and completion token flow between `provider:{name}` and
`project:{id}`.

---

## 8. Invariants

### 8.1 Double-Entry (Per Event)

For each (account_type, unit):

SUM(delta_numeric) == 0

### 8.2 Trial Balance (Any Slice)

For any filtered slice of data:

SUM(delta_numeric) == 0

### 8.3 Exchange Completeness

For each exchange_id:

* exactly one prompt
* exactly one completion (even on failure)

---

## 9. Reporting (Derived)

### 9.1 Why Flows Sum to Zero

Because postings conserve value.

Rule:
Compute flows from one side only (e.g. project).

Example:

```sql
cost = -SUM(delta_numeric)
WHERE account_type = 'truth.money'
  AND account_id LIKE 'project:%'
```

### 9.2 Ops Latency

* Use completion events only
* Use agent-side time postings
* Ignore prompt/queue phases

---

## 10. MotherDuck Integration

### 10.1 Schema

Use a dedicated schema:

controllog.events
controllog.postings

Avoid search_path ambiguity.

### 10.2 Column Stability

Do not rename core columns.
Extend via new columns only.

---

## 11. Idempotency & Correlation

Two identifiers:

* exchange_id: groups logical work
* idempotency_key: dedupes emission

Recommended default:

exchange_id = UUIDv7
idempotency_key = f"{exchange_id}:{phase}"

Deterministic keys may hash stable inputs if needed.

---

## 12. Privacy Mode

Optional fields for strict environments:

* request_hash
* response_hash

Allows lineage without raw text.

---

## 13. Backpressure Rule

When saturated:

* Must persist postings
* May drop payload_json

Never lie about postings.

---

## 14. Recommended Dims Baseline

Whitelist:

* model
* provider
* phase (prompt, completion)
* optional domain dims (e.g. agent_role)

Dims should be:

* small
* enumerable
* safe to group by

---

## 15. Learn & Maintain Events

### 15.1 Learn Events

The learn command emits three event kinds tracking the knowledge extraction lifecycle:

| Kind | When | Key Payload Fields |
|------|------|--------------------|
| `learn_start` | Beginning of a learn run | benchmark, database, model, total_questions, mode, max_concurrent |
| `learn_question` | After each question is processed | question_id, surface_routed, fragments_written, comments_written, schema_comments_written, guide_updated, view_candidates_logged, duration_ms, cost_usd, error |
| `learn_complete` | End of a learn run | total_questions, total_fragments, total_comments, total_schema_comments, guide_updates, view_candidates, errors, total_cost_usd, duration_ms |

Postings:
- `learn_question`: optional `truth.money` (vendor:openrouter <-> project) when cost_usd is present
- `learn_start` / `learn_complete`: no postings (lifecycle markers)

Idempotency keys:
- `learn_start`: `{run_id}:learn_start`
- `learn_question`: `{run_id}:learn_question:{question_id}`
- `learn_complete`: `{run_id}:learn_complete`

### 15.2 Maintain Events

The maintain command emits three event kinds tracking the maintenance pipeline lifecycle:

| Kind | When | Key Payload Fields |
|------|------|--------------------|
| `maintain_start` | Beginning of a maintain run | benchmark, database, model, operations, dry_run |
| `maintain_action` | After each plan action executes | operation, action_type, fragment_id, success, error |
| `maintain_complete` | End of a maintain run | plan_summary, applied, errors, llm_calls, estimated_cost_usd, transaction_id, duration_ms |

Postings:
- `maintain_complete`: optional `truth.money` (vendor:openrouter <-> project) when estimated_cost_usd > 0
- `maintain_start` / `maintain_action`: no postings (lifecycle markers)

Idempotency keys:
- `maintain_start`: `{run_id}:maintain_start`
- `maintain_action`: auto-generated event_id (actions are not retriable)
- `maintain_complete`: `{run_id}:maintain_complete`

---

## 16. Summary

Controllog replaces passive telemetry with active control:

* Events give memory
* Postings enforce invariants
* Trial balance detects drift
* Reports become trustworthy
* Non-determinism becomes manageable

Telemetry observes.
Controllog controls.
