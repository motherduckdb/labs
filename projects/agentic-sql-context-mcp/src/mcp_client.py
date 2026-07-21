"""Async MotherDuck context-MCP client.

This is the single transport seam between the agent (and the guides migration)
and the MotherDuck MCP server. It replaces the project's former hand-built,
in-process DuckDB + local-markdown tools: the semantic layer now comes from
MCP **guides** (list_guides/get_guide), and the data tools come from the MCP
query/schema tool set. quackbot proved this pattern; its key finding is baked
in here — the server exposes NO `context_layer` tool, so the context layer IS
guides.

Ported from quackbot's `src/core/mcp-client.ts` + `src/core/tool-invocation.ts`
(allowlist / write gate / path guard / arg defaults / detectPayloadFailure) and
agentic-malloy's `src/mcp-client.ts` (positional-row parse shape), onto the
async `mcp` Python SDK (v1.27.2):

    from mcp.client.streamable_http import streamablehttp_client
    from mcp import ClientSession

Self-contained: stdlib + `mcp` + dataclasses only.
"""

from __future__ import annotations

import json
import os
import re
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any, AsyncIterator

from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

DEFAULT_BASE_URL = "https://api.motherduck.com"

# Read-only exploration + guide reads: everything the AGENT may call.
AGENT_TOOLS = {
    "query",
    "list_tables",
    "list_columns",
    "search_catalog",
    "list_guides",
    "get_guide",
}

# Guide WRITES — used ONLY by the guides migration (via allow_write=True /
# call_tool_write), never exposed on the agent path.
GUIDE_WRITE_TOOLS = {"create_guide", "update_guide"}

# The full set any call may name. Anything outside this is rejected at dispatch.
ALLOWED_TOOLS = AGENT_TOOLS | GUIDE_WRITE_TOOLS

# Tools whose HTTP-200 response can still carry `{"success": false}` at the
# payload level (the MCP envelope's isError stays false). We parse the content
# and promote such a payload failure to a real tool error — the quackbot
# detectPayloadFailure behavior.
SUCCESS_FIELD_TOOLS = {"create_guide", "update_guide"}

# Guide-path guard: every character of the path must be a plain slug char. This
# single charset check rejects backslashes, percent-encoding, whitespace, and
# any non-ASCII look-alike in one pass; dot-only segments are rejected
# separately below (they satisfy the charset). Dots *within* a filename
# (e.g. `v1.2-notes.md`) stay legal.
_GUIDE_PATH_CHARSET = re.compile(r"^[A-Za-z0-9._/-]+$")


def mcp_url() -> str:
    """The MCP endpoint URL: MOTHERDUCK_API_URL (or the default base) + /mcp."""
    base = os.environ.get("MOTHERDUCK_API_URL") or DEFAULT_BASE_URL
    return base.rstrip("/") + "/mcp"


@dataclass
class MCPResult:
    """Result of a single MCP tool call.

    Attributes:
        text: Human/tool-visible text — JSON of structuredContent when present,
            else the joined content text blocks.
        is_error: True if the MCP envelope reported isError OR the parsed
            payload reported success: false (for SUCCESS_FIELD_TOOLS).
        rows: structuredContent["rows"] (positional arrays) when present, else
            None.
    """

    text: str
    is_error: bool
    rows: list | None


def _guide_path_violation(name: str, args: dict) -> str | None:
    """Light path guard for guide writes.

    Rejects `.`/`..` segments and any path outside the [A-Za-z0-9._/-] charset,
    so a prompt-injected or padded path cannot traverse out of its folder. The
    server itself enforces the `users/<username>/` half for non-admin tokens;
    this is the last-mile confinement on the client. Returned as a tool error
    (not raised) so the caller/model can retry with a conforming path.
    """
    path = args.get("path")
    if not isinstance(path, str) or not path:
        return f"{name} requires a string `path` argument."
    segments = path.split("/")
    if any(seg in (".", "..") for seg in segments):
        return f"{name} path may not contain '.' or '..' segments (got '{path}')."
    if not _GUIDE_PATH_CHARSET.match(path):
        return (
            f"{name} path must be plain [A-Za-z0-9._/-] characters — no empty, "
            f"encoded, Unicode, whitespace, or backslash segments (got '{path}')."
        )
    return None


def _sanitize_guide_args(args: dict) -> dict:
    """Drop empty-string / None arg values from a guide-read call.

    Models pad every optional schema field with "" / null; the server rejects
    those, so we strip them before dispatch (quackbot's sanitizeGuideArgs).
    """
    return {k: v for k, v in args.items() if v != "" and v is not None}


def _detect_payload_failure(name: str, text: str) -> tuple[bool, str | None]:
    """Surface a payload-level `success: false` for SUCCESS_FIELD_TOOLS.

    Returns (failed, message). The write tools return HTTP 200 +
    `{ success: false, error: "..." }` on failure while the MCP envelope's
    isError stays false, so without this the caller would think the write
    succeeded.
    """
    if name not in SUCCESS_FIELD_TOOLS:
        return (False, None)
    trimmed = text.strip()
    if not (trimmed.startswith("{") or trimmed.startswith("[")):
        return (False, None)
    try:
        parsed = json.loads(trimmed)
    except (ValueError, TypeError):
        return (False, None)
    items = parsed if isinstance(parsed, list) else [parsed]
    for item in items:
        if not isinstance(item, dict):
            continue
        if item.get("success") is False:
            error = item.get("error")
            message = item.get("message")
            if isinstance(error, str):
                msg = error
            elif isinstance(message, str):
                msg = message
            else:
                msg = "Tool reported success: false"
            return (True, msg)
    return (False, None)


class MCPSession:
    """A thin wrapper over an initialized `mcp` ClientSession.

    Enforces the allowlist, the write gate, guide-path confinement, argument
    defaults, and payload-failure detection — the same guardrails quackbot
    applies in `executeToolWithStatus` + `dispatchTool`.
    """

    def __init__(self, session: ClientSession) -> None:
        self._session = session

    async def call_tool(
        self,
        name: str,
        args: dict,
        *,
        allow_write: bool = False,
    ) -> MCPResult:
        """Dispatch one MCP tool call and pack the result.

        Args:
            name: Tool name; must be in ALLOWED_TOOLS.
            args: Tool arguments (massaged in place-safe fashion before dispatch).
            allow_write: Must be True to invoke a GUIDE_WRITE_TOOLS tool. The
                agent path never sets this; only the migration does (via
                call_tool_write).

        Returns:
            An MCPResult. Guardrail violations come back as `is_error=True`
            results (not exceptions) so the model can read the message and retry.
        """
        # 1. Allowlist. No public bypass — a non-allowlisted (e.g. destructive)
        #    tool can never reach MotherDuck.
        if name not in ALLOWED_TOOLS:
            raise ValueError(f'Tool "{name}" is not in the allowed tool set')

        # 2. Write gate. Guide writes are barred on the agent path.
        if name in GUIDE_WRITE_TOOLS and not allow_write:
            raise ValueError(
                f'Tool "{name}" is a guide-write tool and is not permitted here '
                f"(agent calls are read-only)."
            )

        # 3. Argument defaults / sanitization. The MCP query/list_tables/
        #    list_columns tools all REQUIRE a `database` arg — inject the pinned
        #    default so the model never has to name it. (search_catalog takes no
        #    database; the guide tools are sanitized instead.)
        call_args = dict(args)
        if name in ("query", "list_tables", "list_columns"):
            call_args.setdefault(
                "database", os.environ.get("MD_DATABASE", "agentic_sql_claude")
            )
        elif name in ("list_guides", "get_guide"):
            call_args = _sanitize_guide_args(call_args)

        # 4. Guide-path guard for writes.
        if name in GUIDE_WRITE_TOOLS:
            violation = _guide_path_violation(name, call_args)
            if violation is not None:
                return MCPResult(text=violation, is_error=True, rows=None)

        # 5. Dispatch + parse. Prefer structuredContent (carries positional
        #    rows), else join the text content blocks.
        result = await self._session.call_tool(name, call_args)
        is_error = getattr(result, "isError", False) is True

        structured = getattr(result, "structuredContent", None)
        if structured is not None:
            text = json.dumps(structured)
            rows = structured.get("rows") if isinstance(structured, dict) else None
        else:
            text = _join_content_text(getattr(result, "content", None))
            rows = None

        # 6. detectPayloadFailure: promote a payload-level success:false to a
        #    real error and prepend its message.
        failed, message = _detect_payload_failure(name, text)
        if failed:
            is_error = True
            text = f"Tool reported failure: {message}\n\n{text}"

        return MCPResult(text=text, is_error=is_error, rows=rows)


def _join_content_text(content: Any) -> str:
    """Join a CallToolResult's content blocks into a single text string.

    Text blocks contribute their `.text`; any other block is JSON-serialized.
    """
    if not isinstance(content, list):
        return json.dumps(content, default=str)
    parts: list[str] = []
    for block in content:
        block_type = getattr(block, "type", None)
        if block_type == "text":
            parts.append(getattr(block, "text", "") or "")
        else:
            # Non-text block (image, resource, ...): dump a stable JSON view.
            dump = getattr(block, "model_dump", None)
            if callable(dump):
                parts.append(json.dumps(dump(), default=str))
            else:
                parts.append(json.dumps(block, default=str))
    return "\n".join(parts)


@asynccontextmanager
async def create_mcp_session(
    session_hint: str | None = None,
) -> AsyncIterator[MCPSession]:
    """Open an authenticated MCP session as an async context manager.

    Streams over the streamable-HTTP transport to `mcp_url()`, authenticating
    with the MOTHERDUCK_TOKEN bearer. `session_hint`, when given, is passed as a
    `session_name` query param for read-scaling replica affinity — honored if
    the MCP server forwards it, harmless if not.

    Raises:
        RuntimeError: if MOTHERDUCK_TOKEN is unset.
    """
    token = os.environ.get("MOTHERDUCK_TOKEN")
    if not token:
        raise RuntimeError(
            "MOTHERDUCK_TOKEN is not set. Set a MotherDuck access token in the "
            "environment (a write-capable PAT is required for the guides migration)."
        )

    url = mcp_url()
    if session_hint:
        sep = "&" if "?" in url else "?"
        url = f"{url}{sep}session_name={session_hint}"

    headers = {"Authorization": f"Bearer {token}"}
    async with streamablehttp_client(url, headers=headers) as (read_stream, write_stream, _):
        async with ClientSession(read_stream, write_stream) as session:
            await session.initialize()
            yield MCPSession(session)


async def call_tool_write(session: MCPSession, name: str, args: dict) -> MCPResult:
    """Migration-only helper: invoke a guide-write tool with the write gate open.

    Never used on the agent path — only the guides migration (guides_load)
    should reach for this.
    """
    return await session.call_tool(name, args, allow_write=True)
