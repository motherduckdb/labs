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
from urllib.parse import quote

import duckdb
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

DEFAULT_BASE_URL = "https://api.motherduck.com"

# Read-only exploration + guide reads: exactly what the AGENT may call. This set
# mirrors `agent._make_tools` one-for-one — keep them in sync.
#
# Guide navigation is the topic/uuid model (post-2026-07-23 platform deploy):
#   list_guides(topic=...)     -> guides at that topic, each carrying its uuid
#   get_guide(uuid=...)        -> the full guide body
# The old path-addressed model (list_guides(partial_path/keyword), get_guide(path))
# is gone; guides are identified solely by the server-minted uuid. The catalog
# entry point `get_query_guide` is NOT an agent tool — the six dabstep/<domain>
# topics are pre-seeded in the system prompt, so the agent starts at
# `list_guides(topic)` (see agent._BASE_SYSTEM_PROMPT). It lives in PROBE_TOOLS
# below so the smoketest / manual probes can still reach it.
AGENT_TOOLS = {
    "query",
    "list_tables",
    "list_columns",
    "list_guides",
    "get_guide",
}

# Read-only tools that are allowlisted for the smoketest / manual probes but are
# deliberately NOT on the agent's tool list (the agent never calls them):
#   get_query_guide -> org catalog entry point (pre-seeded into the prompt instead)
#   search_catalog  -> catalog full-text search (not needed for this benchmark)
PROBE_TOOLS = {"get_query_guide", "search_catalog"}

# Guide WRITES — used ONLY by the guides migration (via allow_write=True /
# call_tool_write), never exposed on the agent path.
#   create_guide          -> mints a new guide (requires title + content)
#   update_guide          -> refreshes a guide BODY by uuid (requires uuid + content)
#   update_guide_metadata -> refreshes title/description/topic by uuid (requires uuid)
GUIDE_WRITE_TOOLS = {"create_guide", "update_guide", "update_guide_metadata"}

# The full set any call may name. Anything outside this is rejected at dispatch.
ALLOWED_TOOLS = AGENT_TOOLS | GUIDE_WRITE_TOOLS | PROBE_TOOLS

# Tools whose HTTP-200 response can still carry `{"success": false}` at the
# payload level (the MCP envelope's isError stays false). We parse the content
# and promote such a payload failure to a real tool error — the quackbot
# detectPayloadFailure behavior.
SUCCESS_FIELD_TOOLS = {"create_guide", "update_guide", "update_guide_metadata"}

# Guide-topic guard: every character of the topic label must be a plain slug
# char. This single charset check rejects backslashes, percent-encoding,
# whitespace, and any non-ASCII look-alike in one pass; dot-only segments are
# rejected separately below (they satisfy the charset). A topic is a
# slash-separated grouping label (e.g. `dabstep/payments`), NOT an address —
# guides are addressed by uuid — so this is last-mile confinement on where a
# write lands, not a path traversal concern.
_GUIDE_TOPIC_CHARSET = re.compile(r"^[A-Za-z0-9._/-]+$")

# A valid MotherDuck database identifier for default-injection. The agent never
# names a database (it is injected), so this only needs to accept the plain slug
# identifiers we pin; anything else is a config error worth failing loudly on.
_DB_IDENTIFIER = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")

# Trusted MotherDuck share addresses accepted by the session bootstrap. Share
# attachment is configuration, never an agent tool: the model still goes
# through the read-only query guard below and cannot ATTACH anything itself.
_SHARE_URL = re.compile(
    r"^md:_share/[A-Za-z_][A-Za-z0-9_]*/"
    r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)

# Defense-in-depth read-only guard for the `query` tool. The real protection is a
# read-scoped MotherDuck token; this is a belt-and-suspenders reject of any
# statement that leads with a mutating/among keyword so a prompt-injected
# question can't ride the agent's session into a write. Denylist (not allowlist)
# so unusual-but-harmless leaders still pass — the benchmark only ever SELECTs.
_MUTATING_SQL_LEADERS = frozenset({
    "insert", "update", "delete", "merge", "upsert", "replace",
    "create", "drop", "alter", "truncate", "rename",
    "attach", "detach", "copy", "export", "import",
    "install", "load", "set", "reset", "use",
    "grant", "revoke", "vacuum", "checkpoint",
    "begin", "start", "commit", "rollback", "call", "pragma",
})

_DYNAMIC_CATALOG_ACCESS = re.compile(
    r"^(?:query_table|query|duckdb_[A-Za-z0-9_]*|pragma_[A-Za-z0-9_]*)$",
    re.IGNORECASE,
)


def _sql_tokens(sql: str) -> list[str]:
    """Return DuckDB-tokenized keywords/identifiers/operators, omitting values.

    DuckDB's tokenizer correctly handles ordinary, escaped, and dollar-quoted
    strings and skips comments. That avoids the endless quote/comment edge
    cases of regex-based SQL inspection while retaining quoted identifiers.
    """
    tokens: list[str] = []
    for position, token_type in duckdb.tokenize(sql):
        if token_type == duckdb.token_type.string_const:
            continue
        char = sql[position]
        if char == '"':
            index = position + 1
            value: list[str] = []
            while index < len(sql):
                if sql[index] == '"':
                    if index + 1 < len(sql) and sql[index + 1] == '"':
                        value.append('"')
                        index += 2
                        continue
                    break
                value.append(sql[index])
                index += 1
            tokens.append("".join(value).casefold())
        elif char.isalpha() or char == "_":
            match = re.match(r"[A-Za-z_][A-Za-z0-9_$]*", sql[position:])
            tokens.append((match.group(0) if match else char).casefold())
        else:
            tokens.append(char)
    return tokens


def _read_only_violation(sql: str) -> str | None:
    """Return an error string if `sql` contains a non-read-only statement.

    Splits on `;`, strips comments, and rejects any statement whose first token
    is a known mutating keyword. Returns None when every statement looks read-only
    (SELECT/WITH/FROM/DESCRIBE/SHOW/EXPLAIN/VALUES/TABLE/…). Best-effort — the
    authoritative guard is a read-scoped token; this only stops the obvious.
    """
    if not isinstance(sql, str) or not sql.strip():
        return None
    try:
        statements = duckdb.extract_statements(sql)
    except duckdb.Error:
        return None  # Let the server return the actionable SQL syntax error.
    allowed_types = {duckdb.StatementType.SELECT, duckdb.StatementType.EXPLAIN}
    for statement in statements:
        if statement.type not in allowed_types:
            return (
                f"Refused: this path is read-only, but the SQL leads with "
                f"'{statement.type.name}'. Only read queries "
                f"(SELECT / WITH / DESCRIBE / …) "
                f"are permitted."
            )
        if statement.type == duckdb.StatementType.EXPLAIN:
            statement_tokens = _sql_tokens(statement.query)
            if {"analyze", "analyse"}.intersection(statement_tokens):
                return (
                    "Refused: EXPLAIN ANALYZE/ANALYSE executes its child statement "
                    "and is not permitted on this read-only path. Use plain EXPLAIN "
                    "for query planning."
                )
    return None


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


def _guide_write_violation(name: str, args: dict) -> str | None:
    """Light guard for guide writes under the topic/uuid model.

    Guide writes no longer take a `path`; guides are addressed by uuid and
    grouped by an optional `topic` label. Required fields differ per tool:

      * create_guide          -> non-empty `title` AND `content` (mints a guide).
      * update_guide          -> non-empty `uuid` AND `content` (rewrites the
                                 BODY only; title/description/topic are ignored).
      * update_guide_metadata -> non-empty `uuid` (refreshes title/description/
                                 topic; carries no content).

    In all cases, `topic` (only meaningful on create_guide and
    update_guide_metadata) — when supplied — must stay within the
    [A-Za-z0-9._/-] charset with no `.`/`..` segments, so a prompt-injected or
    padded label cannot land a guide in a surprising folder. Visibility is
    governed separately by `access` (user vs organization), enforced per token.

    Returned as a tool error (not raised) so the caller/model can retry with a
    conforming payload.
    """
    if name == "create_guide":
        required = ("title", "content")
    elif name == "update_guide":
        required = ("uuid", "content")
    elif name == "update_guide_metadata":
        required = ("uuid",)
    else:
        required = ("title", "content")
    for field in required:
        value = args.get(field)
        if not isinstance(value, str) or not value.strip():
            return f"{name} requires a non-empty string `{field}` argument."
    topic = args.get("topic")
    if topic is not None:
        if not isinstance(topic, str) or not topic:
            return f"{name} `topic` must be a non-empty string when provided."
        if any(seg in ("", ".", "..") for seg in topic.split("/")):
            return (
                f"{name} topic may not contain empty, '.' or '..' segments — no "
                f"leading, trailing, or repeated '/' (got '{topic}')."
            )
        if not _GUIDE_TOPIC_CHARSET.match(topic):
            return (
                f"{name} topic must be plain [A-Za-z0-9._/-] characters — no "
                f"empty, encoded, Unicode, whitespace, or backslash segments "
                f"(got '{topic}')."
            )
    return None


def _sanitize_guide_args(args: dict) -> dict:
    """Drop empty-string / None arg values from a guide-read call.

    Models pad every optional schema field with "" / null; the server rejects
    those, so we strip them before dispatch (quackbot's sanitizeGuideArgs). Under
    the topic/uuid model this keeps a bare `list_guides()` (no topic → catalog
    root) and `get_guide(uuid=...)` clean of empty companions.
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

    def __init__(
        self,
        session: ClientSession,
        database: str | None = None,
        no_guides: bool = False,
        excluded_schemas: tuple[str, ...] = (),
        guide_topic: str | None = None,
    ) -> None:
        self._session = session
        # Ablation baseline: when set, every guide-read tool short-circuits to
        # "No guides exist." without hitting the server, so a run measures the
        # agent WITHOUT the semantic layer while every other moving part (skill,
        # prompts, data tools, scoring) stays byte-identical.
        self._no_guides = no_guides
        # The database injected into query/list_tables/list_columns calls. Pinned
        # per session so `--database` actually reaches the server (falls back to
        # $MD_DATABASE, then the project default) rather than being read from the
        # environment at call time.
        db = database or os.environ.get("MD_DATABASE") or "agentic_sql_claude"
        if not _DB_IDENTIFIER.match(db):
            raise ValueError(
                f"Invalid database identifier {db!r}: expected a plain "
                f"[A-Za-z_][A-Za-z0-9_]* slug."
            )
        self._database = db
        self._excluded_schemas = frozenset(schema.casefold() for schema in excluded_schemas)
        self._guide_topic = guide_topic
        self._listed_guide_uuids: set[str] = set()

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

        # 1b. No-guides ablation: guide reads never reach the server. A flat,
        #     non-error "No guides exist." keeps the agent loop shape identical
        #     (the model reads the result and moves on, rather than retrying an
        #     error) while removing all guide content from the run.
        if self._no_guides and name in ("list_guides", "get_guide", "get_query_guide"):
            return MCPResult(text="No guides exist.", is_error=False, rows=None)

        # 2. Write gate. Guide writes are barred on the agent path.
        if name in GUIDE_WRITE_TOOLS and not allow_write:
            raise ValueError(
                f'Tool "{name}" is a guide-write tool and is not permitted here '
                f"(agent calls are read-only)."
            )

        # 3. Argument defaults / sanitization. The MCP query/list_tables/
        #    list_columns tools all REQUIRE a `database` arg — inject the
        #    session-pinned database so the model never has to name it.
        #    (search_catalog takes no database; the guide tools are sanitized
        #    instead.)
        call_args = dict(args)
        if name in ("query", "list_tables", "list_columns"):
            # The database is a session boundary, not a model-controlled arg.
            call_args["database"] = self._database
        elif name in ("get_query_guide", "list_guides", "get_guide"):
            # get_query_guide takes no args; list_guides takes an optional topic;
            # get_guide takes a uuid. All tolerate the empty-padding strip.
            call_args = _sanitize_guide_args(call_args)

        if (
            self._guide_topic
            and name == "list_guides"
            and call_args.get("topic") != self._guide_topic
        ):
            return MCPResult(
                text=f"Refused: this benchmark exposes only topic {self._guide_topic!r}.",
                is_error=True,
                rows=None,
            )
        if self._guide_topic and name == "get_guide":
            requested_uuid = call_args.get("uuid")
            if requested_uuid not in self._listed_guide_uuids:
                return MCPResult(
                    text=(
                        "Refused: get_guide may read only a uuid returned by this "
                        "session's configured topic listing."
                    ),
                    is_error=True,
                    rows=None,
                )

        if name == "list_columns":
            normalized = await self._normalize_list_columns_args(call_args)
            if isinstance(normalized, MCPResult):
                return normalized
            call_args = normalized

        # 4a. Read-only guard for `query` (defense-in-depth over a read-scoped
        #     token). submit_answer runs its SQL through this same tool, so this
        #     covers both exploration and submission.
        if name == "query":
            violation = _read_only_violation(call_args.get("sql", ""))
            if violation is not None:
                return MCPResult(text=violation, is_error=True, rows=None)

        # 4a.1 Dataset information boundary. The Agentic Company share contains
        # private simulation/answer schemas that are not benchmark context. Hide
        # them from discovery and reject explicit references before dispatch.
        restricted = self._restricted_schema_violation(name, call_args)
        if restricted is not None:
            return MCPResult(text=restricted, is_error=True, rows=None)

        # 4b. Guide-write guard (topic + required fields).
        if name in GUIDE_WRITE_TOOLS:
            violation = _guide_write_violation(name, call_args)
            if violation is not None:
                return MCPResult(text=violation, is_error=True, rows=None)

        # 5. Dispatch + parse. Prefer structuredContent (carries positional
        #    rows), else join the text content blocks.
        result = await self._session.call_tool(name, call_args)
        is_error = getattr(result, "isError", False) is True

        structured = getattr(result, "structuredContent", None)
        if name == "list_tables" and isinstance(structured, dict) and self._excluded_schemas:
            structured = self._filter_table_listing(structured)
        if structured is not None:
            text = json.dumps(structured)
            if isinstance(structured, dict) and name == "list_columns":
                rows = structured.get("columns")
            elif isinstance(structured, dict) and name == "list_tables":
                rows = [
                    *structured.get("tables", []),
                    *structured.get("views", []),
                ]
            else:
                rows = structured.get("rows") if isinstance(structured, dict) else None
        else:
            text = _join_content_text(getattr(result, "content", None))
            rows = None

        if (
            name == "list_guides"
            and self._guide_topic
            and isinstance(structured, dict)
            and isinstance(structured.get("guides"), list)
        ):
            self._listed_guide_uuids = {
                str(guide["uuid"])
                for guide in structured["guides"]
                if isinstance(guide, dict) and guide.get("uuid")
            }

        # 6. detectPayloadFailure: promote a payload-level success:false to a
        #    real error and prepend its message.
        failed, message = _detect_payload_failure(name, text)
        if failed:
            is_error = True
            text = f"Tool reported failure: {message}\n\n{text}"

        return MCPResult(text=text, is_error=is_error, rows=rows)

    async def _normalize_list_columns_args(self, args: dict) -> dict | MCPResult:
        """Translate user-friendly qualified names to the MCP's split fields.

        MotherDuck's list_columns tool takes separate database/schema/table
        arguments and otherwise defaults schema to ``main``. The agent API
        intentionally exposes one ``table`` string, so normalize
        ``schema.table`` and ``database.schema.table`` here. Resolve an
        unqualified name only when it is unique among visible schemas.
        """
        raw_table = args.get("table")
        if not isinstance(raw_table, str) or not raw_table.strip():
            return MCPResult(
                text="list_columns requires a non-empty table name.",
                is_error=True,
                rows=None,
            )
        raw_parts = [part.strip().strip('"') for part in raw_table.split(".")]
        if not 1 <= len(raw_parts) <= 3 or any(
            not _DB_IDENTIFIER.fullmatch(part) for part in raw_parts
        ):
            return MCPResult(
                text=(
                    "Invalid table name. Use table, schema.table, or "
                    "database.schema.table with plain identifiers."
                ),
                is_error=True,
                rows=None,
            )

        normalized = dict(args)
        normalized["database"] = self._database
        if len(raw_parts) == 3:
            requested_database, schema, table = raw_parts
            if requested_database.casefold() != self._database.casefold():
                return MCPResult(
                    text=(
                        f"Refused: this session exposes only database {self._database!r}."
                    ),
                    is_error=True,
                    rows=None,
                )
            normalized["schema"] = schema
            normalized["table"] = table
            return normalized
        if len(raw_parts) == 2:
            normalized["schema"], normalized["table"] = raw_parts
            return normalized

        table = raw_parts[0]
        explicit_schema = normalized.get("schema")
        if explicit_schema is not None:
            if not isinstance(explicit_schema, str) or not _DB_IDENTIFIER.fullmatch(
                explicit_schema
            ):
                return MCPResult(
                    text="Invalid schema name for list_columns.",
                    is_error=True,
                    rows=None,
                )
            normalized["table"] = table
            return normalized

        listing = await self._session.call_tool(
            "list_tables",
            {"database": self._database, "keywords": table, "limit": 500},
        )
        payload = getattr(listing, "structuredContent", None)
        if getattr(listing, "isError", False) is True or not isinstance(payload, dict):
            return MCPResult(
                text=f"Could not resolve unqualified table {table!r}; use schema.table.",
                is_error=True,
                rows=None,
            )
        matches = [
            item
            for key in ("tables", "views")
            for item in payload.get(key, [])
            if isinstance(item, dict)
            and str(item.get("name") or "").casefold() == table.casefold()
            and str(item.get("schema") or "").casefold() not in self._excluded_schemas
        ]
        if len(matches) != 1:
            candidates = ", ".join(
                f"{item.get('schema')}.{item.get('name')}" for item in matches
            )
            detail = f" Candidates: {candidates}." if candidates else ""
            return MCPResult(
                text=(
                    f"Unqualified table {table!r} is not uniquely resolvable.{detail} "
                    "Use schema.table from list_tables."
                ),
                is_error=True,
                rows=None,
            )
        normalized["schema"] = str(matches[0]["schema"])
        normalized["table"] = str(matches[0]["name"])
        return normalized

    def _restricted_schema_violation(self, name: str, args: dict) -> str | None:
        if not self._excluded_schemas:
            return None
        candidate = ""
        if name == "query":
            candidate = str(args.get("sql") or "")
        elif name == "list_columns":
            candidate = ".".join(
                str(value)
                for value in (args.get("schema"), args.get("table"))
                if value
            )
        else:
            return None
        tokens = _sql_tokens(candidate)
        if name == "query":
            if tokens and tokens[0] in {"show", "summarize", "describe", "desc"}:
                return (
                    "Refused: catalog-wide SQL discovery is outside this benchmark's "
                    "public-schema interface. Use list_tables/list_columns."
                )
            for index, token in enumerate(tokens[:-1]):
                if (_DYNAMIC_CATALOG_ACCESS.fullmatch(token) and tokens[index + 1] == "("):
                    return (
                        "Refused: dynamic table/catalog access is outside this benchmark's "
                        "public-schema interface. Use list_tables/list_columns and explicit "
                        "public schema.table names."
                    )
                if token in {"information_schema", "pg_catalog"} and tokens[index + 1] == ".":
                    return (
                        "Refused: metadata catalogs are outside this benchmark's "
                        "public-schema interface. Use list_tables/list_columns."
                    )
            if "sqlite_master" in tokens:
                return (
                    "Refused: metadata catalogs are outside this benchmark's "
                    "public-schema interface. Use list_tables/list_columns."
                )
        for schema in self._excluded_schemas:
            if any(
                token == schema and tokens[index + 1] == "."
                for index, token in enumerate(tokens[:-1])
            ):
                return f"Refused: schema '{schema}' is outside this benchmark's data boundary."
        return None

    def _filter_table_listing(self, payload: dict) -> dict:
        filtered = dict(payload)
        for key in ("tables", "views"):
            values = filtered.get(key)
            if isinstance(values, list):
                filtered[key] = [
                    item
                    for item in values
                    if not (
                        isinstance(item, dict)
                        and str(item.get("schema") or "").casefold()
                        in self._excluded_schemas
                    )
                ]
        if isinstance(filtered.get("tables"), list):
            filtered["tableCount"] = len(filtered["tables"])
        if isinstance(filtered.get("views"), list):
            filtered["viewCount"] = len(filtered["views"])
        visible_count = int(filtered.get("tableCount") or 0) + int(
            filtered.get("viewCount") or 0
        )
        for key in ("count", "totalCount"):
            if key in filtered:
                filtered[key] = visible_count
        return filtered


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
    database: str | None = None,
    no_guides: bool = False,
    attach_share: str | None = None,
    attach_database: str = "sample_data",
    excluded_schemas: tuple[str, ...] = (),
    guide_topic: str | None = None,
) -> AsyncIterator[MCPSession]:
    """Open an authenticated MCP session as an async context manager.

    Streams over the streamable-HTTP transport to `mcp_url()`, authenticating
    with the MOTHERDUCK_TOKEN bearer. `session_hint`, when given, is passed as a
    `session_name` query param for read-scaling replica affinity — honored if
    the MCP server forwards it, harmless if not. `database`, when given, is pinned
    on the session and injected into query/list_tables/list_columns calls (so
    `--database` actually reaches the server); it falls back to $MD_DATABASE.

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
        url = f"{url}{sep}session_name={quote(str(session_hint), safe='')}"

    headers = {"Authorization": f"Bearer {token}"}
    async with streamablehttp_client(url, headers=headers) as (read_stream, write_stream, _):
        async with ClientSession(read_stream, write_stream) as session:
            await session.initialize()
            if attach_share is not None:
                await _attach_trusted_share(
                    session,
                    share_url=attach_share,
                    alias=database or "",
                    bootstrap_database=attach_database,
                )
            yield MCPSession(
                session,
                database=database,
                no_guides=no_guides,
                excluded_schemas=excluded_schemas,
                guide_topic=guide_topic,
            )


async def _attach_trusted_share(
    session: ClientSession,
    *,
    share_url: str,
    alias: str,
    bootstrap_database: str,
) -> None:
    """Attach a configured share before exposing the read-only agent session."""
    if not _SHARE_URL.fullmatch(share_url):
        raise ValueError(f"Invalid MotherDuck share URL: {share_url!r}")
    for label, value in (("share alias", alias), ("bootstrap database", bootstrap_database)):
        if not _DB_IDENTIFIER.fullmatch(value):
            raise ValueError(f"Invalid {label} {value!r}: expected a plain database identifier.")

    sql = f"ATTACH '{share_url}' AS {alias} (READ_ONLY)"
    result = await session.call_tool(
        "query",
        {"database": bootstrap_database, "sql": sql},
    )
    structured = getattr(result, "structuredContent", None)
    text = json.dumps(structured) if structured is not None else _join_content_text(
        getattr(result, "content", None)
    )
    # MotherDuck attachments can persist for the authenticated session. Treat
    # the idempotent already-attached response as success; all other failures
    # are configuration errors and must happen before the model runs.
    payload_failed = isinstance(structured, dict) and structured.get("success") is False
    attach_failed = getattr(result, "isError", False) is True or payload_failed
    attach_error_is_idempotent = any(
        marker in text.casefold()
        for marker in ("already attached", "already exists")
    )
    if attach_failed and not attach_error_is_idempotent:
        raise RuntimeError(f"Could not attach MotherDuck share as {alias!r}: {text}")

    expected_path = share_url.removeprefix("md:")
    quote_char = "'"
    verify_sql = (
        "SELECT database_name, path, type, readonly FROM duckdb_databases() "
        f"WHERE database_name = {quote_char}{alias}{quote_char}"
    )
    verified = await session.call_tool(
        "query",
        {"database": alias, "sql": verify_sql},
    )
    verified_structured = getattr(verified, "structuredContent", None)
    verified_rows = (
        verified_structured.get("rows") if isinstance(verified_structured, dict) else None
    )
    expected_rows = [[alias, expected_path, "motherduck", True]]
    if (
        getattr(verified, "isError", False) is True
        or not isinstance(verified_structured, dict)
        or verified_structured.get("success") is False
        or verified_rows != expected_rows
    ):
        verify_text = (
            json.dumps(verified_structured)
            if verified_structured is not None
            else _join_content_text(getattr(verified, "content", None))
        )
        raise RuntimeError(
            f"Database alias {alias!r} is not the configured read-only share: {verify_text}"
        )


async def call_tool_write(session: MCPSession, name: str, args: dict) -> MCPResult:
    """Migration-only helper: invoke a guide-write tool with the write gate open.

    Never used on the agent path — only the guides migration (guides_load)
    should reach for this.
    """
    return await session.call_tool(name, args, allow_write=True)
