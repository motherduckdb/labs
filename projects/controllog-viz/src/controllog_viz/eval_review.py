"""Rich evaluation review — full feature parity with agentic-sql's dabstep_review.html.

When a run contains ``evaluation_result`` events, its payloads carry the complete
per-question detail (question, predicted/gold SQL, results, correctness, cost/tokens,
and ``raw_response.messages`` — the full agent conversation). This module rebuilds the
reference review from those events: question-by-question cards, a chain-of-thought
conversation explorer, top-level filters (status/model/tier/category), a stats bar,
per-question comment export, expand/collapse, and keyboard shortcuts.

Ported from ``evaluation/error_report.py`` in agentic-sql, adapted to read through the
controllog-viz reader (so it works identically over JSONL or MotherDuck) and scoped to
a single run_id.
"""
from __future__ import annotations

import contextlib
import html as _html_module
import json
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

import duckdb

LEVEL_ORDER = {
    "error": 0,
    "hit_limit": 1,
    "incorrect": 2,
    "partial": 3,
    "correct": 4,
    "judge_correct": 4,
}

QUESTION_PREVIEW_LENGTH = 100
MAX_RESULT_ROWS = 20


# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------


@dataclass
class ErrorCard:
    """All data for one card in the report."""

    question_id: str
    db_id: str
    question_text: str
    evidence: str | None
    model: str
    config_type: str
    database: str
    predicted_sql: str | None
    gold_sql: str | None
    gold_result: Any
    predicted_result: Any
    is_correct: bool
    correctness_level: str
    match_source: str | None
    partial_reason: str | None
    hit_iteration_limit: bool
    score: float
    tool_calls: int
    sql_errors: int
    query_count: int
    total_sql_time_ms: float
    duration_ms: float
    cost_usd: float | None
    input_tokens: int
    output_tokens: int
    raw_response: dict | None = None
    error_category: str | None = None
    error_description: str | None = None
    answer_source: str | None = None


@dataclass
class ReportData:
    """Container for all report data."""

    cards: list[ErrorCard]
    title: str
    generated_at: str
    total: int = 0
    correct_count: int = 0
    error_count: int = 0
    hit_limit_count: int = 0
    incorrect_count: int = 0
    partial_count: int = 0


# ---------------------------------------------------------------------------
# Data loading — from the controllog-viz reader (events view), scoped to a run
# ---------------------------------------------------------------------------


def has_eval_results(con: duckdb.DuckDBPyConnection, run_id: str | None) -> bool:
    """True if the run has any ``evaluation_result`` events (→ use the rich review)."""
    n = con.execute(
        "SELECT COUNT(*) FROM events WHERE kind = 'evaluation_result' "
        "AND run_id IS NOT DISTINCT FROM ?",
        [run_id],
    ).fetchone()[0]
    return n > 0


def build_report_data(con: duckdb.DuckDBPyConnection, run_id: str | None, title: str) -> ReportData:
    """Build ReportData from the run's ``evaluation_result`` events."""
    rows = con.execute(
        "SELECT CAST(payload_json AS VARCHAR) FROM events "
        "WHERE kind = 'evaluation_result' AND run_id IS NOT DISTINCT FROM ? "
        "ORDER BY event_time",
        [run_id],
    ).fetchall()

    cards: list[ErrorCard] = []
    for (payload_raw,) in rows:
        payload = json.loads(payload_raw) if isinstance(payload_raw, str) else payload_raw
        cards.append(
            ErrorCard(
                question_id=str(payload.get("question_id", "")),
                db_id=payload.get("db_id", ""),
                question_text=payload.get("question_text", ""),
                evidence=payload.get("evidence"),
                model=payload.get("model", ""),
                config_type=payload.get("config_type", ""),
                database=payload.get("database", ""),
                predicted_sql=payload.get("predicted_sql"),
                gold_sql=payload.get("gold_sql"),
                gold_result=payload.get("gold_result"),
                predicted_result=payload.get("predicted_result"),
                is_correct=payload.get("is_correct", False),
                correctness_level=payload.get("correctness_level", "incorrect"),
                match_source=payload.get("match_source"),
                partial_reason=payload.get("partial_reason"),
                hit_iteration_limit=payload.get("hit_iteration_limit", False),
                score=1.0 if payload.get("is_correct", False) else 0.0,
                tool_calls=payload.get("tool_calls", 0),
                sql_errors=payload.get("sql_errors", 0),
                query_count=payload.get("query_count", 0),
                total_sql_time_ms=payload.get("total_sql_time_ms", 0.0),
                duration_ms=payload.get("duration_ms", 0.0),
                cost_usd=payload.get("cost_usd"),
                input_tokens=payload.get("input_tokens", 0),
                output_tokens=payload.get("output_tokens", 0),
                raw_response=payload.get("raw_response"),
                error_category=payload.get("error_category"),
                error_description=payload.get("error_description"),
                answer_source=payload.get("answer_source"),
            )
        )

    cards.sort(key=_card_sort_key)
    return _build_report_data(cards, title)


def _card_sort_key(card: ErrorCard) -> tuple:
    """Errors first, then hit_limit, incorrect, partial, correct; then question_id."""
    return (LEVEL_ORDER.get(card.correctness_level, 3), card.question_id)


def _build_report_data(cards: list[ErrorCard], title: str) -> ReportData:
    total = len(cards)
    correct = sum(1 for c in cards if c.correctness_level in ("correct", "judge_correct"))
    error = sum(1 for c in cards if c.correctness_level == "error")
    hit_limit = sum(1 for c in cards if c.correctness_level == "hit_limit")
    incorrect = sum(1 for c in cards if c.correctness_level == "incorrect")
    partial = sum(1 for c in cards if c.correctness_level == "partial")
    return ReportData(
        cards=cards,
        title=title,
        generated_at=datetime.now(UTC).isoformat(),
        total=total,
        correct_count=correct,
        error_count=error,
        hit_limit_count=hit_limit,
        incorrect_count=incorrect,
        partial_count=partial,
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _escape(text: str | None) -> str:
    if text is None:
        return ""
    return _html_module.escape(str(text))


def _format_result(result: Any) -> str:
    """Format an evaluation result for display, truncating at MAX_RESULT_ROWS."""
    if result is None:
        return "No result"
    if isinstance(result, str):
        return _escape(result)
    if isinstance(result, (list, tuple)):
        if len(result) == 0:
            return "Empty result set"
        display = list(result[:MAX_RESULT_ROWS])
        text = json.dumps(display, indent=2, default=str)
        if len(result) > MAX_RESULT_ROWS:
            text += f"\n... ({len(result) - MAX_RESULT_ROWS} more rows)"
        return _escape(text)
    if isinstance(result, dict):
        return _escape(json.dumps(result, indent=2, default=str))
    return _escape(str(result))


def _model_short_name(model: str) -> str:
    return model.split("/")[-1] if "/" in model else model


# ---------------------------------------------------------------------------
# COT trace rendering (the conversation explorer)
# ---------------------------------------------------------------------------


def _render_cot_trace(raw_response: dict | None, card: ErrorCard) -> str:
    """Render Chain-of-Thought trace HTML from raw_response messages.

    Supports both OpenAI Chat Completions format and OpenAI Responses API format.
    Falls back to a metadata summary when no trace is available.
    """
    if raw_response is None or not isinstance(raw_response, dict):
        return _render_metadata_fallback(card)

    messages = raw_response.get("messages", [])
    if not messages:
        return _render_metadata_fallback(card)

    parts = []

    ctx_messages = raw_response.get("context_agent_messages", [])
    if ctx_messages:
        ctx_is_responses = any(
            isinstance(m, dict) and m.get("type") in (
                "function_call", "function_call_output", "message", "reasoning",
            )
            for m in ctx_messages
        )
        ctx_trace = (
            _render_responses_api_trace(ctx_messages, card)
            if ctx_is_responses
            else _render_chat_completions_trace(ctx_messages, card)
        )
        parts.append(
            '<details open><summary style="font-weight:bold;cursor:pointer;">'
            '🔍 Context Agent Trace</summary>' + ctx_trace + '</details>'
        )

    is_responses_api = any(
        isinstance(m, dict) and m.get("type") in (
            "function_call", "function_call_output", "message", "reasoning",
        )
        for m in messages
    )

    main_trace = (
        _render_responses_api_trace(messages, card)
        if is_responses_api
        else _render_chat_completions_trace(messages, card)
    )
    if parts:
        parts.append(
            '<details open><summary style="font-weight:bold;cursor:pointer;">'
            '🤖 Main Agent Trace</summary>' + main_trace + '</details>'
        )
        return "\n".join(parts)
    return main_trace


def _extract_text_from_content_blocks(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(
            block.get("text", "") if isinstance(block, dict) else str(block)
            for block in content
        )
    return str(content or "")


def _render_responses_api_trace(messages: list, card: ErrorCard) -> str:
    """Render CoT trace from OpenAI Responses API format (Agents SDK)."""
    parts: list[str] = []
    thinking_count = 0
    tool_call_count = 0
    pending_calls: dict[str, dict] = {}

    for msg in messages:
        if not isinstance(msg, dict):
            continue

        item_type = msg.get("type", "")
        role = msg.get("role", "")

        if not item_type and role == "user":
            content = _extract_text_from_content_blocks(msg.get("content", ""))
            if content.strip():
                parts.append(
                    f'<details class="cot-section user" open>'
                    f"<summary>USER PROMPT</summary>"
                    f'<div class="cot-content"><pre>{_escape(content)}</pre></div>'
                    f"</details>"
                )

        elif not item_type and role == "system":
            content = _extract_text_from_content_blocks(msg.get("content", ""))
            if content.strip():
                parts.append(
                    f'<details class="cot-section system">'
                    f"<summary>SYSTEM PROMPT ({len(content)} chars)</summary>"
                    f'<div class="cot-content"><pre>{_escape(content)}</pre></div>'
                    f"</details>"
                )

        elif item_type == "message" and role == "assistant":
            content = _extract_text_from_content_blocks(msg.get("content", ""))
            if content.strip():
                if "FINAL_SQL:" in content:
                    parts.append(
                        f'<details class="cot-section final" open>'
                        f"<summary>FINAL ANSWER</summary>"
                        f'<div class="cot-content"><pre>{_escape(content)}</pre></div>'
                        f"</details>"
                    )
                else:
                    thinking_count += 1
                    parts.append(
                        f'<details class="cot-section thinking">'
                        f"<summary>THINKING #{thinking_count}</summary>"
                        f'<div class="cot-content"><pre>{_escape(content)}</pre></div>'
                        f"</details>"
                    )

        elif item_type == "reasoning":
            summary_text = _extract_text_from_content_blocks(msg.get("summary", []))
            content_text = _extract_text_from_content_blocks(msg.get("content", []))
            text = content_text or summary_text
            if text.strip():
                thinking_count += 1
                parts.append(
                    f'<details class="cot-section thinking">'
                    f"<summary>THINKING #{thinking_count}</summary>"
                    f'<div class="cot-content"><pre>{_escape(text)}</pre></div>'
                    f"</details>"
                )

        elif item_type == "function_call":
            call_id = msg.get("call_id", msg.get("id", ""))
            func_name = msg.get("name", "unknown")
            args = msg.get("arguments", "{}")
            if isinstance(args, str):
                with contextlib.suppress(json.JSONDecodeError, ValueError):
                    args = json.loads(args)
            args_str = json.dumps(args, indent=2) if isinstance(args, dict) else str(args)
            pending_calls[call_id] = {"name": func_name, "args": args_str}

        elif item_type == "function_call_output":
            call_id = msg.get("call_id", "")
            output = msg.get("output", "")
            if isinstance(output, (dict, list)):
                result_str = json.dumps(output, indent=2, default=str)
            else:
                result_str = str(output)

            tc_info = pending_calls.pop(call_id, None)
            tool_call_count += 1

            if tc_info:
                parts.append(
                    f'<details class="cot-section tool">'
                    f'<summary>TOOL CALL #{tool_call_count} - {_escape(tc_info["name"])}</summary>'
                    f'<div class="cot-content">'
                    f'<div class="tool-args-label">Arguments:</div>'
                    f'<pre class="tool-args">{_escape(tc_info["args"])}</pre>'
                    f'<div class="tool-result-label">Result:</div>'
                    f'<pre class="tool-result">{_escape(result_str)}</pre>'
                    f"</div></details>"
                )
            else:
                parts.append(
                    f'<details class="cot-section tool">'
                    f"<summary>TOOL RESULT #{tool_call_count}</summary>"
                    f'<div class="cot-content">'
                    f'<pre class="tool-result">{_escape(result_str)}</pre>'
                    f"</div></details>"
                )

    for _call_id, tc_info in pending_calls.items():
        tool_call_count += 1
        parts.append(
            f'<details class="cot-section tool">'
            f'<summary>TOOL CALL #{tool_call_count} - {_escape(tc_info["name"])} (no response)</summary>'
            f'<div class="cot-content">'
            f'<div class="tool-args-label">Arguments:</div>'
            f'<pre class="tool-args">{_escape(tc_info["args"])}</pre>'
            f"</div></details>"
        )

    return "\n".join(parts) if parts else _render_metadata_fallback(card)


def _render_chat_completions_trace(messages: list, card: ErrorCard) -> str:
    """Render CoT trace from OpenAI Chat Completions format (bird-bench style)."""
    parts: list[str] = []
    thinking_count = 0
    response_number = 0
    pending_tool_calls: dict[str, dict] = {}
    pending_tool_calls_order: list[str] = []

    for msg in messages:
        if not isinstance(msg, dict):
            continue

        role = msg.get("role", "")
        content = _extract_text_from_content_blocks(msg.get("content", ""))

        if role == "system":
            if content:
                parts.append(
                    f'<details class="cot-section system">'
                    f"<summary>SYSTEM PROMPT ({len(content)} chars)</summary>"
                    f'<div class="cot-content"><pre>{_escape(content)}</pre></div>'
                    f"</details>"
                )

        elif role == "user":
            if content:
                parts.append(
                    f'<details class="cot-section user" open>'
                    f"<summary>USER PROMPT</summary>"
                    f'<div class="cot-content"><pre>{_escape(content)}</pre></div>'
                    f"</details>"
                )

        elif role == "assistant":
            thinking = msg.get("thinking")
            if thinking and isinstance(thinking, str) and thinking.strip():
                thinking_count += 1
                parts.append(
                    f'<details class="cot-section thinking">'
                    f"<summary>THINKING #{thinking_count}</summary>"
                    f'<div class="cot-content"><pre>{_escape(thinking)}</pre></div>'
                    f"</details>"
                )

            if content and content.strip():
                if "FINAL_SQL:" in content:
                    parts.append(
                        f'<details class="cot-section final" open>'
                        f"<summary>FINAL ANSWER</summary>"
                        f'<div class="cot-content"><pre>{_escape(content)}</pre></div>'
                        f"</details>"
                    )
                else:
                    thinking_count += 1
                    parts.append(
                        f'<details class="cot-section thinking">'
                        f"<summary>THINKING #{thinking_count}</summary>"
                        f'<div class="cot-content"><pre>{_escape(content)}</pre></div>'
                        f"</details>"
                    )

            tool_calls = msg.get("tool_calls") or []
            if tool_calls:
                response_number += 1
            total_in_response = len(tool_calls)
            for position, tc in enumerate(tool_calls):
                # Chat Completions nests name/arguments under "function";
                # fall back to the flat shape for already-normalized traces.
                fn = tc.get("function") if isinstance(tc.get("function"), dict) else None
                src = fn if fn is not None else tc
                func_name = src.get("name", "unknown")
                tc_id = tc.get("id", str(len(pending_tool_calls_order)))
                args = src.get("arguments", "{}")
                if isinstance(args, str):
                    with contextlib.suppress(json.JSONDecodeError, ValueError):
                        args = json.loads(args)
                args_str = json.dumps(args, indent=2) if isinstance(args, dict) else str(args)

                pending_tool_calls[tc_id] = {
                    "name": func_name,
                    "args": args_str,
                    "response_num": response_number,
                    "position": position,
                    "total_in_response": total_in_response,
                }
                pending_tool_calls_order.append(tc_id)

        elif role in ("tool", "function_call_output"):
            tool_call_id = msg.get("tool_call_id", msg.get("call_id", ""))
            tool_name = msg.get("tool_name", msg.get("name", "unknown"))
            tool_result = msg.get("result", msg.get("content", msg.get("output", {})))

            if isinstance(tool_result, (dict, list)):
                result_str = json.dumps(tool_result, indent=2, default=str)
            else:
                result_str = str(tool_result)

            tc_info = None
            if tool_call_id and tool_call_id in pending_tool_calls:
                tc_info = pending_tool_calls.pop(tool_call_id)
                if tool_call_id in pending_tool_calls_order:
                    pending_tool_calls_order.remove(tool_call_id)
            elif pending_tool_calls_order:
                first_id = pending_tool_calls_order.pop(0)
                tc_info = pending_tool_calls.pop(first_id, None)

            if tc_info:
                resp_num = tc_info.get("response_num", 1)
                total = tc_info.get("total_in_response", 1)
                pos = tc_info.get("position", 0)
                label = f"{resp_num}{chr(ord('a') + pos)}" if total > 1 else str(resp_num)

                parts.append(
                    f'<details class="cot-section tool">'
                    f'<summary>TOOL CALL #{label} - {_escape(tc_info["name"])}</summary>'
                    f'<div class="cot-content">'
                    f'<div class="tool-args-label">Arguments:</div>'
                    f'<pre class="tool-args">{_escape(tc_info["args"])}</pre>'
                    f'<div class="tool-result-label">Result:</div>'
                    f'<pre class="tool-result">{_escape(result_str)}</pre>'
                    f"</div></details>"
                )
            else:
                parts.append(
                    f'<details class="cot-section tool">'
                    f"<summary>TOOL RESULT - {_escape(tool_name)}</summary>"
                    f'<div class="cot-content">'
                    f'<pre class="tool-result">{_escape(result_str)}</pre>'
                    f"</div></details>"
                )

    return "\n".join(parts) if parts else _render_metadata_fallback(card)


def _render_metadata_fallback(card: ErrorCard) -> str:
    return (
        f'<pre class="trace">'
        f"Model: {_escape(card.model)}\n"
        f"Tokens: {card.input_tokens} in / {card.output_tokens} out\n"
        f"Tool calls: {card.tool_calls}\n"
        f"Duration: {card.duration_ms}ms"
        f"</pre>"
    )


# ---------------------------------------------------------------------------
# CSS / JS (ported verbatim from the reference)
# ---------------------------------------------------------------------------

CSS_STYLES = """
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
    font-family: 'SF Mono', 'Monaco', 'Inconsolata', 'Roboto Mono', monospace;
    font-size: 11px;
    background: #0a0a0a;
    color: #e0e0e0;
    line-height: 1.3;
}
.header {
    background: #1a1a2e;
    padding: 8px 16px;
    border-bottom: 1px solid #333;
    display: flex;
    justify-content: space-between;
    align-items: center;
    position: sticky;
    top: 0;
    z-index: 1000;
    flex-wrap: wrap;
    gap: 8px;
}
.header h1 { font-size: 14px; color: #00ff88; }
.header .stats { color: #888; }
.header button {
    background: #00ff88;
    color: #000;
    border: none;
    padding: 6px 12px;
    cursor: pointer;
    font-family: inherit;
    font-weight: bold;
    margin-left: 8px;
}
.header button:hover { background: #00cc6a; }
.stats-bar {
    display: flex;
    gap: 12px;
    align-items: center;
    flex-wrap: wrap;
}
.stats-bar .stat-badge {
    padding: 2px 8px;
    font-size: 10px;
    font-weight: bold;
    border-radius: 3px;
}
.stats-bar .stat-badge.total { background: #333; color: #e0e0e0; }
.stats-bar .stat-badge.correct { background: #00ff88; color: #000; }
.stats-bar .stat-badge.error { background: #ff4444; color: #fff; }
.stats-bar .stat-badge.hit_limit { background: #aa0000; color: #fff; }
.stats-bar .stat-badge.incorrect { background: #ff8800; color: #000; }
.stats-bar .stat-badge.partial { background: #ffff00; color: #000; }
.container { display: flex; flex-direction: column; gap: 2px; padding: 8px; }
.question-card {
    background: #111;
    border: 1px solid #333;
    border-left: 3px solid #666;
}
.question-card.error { border-left-color: #ff4444; }
.question-card.hit_limit { border-left-color: #aa0000; }
.question-card.incorrect { border-left-color: #ff8800; }
.question-card.partial { border-left-color: #ffff00; }
.question-card.correct { border-left-color: #00ff88; }
.question-card.judge_correct { border-left-color: #00aaff; }
.question-card.hidden { display: none; }
.card-header {
    background: #1a1a1a;
    padding: 6px 10px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    cursor: pointer;
    border-bottom: 1px solid #333;
}
.card-header:hover { background: #222; }
.q-id { font-weight: bold; color: #00ff88; }
.q-db { color: #888; margin-left: 10px; }
.q-model { color: #00aaff; margin-left: 10px; }
.q-config { color: #ff00ff; margin-left: 10px; font-weight: bold; }
.q-level { padding: 2px 6px; font-size: 10px; font-weight: bold; }
.q-level.error { background: #ff0000; color: #fff; }
.q-level.hit_limit { background: #aa0000; color: #fff; }
.q-level.incorrect { background: #ff8800; color: #000; }
.q-level.partial { background: #ffff00; color: #000; }
.q-level.correct { background: #00ff88; color: #000; }
.q-level.judge_correct { background: #00aaff; color: #000; }
.header-category {
    display: inline-block;
    padding: 2px 6px;
    font-size: 9px;
    font-weight: bold;
    border-radius: 3px;
    margin-left: 8px;
    background: #888;
    color: #000;
}
.card-body {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    gap: 1px;
    background: #333;
}
.card-body.collapsed { display: none; }
.panel {
    background: #111;
    padding: 8px;
    overflow: auto;
    max-height: 500px;
}
.panel h3 {
    color: #00aaff;
    font-size: 10px;
    text-transform: uppercase;
    margin-bottom: 6px;
    border-bottom: 1px solid #333;
    padding-bottom: 4px;
}
.question-text { color: #fff; font-size: 12px; margin-bottom: 8px; }
.evidence { color: #aaa; font-style: italic; margin-bottom: 8px; }
pre {
    background: #0a0a0a;
    padding: 6px;
    overflow-x: auto;
    white-space: pre-wrap;
    word-break: break-all;
    font-size: 10px;
    border: 1px solid #222;
}
pre.sql { color: #00ff88; }
pre.result { color: #ffaa00; }
pre.trace { color: #aaa; font-size: 10px; line-height: 1.4; }
pre.error-msg { color: #ff4444; }
.result-compare { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.result-box { border: 1px solid #333; padding: 4px; }
.result-box.gold { border-color: #00ff88; }
.result-box.pred { border-color: #ff8800; }
.result-label { font-size: 9px; color: #666; margin-bottom: 4px; }
.metric { display: inline-block; margin-right: 16px; color: #888; }
.metric .value { color: #00ff88; font-weight: bold; }
.partial-reason { color: #ffff00; font-size: 10px; margin-top: 4px; }
.investigation-section {
    margin-bottom: 12px;
    padding: 8px;
    background: #0d1a0d;
    border: 1px solid #2a4a2a;
    border-radius: 4px;
}
.investigation-section h4 {
    color: #00ff88;
    font-size: 10px;
    text-transform: uppercase;
    margin-bottom: 6px;
}
.investigation-category {
    display: inline-block;
    padding: 2px 8px;
    font-size: 10px;
    font-weight: bold;
    border-radius: 3px;
    margin-bottom: 6px;
    background: #888;
    color: #000;
}
.investigation-description {
    color: #aaa;
    font-size: 10px;
    background: #0a0a0a;
    padding: 6px;
    border: 1px solid #222;
}
.comment-section {
    grid-column: 1 / -1;
    background: #0d0d1a;
    padding: 8px;
    border-top: 1px solid #333;
}
.comment-section textarea {
    width: 100%;
    background: #111;
    color: #e0e0e0;
    border: 1px solid #333;
    padding: 6px;
    font-family: inherit;
    font-size: 11px;
    resize: vertical;
    min-height: 40px;
}
.comment-section textarea:focus { outline: none; border-color: #00ff88; }
.filter-bar {
    display: flex;
    gap: 16px;
    align-items: center;
    flex-wrap: wrap;
}
.filter-bar label { color: #888; font-size: 10px; }
.filter-bar select {
    background: #222;
    color: #e0e0e0;
    border: 1px solid #444;
    padding: 4px 8px;
    font-family: inherit;
    font-size: 11px;
}
/* COT Trace collapsible sections */
.cot-section {
    margin-bottom: 4px;
    border: 1px solid #333;
    background: #0d0d0d;
}
.cot-section summary {
    padding: 6px 10px;
    cursor: pointer;
    font-weight: bold;
    font-size: 10px;
    text-transform: uppercase;
    background: #1a1a1a;
    border-bottom: 1px solid #333;
    list-style: none;
    display: flex;
    align-items: center;
    gap: 8px;
}
.cot-section summary::-webkit-details-marker { display: none; }
.cot-section summary::before {
    content: '\\25B6';
    font-size: 8px;
    transition: transform 0.2s;
}
.cot-section[open] summary::before { transform: rotate(90deg); }
.cot-section .cot-content {
    padding: 8px;
    max-height: 400px;
    overflow: auto;
}
.cot-section.system summary { color: #888; }
.cot-section.user summary { color: #00aaff; }
.cot-section.thinking summary { color: #cc88ff; }
.cot-section.tool summary { color: #ff8800; }
.cot-section.assistant summary { color: #00ff88; }
.cot-section.final summary { color: #00ff88; background: #1a2a1a; }
.tool-args-label, .tool-result-label {
    color: #666;
    font-size: 9px;
    text-transform: uppercase;
    margin-top: 8px;
    margin-bottom: 4px;
}
.tool-args-label:first-child { margin-top: 0; }
.cot-section .tool-args { color: #888; }
.cot-section .tool-result { color: #aaa; }
::-webkit-scrollbar { width: 6px; height: 6px; }
::-webkit-scrollbar-track { background: #111; }
::-webkit-scrollbar-thumb { background: #444; }
::-webkit-scrollbar-thumb:hover { background: #666; }
"""

JS_SCRIPT = """
let comments = {};

function toggleCard(header) {
    const body = header.nextElementSibling;
    body.classList.toggle('collapsed');
}

function expandAll() {
    document.querySelectorAll('.question-card:not(.hidden) .card-body').forEach(b => b.classList.remove('collapsed'));
}

function collapseAll() {
    document.querySelectorAll('.card-body').forEach(b => b.classList.add('collapsed'));
}

function applyFilters() {
    const statusFilter = document.getElementById('status-filter').value;
    const modelFilter = document.getElementById('model-filter').value;
    const configFilter = document.getElementById('config-filter').value;
    const categoryFilter = document.getElementById('category-filter').value;

    document.querySelectorAll('.question-card').forEach(card => {
        const status = card.dataset.status || '';
        const model = card.dataset.model || '';
        const config = card.dataset.config || '';
        const category = card.dataset.category || '';

        const statusMatch = !statusFilter || statusFilter === 'all' || status === statusFilter ||
            (statusFilter === 'errors' && (status === 'error' || status === 'incorrect' || status === 'partial' || status === 'hit_limit'));
        const modelMatch = !modelFilter || model === modelFilter;
        const configMatch = !configFilter || config === configFilter;
        const categoryMatch = !categoryFilter || category === categoryFilter;

        if (statusMatch && modelMatch && configMatch && categoryMatch) {
            card.classList.remove('hidden');
        } else {
            card.classList.add('hidden');
        }
    });

    const visible = document.querySelectorAll('.question-card:not(.hidden)').length;
    const total = document.querySelectorAll('.question-card').length;
    document.getElementById('filter-count').textContent = 'Showing ' + visible + '/' + total;
}

function exportComments() {
    document.querySelectorAll('textarea[data-qid]').forEach(ta => {
        const qid = ta.dataset.qid;
        if (ta.value.trim()) {
            comments[qid] = ta.value.trim();
        }
    });

    const exportData = {
        timestamp: new Date().toISOString(),
        feedback: Object.entries(comments).map(([qid, comment]) => ({
            question_id: qid,
            comment: comment
        })).filter(f => f.comment)
    };

    const blob = new Blob([JSON.stringify(exportData, null, 2)], {type: 'application/json'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'error_feedback_' + new Date().toISOString().slice(0,19).replace(/[:-]/g,'') + '.json';
    a.click();
    URL.revokeObjectURL(url);
}

document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.key === 'e') expandAll();
    if (e.key === 'c') collapseAll();
});

document.addEventListener('DOMContentLoaded', () => {
    applyFilters();
});
"""


# ---------------------------------------------------------------------------
# HTML generation
# ---------------------------------------------------------------------------


def generate_eval_review(con: duckdb.DuckDBPyConnection, run_id: str | None) -> str:
    """Build ReportData from the run's evaluation_result events and render the report."""
    title = run_id if run_id is not None else "(no run_id)"
    report_data = build_report_data(con, run_id, title)
    return _generate_html(report_data)


def _generate_html(report_data: ReportData) -> str:
    """Generate a self-contained HTML evaluation review."""
    models: set[str] = set()
    configs: set[str] = set()
    categories: set[str] = set()
    for card in report_data.cards:
        models.add(_model_short_name(card.model))
        configs.add(card.config_type)
        if card.error_category:
            categories.add(card.error_category)

    model_options = "".join(
        f'<option value="{_escape(m)}">{_escape(m)}</option>' for m in sorted(models) if m
    )
    config_options = "".join(
        f'<option value="{_escape(c)}">{_escape(c)}</option>' for c in sorted(configs) if c
    )
    category_options = "".join(
        f'<option value="{_escape(c)}">{_escape(c)}</option>' for c in sorted(categories)
    )

    rd = report_data
    stats_html = (
        f'<div class="stats-bar">'
        f'<span class="stat-badge total">{rd.total} total</span>'
        f'<span class="stat-badge correct">{rd.correct_count} correct</span>'
        f'<span class="stat-badge error">{rd.error_count} errors</span>'
        f'<span class="stat-badge hit_limit">{rd.hit_limit_count} hit limit</span>'
        f'<span class="stat-badge incorrect">{rd.incorrect_count} incorrect</span>'
        f'<span class="stat-badge partial">{rd.partial_count} partial</span>'
        f"</div>"
    )

    cards_html = [_render_card(card) for card in report_data.cards]

    return f"""<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Evaluation Review - {_escape(report_data.title)}</title>
    <style>{CSS_STYLES}</style>
</head>
<body>
    <div class="header">
        <h1>EVALUATION REVIEW - {_escape(report_data.title)}</h1>
        {stats_html}
        <div class="filter-bar">
            <label>Status:</label>
            <select id="status-filter" onchange="applyFilters()">
                <option value="errors" selected>Errors Only</option>
                <option value="all">All</option>
                <option value="correct">Correct</option>
                <option value="incorrect">Incorrect</option>
                <option value="partial">Partial</option>
                <option value="error">Error</option>
                <option value="hit_limit">Hit Limit</option>
            </select>
            <label>Model:</label>
            <select id="model-filter" onchange="applyFilters()">
                <option value="">All</option>
                {model_options}
            </select>
            <label>Tier:</label>
            <select id="config-filter" onchange="applyFilters()">
                <option value="">All</option>
                {config_options}
            </select>
            <label>Category:</label>
            <select id="category-filter" onchange="applyFilters()">
                <option value="">All</option>
                {category_options}
            </select>
            <span id="filter-count" style="color: #888;"></span>
        </div>
        <div>
            <button onclick="expandAll()">Expand All</button>
            <button onclick="collapseAll()">Collapse All</button>
            <button onclick="exportComments()">Export Comments</button>
        </div>
    </div>

    <div class="container">
{"".join(cards_html)}
    </div>

    <script>{JS_SCRIPT}</script>
</body>
</html>"""


def _render_card(card: ErrorCard) -> str:
    model_short = _model_short_name(card.model)
    level = card.correctness_level
    level_display = _level_display(card)
    question_preview = (
        card.question_text[:QUESTION_PREVIEW_LENGTH]
        if card.question_text
        else "(no question)"
    )
    cost_str = f"${card.cost_usd:.4f}" if card.cost_usd is not None else "n/a"

    category_badge = ""
    if card.error_category:
        category_badge = (
            f'<span class="header-category">{_escape(card.error_category)}</span>'
        )

    panel1 = _render_question_panel(card)
    cot_html = _render_cot_trace(card.raw_response, card)
    panel2 = f'<div class="panel"><h3>Chain of Thought Trace</h3>{cot_html}</div>'
    panel3 = _render_sql_panel(card)

    comment_section = (
        f'<div class="comment-section">'
        f"<h3>Analysis Notes</h3>"
        f'<textarea data-qid="{_escape(card.question_id)}" '
        f'placeholder="Add notes about this result..."></textarea>'
        f"</div>"
    )

    return f"""
        <div class="question-card {_escape(level)}" data-qid="{_escape(card.question_id)}" data-model="{_escape(model_short)}" data-config="{_escape(card.config_type)}" data-status="{_escape(level)}" data-category="{_escape(card.error_category or '')}">
            <div class="card-header" onclick="toggleCard(this)">
                <div>
                    <span class="q-id">Q{_escape(card.question_id)}</span>
                    <span class="q-db">{_escape(card.db_id)}</span>
                    <span class="q-model">{_escape(model_short)}</span>
                    <span class="q-config">[{_escape(card.config_type)}]</span>
                </div>
                <div style="flex: 1; margin: 0 20px; color: #888; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                    {_escape(question_preview)}
                </div>
                <div>
                    <span class="metric"><span class="value">{cost_str}</span></span>
                    <span class="metric"><span class="value">{card.duration_ms:.0f}</span>ms</span>
                </div>
                <span class="q-level {_escape(level)}">{level_display}</span>{category_badge}
            </div>
            <div class="card-body collapsed">
                {panel1}
                {panel2}
                {panel3}
                {comment_section}
            </div>
        </div>
"""


def _level_display(card: ErrorCard) -> str:
    level = card.correctness_level
    if level == "error":
        return "ERROR"
    if level == "hit_limit":
        return "HIT LIMIT"
    if level == "incorrect":
        return "INCORRECT"
    if level == "partial":
        return "PARTIAL"
    if level == "judge_correct":
        return "CORRECT (JUDGE)"
    if level == "correct":
        ms = card.match_source or ""
        if ms == "platinum":
            return "CORRECT (PLATINUM)"
        return "CORRECT"
    return level.upper()


def _render_question_panel(card: ErrorCard) -> str:
    parts = [
        '<div class="panel">',
        "<h3>Question &amp; Context</h3>",
        f'<div class="question-text">{_escape(card.question_text) or "Not available"}</div>',
    ]

    if card.evidence:
        parts.append(f'<div class="evidence">{_escape(card.evidence)}</div>')

    if card.error_category:
        parts.append('<div class="investigation-section">')
        parts.append("<h4>Error Investigation</h4>")
        parts.append(
            f'<span class="investigation-category">{_escape(card.error_category)}</span>'
        )
        if card.error_description:
            parts.append(
                f'<div class="investigation-description">{_escape(card.error_description)}</div>'
            )
        parts.append("</div>")

    if card.partial_reason:
        parts.append(
            f'<div class="partial-reason">Partial reason: {_escape(card.partial_reason)}</div>'
        )

    parts.append("</div>")
    return "\n".join(parts)


def _render_sql_panel(card: ErrorCard) -> str:
    parts = ['<div class="panel">']

    if card.gold_sql:
        parts.append("<h3>Predicted SQL</h3>")
        if card.predicted_sql:
            parts.append(f'<pre class="sql">{_escape(card.predicted_sql)}</pre>')
        else:
            parts.append('<pre class="error-msg">No SQL generated</pre>')
        parts.append('<h3 style="margin-top: 12px;">Gold SQL</h3>')
        parts.append(f'<pre class="sql">{_escape(card.gold_sql)}</pre>')
    else:
        if card.predicted_sql:
            parts.append(
                f'<details style="margin-bottom: 12px; border: 1px solid #ff8800;">'
                f'<summary style="padding: 6px 10px; cursor: pointer; color: #ff8800; '
                f'font-weight: bold; font-size: 10px; text-transform: uppercase; '
                f'background: #1a1a1a;">Predicted SQL</summary>'
                f'<pre class="sql" style="border-color: #ff8800;">{_escape(card.predicted_sql)}</pre>'
                f'</details>'
            )
        else:
            parts.append("<h3>Predicted SQL</h3>")
            parts.append('<pre class="error-msg">No SQL generated</pre>')

    parts.append('<h3 style="margin-top: 12px;">Results</h3>')

    gold_formatted = _format_result(card.gold_result)
    pred_formatted = _format_result(card.predicted_result)

    gold_is_string = isinstance(card.gold_result, str)
    pred_is_string = isinstance(card.predicted_result, str)

    if gold_is_string:
        gold_label = "GOLD ANSWER"
    else:
        gold_rows = len(card.gold_result) if isinstance(card.gold_result, (list, tuple)) else "?"
        gold_label = f"GOLD ({gold_rows} rows)"

    if pred_is_string:
        pred_label = "PREDICTED ANSWER"
    else:
        pred_rows = len(card.predicted_result) if isinstance(card.predicted_result, (list, tuple)) else "?"
        pred_label = f"PREDICTED ({pred_rows} rows)"

    if card.answer_source and card.answer_source != "official":
        gold_label = f"{gold_label} — {card.answer_source}"

    parts.append('<div class="result-compare">')
    parts.append(
        f'<div class="result-box gold">'
        f'<div class="result-label">{gold_label}</div>'
        f'<pre class="result">{gold_formatted}</pre>'
        f"</div>"
    )
    parts.append(
        f'<div class="result-box pred">'
        f'<div class="result-label">{pred_label}</div>'
        f'<pre class="result">{pred_formatted}</pre>'
        f"</div>"
    )
    parts.append("</div>")

    if card.match_source:
        parts.append(
            f'<div style="margin-top: 8px; color: #888; font-size: 10px;">'
            f"Match source: {_escape(card.match_source)}</div>"
        )

    parts.append("</div>")
    return "\n".join(parts)
