"""SQL agent with a semantic-layer `semantic_lookup` tool.

Five tools, one loop:
  - `semantic_lookup` — the semantic layer (domains -> item summaries -> full bodies)
  - `list_tables`   — list tables/views in the target database
  - `list_columns`  — describe one table's columns
  - `query`         — run a SELECT, return up to 50 rows as text
  - `submit_answer` — submit the SQL whose result IS the answer

The agent always has a compact SKILL (procedure + where-knowledge-lives) in its
system prompt; the heavy domain knowledge is fetched on demand via semantic_lookup.
The DuckDB connection is MotherDuck-attached, so tools run against `md:<db>`.

Provider/usage/caching machinery is ported from agentic-sql-mini unchanged.
"""

from __future__ import annotations

import contextvars
import os
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

import duckdb
from agents import (
    Agent,
    Model,
    ModelProvider,
    ModelSettings,
    OpenAIChatCompletionsModel,
    Runner,
    function_tool,
)
from agents.run import RunConfig
from openai import AsyncOpenAI

from src.context_store import ContextStore, render_semantic_lookup
from src.score import ExecutionError

REPO_ROOT = Path(__file__).resolve().parents[1]
SKILL_PATH = REPO_ROOT / "skill" / "SKILL.md"

OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"


def _add_anthropic_cache_breakpoints(messages: list) -> list:
    """Mark the system message and the last message with cache_control so
    Anthropic prompt caching kicks in on OpenRouter. Returns a new list;
    inputs are not mutated."""
    if not messages:
        return messages
    out: list = []
    system_idx = next(
        (i for i, m in enumerate(messages) if m.get("role") == "system"), None
    )
    last_idx = len(messages) - 1
    for i, msg in enumerate(messages):
        if i == system_idx or i == last_idx:
            out.append(_with_cache_control(msg))
        else:
            out.append(msg)
    return out


def _with_cache_control(msg: dict) -> dict:
    """Convert a message's content into the block form with cache_control on
    the last block. No-op if content is already a list (we only set the flag
    on the final block to keep breakpoint count low)."""
    content = msg.get("content")
    if isinstance(content, str):
        blocks = [{"type": "text", "text": content,
                   "cache_control": {"type": "ephemeral"}}]
        return {**msg, "content": blocks}
    if isinstance(content, list) and content:
        new_blocks = list(content)
        last = dict(new_blocks[-1])
        last["cache_control"] = {"type": "ephemeral"}
        new_blocks[-1] = last
        return {**msg, "content": new_blocks}
    return msg


@dataclass
class Usage:
    """Per-task usage accumulator. One of these is set on `_usage_var` for
    the duration of a single `run_agent` call; the shared provider mutates
    it instead of its own instance attributes, so concurrent tasks don't
    cross-contaminate."""

    cost_usd: float = 0.0
    prompt_tokens: int = 0
    completion_tokens: int = 0
    cached_tokens: int = 0


# Per-task context. ContextVars propagate naturally across await points and
# through asyncio.gather, so each concurrent `run_agent` call sees its own
# Usage / on_thinking without any shared mutation on the provider.
_usage_var: contextvars.ContextVar[Usage | None] = contextvars.ContextVar(
    "asm_usage", default=None
)
_thinking_var: contextvars.ContextVar[Callable[[str], None] | None] = contextvars.ContextVar(
    "asm_thinking", default=None
)


class OpenRouterProvider(ModelProvider):
    """Minimal ModelProvider that routes requests through OpenRouter.

    Single shared client / connection pool — safe to use across many
    concurrent `run_agent` calls. Per-task usage and the per-task thinking
    callback live on contextvars, not on `self`, so there's no shared
    mutable state to race on. Call `aclose()` once when the eval is done."""

    def __init__(
        self,
        api_key: str | None = None,
        reasoning_effort: str | None = "medium",
    ) -> None:
        self._client = AsyncOpenAI(
            base_url=OPENROUTER_BASE_URL,
            api_key=api_key or os.environ.get("OPENROUTER_API_KEY", ""),
            default_headers={
                "HTTP-Referer": "https://github.com/motherduckdb/agentic-sql-claude-edition",
                "X-Title": "agentic-sql-claude-edition",
            },
            max_retries=8,
            timeout=120.0,
        )
        self.reasoning_effort = reasoning_effort
        self._wrap_client_for_tracking()

    async def aclose(self) -> None:
        await self._client.close()

    def _wrap_client_for_tracking(self) -> None:
        original_create = self._client.chat.completions.create

        async def tracked_create(*args, **kwargs):
            extra_body = dict(kwargs.get("extra_body") or {})
            extra_body.setdefault("usage", {"include": True})
            if self.reasoning_effort:
                extra_body.setdefault("reasoning", {"effort": self.reasoning_effort})
            kwargs["extra_body"] = extra_body
            # Anthropic models via OpenRouter need explicit cache_control
            # breakpoints — without them prompt caching never kicks in. We mark
            # the system prompt (the SKILL preamble) and the most-recent message
            # so both the static preamble and the growing tool-call history hit
            # cache on turn N+1. OpenAI/Gemini cache automatically.
            model = str(kwargs.get("model") or "")
            if "anthropic" in model or "claude" in model:
                kwargs["messages"] = _add_anthropic_cache_breakpoints(
                    kwargs.get("messages") or []
                )
            response = await original_create(*args, **kwargs)
            on_thinking = _thinking_var.get()
            if on_thinking is not None:
                try:
                    for choice in getattr(response, "choices", []) or []:
                        msg = getattr(choice, "message", None)
                        if msg is None:
                            continue
                        thinking = getattr(msg, "reasoning", None)
                        if not thinking:
                            details = getattr(msg, "reasoning_details", None)
                            if details:
                                parts = []
                                for d in details:
                                    text = getattr(d, "text", None) or (
                                        d.get("text") if isinstance(d, dict) else None
                                    )
                                    if text:
                                        parts.append(text)
                                thinking = "\n".join(parts) if parts else None
                        if thinking:
                            on_thinking(thinking)
                except Exception:
                    pass
            usage = getattr(response, "usage", None)
            cur = _usage_var.get()
            if usage and cur is not None:
                cost = getattr(usage, "cost", None)
                if isinstance(cost, (int, float)):
                    cur.cost_usd += float(cost)
                cur.prompt_tokens += int(getattr(usage, "prompt_tokens", 0) or 0)
                cur.completion_tokens += int(getattr(usage, "completion_tokens", 0) or 0)
                details = getattr(usage, "prompt_tokens_details", None)
                if details is not None:
                    cached = getattr(details, "cached_tokens", None)
                    if isinstance(cached, int):
                        cur.cached_tokens += cached
            return response

        self._client.chat.completions.create = tracked_create

    def get_model(self, model_name: str | None) -> Model:
        return OpenAIChatCompletionsModel(
            model=model_name or "google/gemini-3-flash-preview",
            openai_client=self._client,
        )


# ---------------------------------------------------------------------------
# Prompts
# ---------------------------------------------------------------------------

# Small, stable base. The bulk of "how to work" lives in SKILL.md (appended
# below); the bulk of "what the data means" lives in the context store, fetched
# on demand via semantic_lookup. Keep this lean — it is cached across questions.
_BASE_SYSTEM_PROMPT = """You are an expert data analyst. You answer factoid questions by querying a payments database with SQL via tools.

**Database:** {database}  (MotherDuck, DuckDB SQL). Schema: main.
Use fully-qualified names when helpful: `{database}.main.table_name`.

You have five tools:
- `semantic_lookup` — the semantic layer. Knowledge about this dataset (fee rules, bucketing, terminology, SQL patterns, answer formatting) is NOT in this prompt; you fetch it on demand. See the Semantic Layer section of the skill below.
- `list_tables` — list tables/views.
- `list_columns` — describe one table's columns.
- `query` — run a SELECT (returns up to 50 rows).
- `submit_answer` — submit the SQL whose result IS the final answer. Call exactly once; every run MUST end with it. An unsubmitted run scores zero.

Follow the skill below exactly.

============================== SKILL ==============================
{skill}
===================================================================
"""


def build_system_prompt(database: str, skill_text: str | None = None) -> str:
    if skill_text is None:
        skill_text = SKILL_PATH.read_text() if SKILL_PATH.exists() else "(skill file missing)"
    return _BASE_SYSTEM_PROMPT.format(database=database, skill=skill_text)


USER_PROMPT_TEMPLATE = """Question: {question}

Guidelines: {guidelines}

The validator is strict about output format — follow the guidelines exactly. If unsure about formatting, rounding, separators, or "Not Applicable" rules, fetch the `answer_format` context.
"""


@dataclass
class RunState:
    """Mutable state captured during one agent run."""

    conn: duckdb.DuckDBPyConnection
    store: ContextStore
    database: str
    final_sql: str | None = None
    final_rows: list[tuple] | ExecutionError | None = None
    submitted: bool = False
    tool_calls: list[dict] = field(default_factory=list)
    lock: threading.Lock = field(default_factory=threading.Lock)
    on_tool_call: Callable[[dict], None] | None = None
    max_turns: int = 40

    def record(self, call: dict) -> None:
        self.tool_calls.append(call)
        call.setdefault("turn", len(self.tool_calls))
        call.setdefault("max_turns", self.max_turns)
        if self.on_tool_call is not None:
            try:
                self.on_tool_call(call)
            except Exception:
                pass


_COUNTDOWN_THRESHOLD = 5


def _budget_suffix(state: RunState) -> str:
    remaining = state.max_turns - len(state.tool_calls)
    if 0 < remaining <= _COUNTDOWN_THRESHOLD:
        return (
            f"\n\n[{remaining} turn{'s' if remaining != 1 else ''} remaining — "
            f"submit your best-effort answer now if uncertain.]"
        )
    if remaining <= 0:
        return "\n\n[0 turns remaining — submit immediately.]"
    return ""


def _tool_timing_start() -> tuple[str, float]:
    return datetime.now(timezone.utc).isoformat(), time.perf_counter()


def _with_tool_timing(call: dict, start_time: str, start_perf: float) -> dict:
    end_time = datetime.now(timezone.utc).isoformat()
    call["start_time"] = start_time
    call["end_time"] = end_time
    call["duration_ms"] = int((time.perf_counter() - start_perf) * 1000)
    return call


def _attach_tool_timings(messages: list, tool_calls: list[dict]) -> list:
    """Add optional per-tool timing fields to existing trace messages.

    The Agents SDK exposes call IDs in ``to_input_list()`` but tool callbacks do
    not receive those IDs, so timings are matched by tool name in execution
    order. This keeps the exported trace backwards-compatible: old renderers
    ignore the added fields; new renderers can draw a time-scaled waterfall.
    """
    timed = [
        call for call in tool_calls
        if call.get("start_time") and call.get("end_time") and call.get("duration_ms") is not None
    ]
    if not messages or not timed:
        return messages

    used: set[int] = set()

    def pop_timing(name: str | None) -> dict | None:
        for idx, call in enumerate(timed):
            if idx in used:
                continue
            if name and call.get("tool") == name:
                used.add(idx)
                return call
        for idx, call in enumerate(timed):
            if idx not in used:
                used.add(idx)
                return call
        return None

    def apply_timing(target: dict, timing: dict) -> None:
        target.setdefault("start_time", timing.get("start_time"))
        target.setdefault("end_time", timing.get("end_time"))
        target.setdefault("duration_ms", timing.get("duration_ms"))

    pending: dict[str, tuple[str | None, dict]] = {}
    for msg in messages:
        if not isinstance(msg, dict):
            continue
        item_type = msg.get("type")
        role = msg.get("role")

        if item_type == "function_call":
            call_id = str(msg.get("call_id") or msg.get("id") or "")
            if call_id:
                pending[call_id] = (msg.get("name"), msg)
            continue

        if item_type == "function_call_output":
            call_id = str(msg.get("call_id") or "")
            name, call_msg = pending.pop(call_id, (None, {}))
            timing = pop_timing(name)
            if timing:
                if call_msg:
                    apply_timing(call_msg, timing)
                apply_timing(msg, timing)
            continue

        if role == "assistant":
            for tc in msg.get("tool_calls") or []:
                if not isinstance(tc, dict):
                    continue
                fn = tc.get("function") if isinstance(tc.get("function"), dict) else None
                src = fn if fn is not None else tc
                call_id = str(tc.get("id") or "")
                if call_id:
                    pending[call_id] = (src.get("name"), tc)
            continue

        if role in ("tool", "function_call_output"):
            call_id = str(msg.get("tool_call_id") or msg.get("call_id") or "")
            name, call_msg = pending.pop(call_id, (msg.get("name"), {}))
            timing = pop_timing(name)
            if timing:
                if call_msg:
                    apply_timing(call_msg, timing)
                apply_timing(msg, timing)

    return messages


def _make_tools(state: RunState) -> list:
    def _execute(sql: str, fetchmany: int | None = None):
        with state.lock:
            cur = state.conn.cursor()
            try:
                cur.execute(sql)
                cols = [d[0] for d in cur.description] if cur.description else []
                rows = cur.fetchmany(fetchmany) if fetchmany else cur.fetchall()
            finally:
                cur.close()
        return cols, rows

    @function_tool
    def semantic_lookup(domains: list[str] | None = None, ids: list[str] | None = None) -> str:
        """Fetch dataset knowledge progressively (the semantic layer).

        - Call with NO arguments to list the knowledge domains.
        - Call with `domains` (e.g. ["fees", "bucketing"]) to list the context
          items in those domains: each is `id — one-line summary`.
        - Call with `ids` (e.g. ["fees-matching-9dim"]) to read the FULL text of
          those items. You may pass several ids at once.
        """
        start_time, start_perf = _tool_timing_start()
        out = render_semantic_lookup(state.store, domains=domains, ids=ids)
        state.record(
            _with_tool_timing({
                "tool": "semantic_lookup",
                "domains": domains,
                "ids": ids,
                "result_chars": len(out),
            }, start_time, start_perf)
        )
        return out + _budget_suffix(state)

    @function_tool
    def list_tables() -> str:
        """List all tables and views in the database."""
        start_time, start_perf = _tool_timing_start()
        _, rows = _execute(
            "SELECT table_schema, table_name FROM information_schema.tables "
            f"WHERE table_catalog = '{state.database}' "
            "AND table_schema NOT IN ('information_schema', 'pg_catalog') "
            "ORDER BY table_schema, table_name"
        )
        state.record(_with_tool_timing({"tool": "list_tables", "result_rows": len(rows)}, start_time, start_perf))
        body = "(no tables)" if not rows else "\n".join(f"{s}.{t}" for s, t in rows)
        return body + _budget_suffix(state)

    @function_tool
    def list_columns(table: str) -> str:
        """Describe a table's columns. Accepts `name`, `schema.name`, or `db.schema.name`."""
        start_time, start_perf = _tool_timing_start()
        try:
            _, rows = _execute(f"DESCRIBE {table}")
        except Exception as e:
            state.record(_with_tool_timing({"tool": "list_columns", "table": table, "error": str(e)}, start_time, start_perf))
            return f"ERROR: {e}" + _budget_suffix(state)
        state.record(_with_tool_timing({"tool": "list_columns", "table": table, "cols": len(rows)}, start_time, start_perf))
        body = "\n".join(f"  {r[0]}: {r[1]}" for r in rows)
        return body + _budget_suffix(state)

    @function_tool
    def query(sql: str) -> str:
        """Run a SELECT and return up to 50 rows as text."""
        start_time, start_perf = _tool_timing_start()
        try:
            cols, rows = _execute(sql, fetchmany=50)
        except Exception as e:
            state.record(_with_tool_timing({"tool": "query", "sql": sql, "error": str(e)}, start_time, start_perf))
            return f"ERROR: {e}" + _budget_suffix(state)
        state.record(_with_tool_timing({"tool": "query", "sql": sql, "rows": len(rows)}, start_time, start_perf))
        if not rows:
            return "(no rows)" + _budget_suffix(state)
        header = " | ".join(cols)
        body = "\n".join(" | ".join(str(v) for v in r) for r in rows)
        return f"{header}\n{body}" + _budget_suffix(state)

    @function_tool
    def submit_answer(sql: str) -> str:
        """Submit the SQL whose result IS the answer. Call once with working SQL."""
        with state.lock:
            if state.submitted:
                return "ERROR: answer already submitted"
        start_time, start_perf = _tool_timing_start()
        # Execute FIRST. Only latch the submission on success — a SQL error here
        # must NOT end the run, or a single typo would lock the agent out of
        # resubmitting a corrected query.
        try:
            _, rows = _execute(sql)
        except Exception as e:
            state.record(_with_tool_timing({"tool": "submit_answer", "sql": sql, "error": str(e)}, start_time, start_perf))
            return (
                f"Your submitted SQL failed to execute: {e}\n"
                "The answer was NOT recorded. Fix the SQL and call submit_answer "
                "again with a corrected query." + _budget_suffix(state)
            )
        with state.lock:
            state.submitted = True
            state.final_sql = sql
            state.final_rows = rows
        state.record(_with_tool_timing({"tool": "submit_answer", "sql": sql, "rows": len(rows)}, start_time, start_perf))
        return f"Submitted. {len(rows)} rows."

    return [semantic_lookup, list_tables, list_columns, query, submit_answer]


@dataclass
class AgentRun:
    final_sql: str | None
    final_rows: list[tuple] | ExecutionError | None
    hit_limit: bool
    tool_calls: list[dict]
    raw_output: str
    messages: list | None = None  # Responses-API conversation trace (for controllog-viz)
    cost_usd: float = 0.0
    prompt_tokens: int = 0
    completion_tokens: int = 0
    cached_tokens: int = 0


async def run_agent(
    *,
    conn: duckdb.DuckDBPyConnection,
    store: ContextStore,
    database: str,
    question: str,
    guidelines: str | None,
    model: str,
    provider: OpenRouterProvider,
    skill_text: str | None = None,
    max_turns: int = 40,
    temperature: float = 0.0,
    on_tool_call: Callable[[dict], None] | None = None,
    on_thinking: Callable[[str], None] | None = None,
) -> AgentRun:
    """Run the agent on a single question against `conn`. Safe to call
    concurrently with the same `provider`."""
    state = RunState(
        conn=conn,
        store=store,
        database=database,
        on_tool_call=on_tool_call,
        max_turns=max_turns,
    )
    tools = _make_tools(state)

    agent = Agent(
        name="asc-sql",
        instructions=build_system_prompt(database, skill_text),
        tools=tools,
        model_settings=ModelSettings(temperature=temperature, max_tokens=16384),
    )

    user_msg = USER_PROMPT_TEMPLATE.format(
        question=question,
        guidelines=guidelines or "(none)",
    )

    usage = Usage()
    usage_token = _usage_var.set(usage)
    thinking_token = _thinking_var.set(on_thinking)
    result: Any
    hit_limit = False
    raw_output = ""
    run_config = RunConfig(
        model=model,
        model_provider=provider,
        tracing_disabled=True,
    )
    try:
        try:
            result = await Runner.run(
                agent, user_msg, run_config=run_config, max_turns=max_turns,
            )
            raw_output = str(getattr(result, "final_output", "") or "")
        except Exception as e:
            if "max" in str(e).lower() and "turn" in str(e).lower():
                hit_limit = True
            else:
                raise

        # Recovery: if the agent stopped without submitting, force one retry.
        if (
            not state.submitted
            and not hit_limit
            and result is not None
            and len(state.tool_calls) < max_turns
        ):
            try:
                follow_up = result.to_input_list() + [{
                    "role": "user",
                    "content": (
                        "You have not successfully submitted an answer (you either "
                        "never called `submit_answer` or your submitted SQL errored "
                        "and was not recorded). That is required — an unsubmitted run "
                        "scores zero. Call `submit_answer` now with working SQL based "
                        "on what you've discovered. If the question is unanswerable "
                        "from the data, submit `SELECT 'Not Applicable'`."
                    ),
                }]
                remaining = max(2, max_turns - len(state.tool_calls))
                result = await Runner.run(
                    agent, follow_up, run_config=run_config, max_turns=remaining,
                )
                raw_output = str(getattr(result, "final_output", "") or "")
            except Exception as e:
                if "max" in str(e).lower() and "turn" in str(e).lower():
                    hit_limit = True
    finally:
        _usage_var.reset(usage_token)
        _thinking_var.reset(thinking_token)

    if not state.submitted and not hit_limit:
        hit_limit = True

    # Capture the full conversation (Responses-API items: reasoning / function_call /
    # function_call_output / message) so controllog-viz can render the trace.
    messages: list | None = None
    try:
        if result is not None:
            messages = _attach_tool_timings(result.to_input_list(), state.tool_calls)
    except Exception:
        messages = None

    return AgentRun(
        final_sql=state.final_sql,
        final_rows=state.final_rows,
        hit_limit=hit_limit,
        tool_calls=state.tool_calls,
        raw_output=raw_output,
        messages=messages,
        cost_usd=usage.cost_usd,
        prompt_tokens=usage.prompt_tokens,
        completion_tokens=usage.completion_tokens,
        cached_tokens=usage.cached_tokens,
    )
