"""One-time migration: publish the local context items as MotherDuck guides.

This is the write half of the "context layer IS guides" swap. The project's
27 semantic-layer context items (fee-matching rules, bucketing logic, term
mappings, SQL patterns, format rules — one markdown file per item under
`context/items/`, parsed by `src.context_store.ContextStore`) are published to
the MotherDuck MCP server as **guides** via the guide-write tools. Once
published, the agent reaches them through the read-only list_guides/get_guide
path (see `src.mcp_client`) instead of the former in-process markdown store.

The migration is idempotent: a create that fails because the guide already
exists is retried as an update, so re-running only refreshes bodies.

## Guide paths and access

Each item is published at:

    f"{prefix}/{item.domain}/{item.id}.md"

where `prefix = os.environ.get("DABSTEP_GUIDES_PREFIX", "dabstep")` and the
guide access level is `os.environ.get("DABSTEP_GUIDES_ACCESS", "organization")`.

Organization-level guides require an admin token. If a create_guide call is
rejected because org access (or the top-level path) is not permitted for the
token in use, re-run against a personal namespace instead:

    DABSTEP_GUIDES_PREFIX="users/<username>/dabstep" \\
    DABSTEP_GUIDES_ACCESS="user" \\
    python run.py guides-load        # (or whatever the Click entrypoint is)

Personal (`access="user"`) guides must live under `users/<username>/...`; the
server enforces that half, and the client path guard in `src.mcp_client`
enforces slug confinement on top.

Self-contained: stdlib + `src.context_store` + `src.mcp_client` only. run.py is
responsible for load_dotenv before calling in; this module does not touch the
environment beyond reading the config vars above.
"""

from __future__ import annotations

import asyncio
import os

from src.context_store import ContextStore
from src.mcp_client import create_mcp_session

DEFAULT_PREFIX = "dabstep"
DEFAULT_ACCESS = "organization"

# Substrings that, in a failed create_guide error message, indicate the guide
# already exists (a duplicate path) rather than a genuine failure — the signal
# to retry as an idempotent update.
_ALREADY_EXISTS_MARKERS = ("already exist", "duplicate", "already present")


def _guide_path(prefix: str, item) -> str:
    """The MotherDuck guide path for one context item: prefix/domain/id.md."""
    return f"{prefix}/{item.domain}/{item.id}.md"


def _looks_like_duplicate(message: str) -> bool:
    """True if a create_guide error message indicates the path already exists."""
    lowered = (message or "").lower()
    return any(marker in lowered for marker in _ALREADY_EXISTS_MARKERS)


async def publish_all(
    prefix: str | None = None,
    access: str | None = None,
    dry_run: bool = False,
) -> list[dict]:
    """Publish every local context item as a MotherDuck guide.

    Opens a single MCP session and, for each ContextItem, calls create_guide;
    if that reports the guide already exists, retries with update_guide so the
    run is idempotent.

    Args:
        prefix: Guide-path prefix; defaults to DABSTEP_GUIDES_PREFIX env or
            "dabstep".
        access: Guide access level ("organization" or "user"); defaults to
            DABSTEP_GUIDES_ACCESS env or "organization".
        dry_run: If True, make no MCP calls — just return the planned paths
            (each with action="planned").

    Returns:
        One result dict per item: {id, path, action, error}, where action is
        one of "created" / "updated" / "failed" (or "planned" for a dry run)
        and error is None unless the item failed.
    """
    prefix = prefix or os.environ.get("DABSTEP_GUIDES_PREFIX", DEFAULT_PREFIX)
    access = access or os.environ.get("DABSTEP_GUIDES_ACCESS", DEFAULT_ACCESS)

    store = ContextStore()
    items = [store._by_id[i] for i in sorted(store._by_id)]

    if dry_run:
        return [
            {
                "id": item.id,
                "path": _guide_path(prefix, item),
                "action": "planned",
                "error": None,
            }
            for item in items
        ]

    results: list[dict] = []
    async with create_mcp_session(session_hint="guides-load") as session:
        for item in items:
            path = _guide_path(prefix, item)
            record: dict = {"id": item.id, "path": path, "action": None, "error": None}
            try:
                create_args = {
                    "path": path,
                    "title": item.id,
                    "content": item.body,
                    "description": item.summary,
                    "access": access,
                }
                result = await session.call_tool(
                    "create_guide", create_args, allow_write=True
                )
                if not result.is_error:
                    record["action"] = "created"
                elif _looks_like_duplicate(result.text):
                    # Idempotent path: the guide already exists — update its body.
                    update = await session.call_tool(
                        "update_guide",
                        {"path": path, "content": item.body},
                        allow_write=True,
                    )
                    if update.is_error:
                        record["action"] = "failed"
                        record["error"] = update.text
                    else:
                        record["action"] = "updated"
                else:
                    record["action"] = "failed"
                    record["error"] = result.text
            except Exception as exc:  # noqa: BLE001 — record, keep migrating.
                record["action"] = "failed"
                record["error"] = f"{type(exc).__name__}: {exc}"
            results.append(record)

    return results


def publish_all_sync(
    prefix: str | None = None,
    access: str | None = None,
    dry_run: bool = False,
) -> list[dict]:
    """Synchronous wrapper over publish_all for the Click entrypoint in run.py."""
    return asyncio.run(publish_all(prefix=prefix, access=access, dry_run=dry_run))
