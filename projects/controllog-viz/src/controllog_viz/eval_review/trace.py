"""Chain-of-thought conversation trace rendering.

Parses the two trace shapes found in ``raw_response.messages`` — OpenAI Chat Completions
and the Responses API — into collapsible HTML sections, with a metadata fallback.
"""
from __future__ import annotations

import contextlib
import json

from controllog_viz.eval_review.model import ErrorCard, _escape


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

    # Flush tool calls that never got a result (trace truncated, crash, or unlogged
    # result) so an incomplete conversation still shows the attempted call — matching
    # _render_responses_api_trace.
    for tc_id in pending_tool_calls_order:
        tc_info = pending_tool_calls.get(tc_id)
        if not tc_info:
            continue
        parts.append(
            f'<details class="cot-section tool">'
            f'<summary>TOOL CALL #{tc_info.get("response_num", "?")} - '
            f'{_escape(tc_info["name"])} (no response)</summary>'
            f'<div class="cot-content">'
            f'<div class="tool-args-label">Arguments:</div>'
            f'<pre class="tool-args">{_escape(tc_info["args"])}</pre>'
            f"</div></details>"
        )

    return "\n".join(parts) if parts else _render_metadata_fallback(card)


def _render_metadata_fallback(card: ErrorCard) -> str:
    # Every field here comes from payload_json and may be malformed (e.g. a string with
    # markup), so escape all of them — not just card.model.
    return (
        f'<pre class="trace">'
        f"Model: {_escape(card.model)}\n"
        f"Tokens: {_escape(card.input_tokens)} in / {_escape(card.output_tokens)} out\n"
        f"Tool calls: {_escape(card.tool_calls)}\n"
        f"Duration: {_escape(card.duration_ms)}ms"
        f"</pre>"
    )

