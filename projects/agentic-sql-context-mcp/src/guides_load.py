"""Migration: publish the local context items as MotherDuck guides.

This is the write half of the "context layer IS guides" swap. The project's
27 semantic-layer context items (fee-matching rules, bucketing logic, term
mappings, SQL patterns, format rules — one markdown file per item under
`context/items/`, parsed by `src.context_store.ContextStore`) are published to
the MotherDuck MCP server as **guides** via the guide-write tools. Once
published, the agent reaches them through the read-only list_guides/get_guide
path (see `src.mcp_client`) instead of the former in-process markdown store.

## Topic / uuid model (post-2026-07-23 platform deploy)

Guides are no longer path-addressed. Each guide is identified by a
server-minted **uuid**, grouped under a plain **topic** label, and its
visibility is set by **access** (`user` / `organization`) — not by where it
sits in a path. So each item is published as:

    topic       = f"{prefix}/{item.domain}"    # e.g. "dabstep/fees"
    title       = item.id
    description  = item.summary
    content      = item.body
    access      = DABSTEP_GUIDES_ACCESS (default "user")
    external_id = item.id                       # traceability only, NOT dedup

where `prefix = os.environ.get("DABSTEP_GUIDES_PREFIX", "dabstep")`. The prefix
is now a topic label, not a filesystem path. `access` defaults to `user`: the
service-account token can only write personal guides — organization writes are
admin-only.

## Idempotency via a committed lockfile

`external_id` is NOT a server-side dedup key — creating twice with the same
external_id mints two different uuids. So idempotency is driven entirely by a
local, committed lockfile `guides.lock.json` at the repo root, which maps each
`item.id` to the uuid the server minted for it (plus its topic/title/access):

    {
      "generated_for_prefix": "dabstep",
      "guides": {
        "<item.id>": {"uuid": "...", "topic": "...", "title": "...", "access": "..."},
        ...
      }
    }

On `publish_all`:
  * item.id present in the lock with a uuid -> update_guide(uuid, content) to
    refresh the body, then update_guide_metadata(uuid, title, description,
    topic) to refresh metadata. Action "updated".
  * otherwise -> create_guide(...), capture structuredContent.guide.id, record
    it in the lock. Action "created".
The lock is written back at the end (even on partial failure) so successful
uuids are never lost and a re-run resumes as updates.

Self-contained: stdlib + `src.context_store` + `src.mcp_client` only. run.py is
responsible for load_dotenv before calling in; this module does not touch the
environment beyond reading the config vars above.
"""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path

from src.context_store import ContextStore
from src.mcp_client import create_mcp_session

REPO_ROOT = Path(__file__).resolve().parents[1]
LOCKFILE_PATH = REPO_ROOT / "guides.lock.json"

DEFAULT_PREFIX = "dabstep"
DEFAULT_ACCESS = "user"


def _topic(prefix: str, item) -> str:
    """The MotherDuck guide topic for one context item: prefix/domain."""
    return f"{prefix}/{item.domain}"


def _load_lock(path: Path = LOCKFILE_PATH) -> dict:
    """Load the guides lockfile, or an empty {id -> entry} map if absent."""
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text())
    except (ValueError, OSError):
        return {}
    guides = data.get("guides") if isinstance(data, dict) else None
    return guides if isinstance(guides, dict) else {}


def _write_lock(lock: dict, prefix: str, path: Path = LOCKFILE_PATH) -> None:
    """Persist the {id -> entry} map to the lockfile with stable, sorted keys."""
    payload = {
        "generated_for_prefix": prefix,
        "guides": {k: lock[k] for k in sorted(lock)},
    }
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")


def _parse_created_uuid(text: str) -> str | None:
    """Pull the server-minted uuid out of a create_guide result payload.

    The result text is JSON of structuredContent; the uuid lives at
    ["guide"]["id"]. Returns None if it can't be parsed / located.
    """
    try:
        parsed = json.loads(text)
    except (ValueError, TypeError):
        return None
    if not isinstance(parsed, dict):
        return None
    guide = parsed.get("guide")
    if not isinstance(guide, dict):
        return None
    uuid = guide.get("id")
    return uuid if isinstance(uuid, str) and uuid else None


async def publish_all(
    prefix: str | None = None,
    access: str | None = None,
    dry_run: bool = False,
) -> list[dict]:
    """Publish every local context item as a MotherDuck guide (idempotent).

    Opens a single MCP session and, for each ContextItem, consults the committed
    lockfile: a known uuid is refreshed (update_guide body + update_guide_metadata),
    an unknown item is created and its minted uuid recorded in the lock.

    Args:
        prefix: Topic prefix; defaults to DABSTEP_GUIDES_PREFIX env or "dabstep".
        access: Guide access level ("user" or "organization"); defaults to
            DABSTEP_GUIDES_ACCESS env or "user".
        dry_run: If True, make no MCP calls — just return planned records with the
            computed topic and the known uuid (from the lock) if any.

    Returns:
        One result dict per item: {id, topic, uuid, action, error}, where action
        is one of "created" / "updated" / "failed" (or "planned" for a dry run)
        and error is None unless the item failed.
    """
    prefix = (prefix or os.environ.get("DABSTEP_GUIDES_PREFIX", DEFAULT_PREFIX)).rstrip("/")
    access = access or os.environ.get("DABSTEP_GUIDES_ACCESS", DEFAULT_ACCESS)

    store = ContextStore()
    items = [store._by_id[i] for i in sorted(store._by_id)]

    lock = _load_lock()

    if dry_run:
        return [
            {
                "id": item.id,
                "topic": _topic(prefix, item),
                "uuid": (lock.get(item.id) or {}).get("uuid"),
                "action": "planned",
                "error": None,
            }
            for item in items
        ]

    results: list[dict] = []
    try:
        async with create_mcp_session(session_hint="guides-load") as session:
            for item in items:
                topic = _topic(prefix, item)
                existing = lock.get(item.id) or {}
                known_uuid = existing.get("uuid")
                record: dict = {
                    "id": item.id,
                    "topic": topic,
                    "uuid": known_uuid,
                    "action": None,
                    "error": None,
                }
                try:
                    if known_uuid:
                        # Idempotent update: refresh body, then metadata.
                        body = await session.call_tool(
                            "update_guide",
                            {
                                "uuid": known_uuid,
                                "content": item.body,
                                "external_id": item.id,
                            },
                            allow_write=True,
                        )
                        if body.is_error:
                            record["action"] = "failed"
                            record["error"] = body.text
                        else:
                            meta = await session.call_tool(
                                "update_guide_metadata",
                                {
                                    "uuid": known_uuid,
                                    "title": item.id,
                                    "description": item.summary,
                                    "topic": topic,
                                },
                                allow_write=True,
                            )
                            if meta.is_error:
                                record["action"] = "failed"
                                record["error"] = meta.text
                            else:
                                record["action"] = "updated"
                        # Keep the lock entry current regardless of update outcome.
                        lock[item.id] = {
                            "uuid": known_uuid,
                            "topic": topic,
                            "title": item.id,
                            "access": access,
                        }
                    else:
                        # Create a fresh guide and capture its minted uuid.
                        created = await session.call_tool(
                            "create_guide",
                            {
                                "title": item.id,
                                "content": item.body,
                                "description": item.summary,
                                "topic": topic,
                                "access": access,
                                "external_id": item.id,
                            },
                            allow_write=True,
                        )
                        if created.is_error:
                            record["action"] = "failed"
                            record["error"] = created.text
                        else:
                            new_uuid = _parse_created_uuid(created.text)
                            if not new_uuid:
                                record["action"] = "failed"
                                record["error"] = (
                                    "create_guide succeeded but no guide.id was "
                                    f"found in the response: {created.text[:200]}"
                                )
                            else:
                                record["uuid"] = new_uuid
                                record["action"] = "created"
                                lock[item.id] = {
                                    "uuid": new_uuid,
                                    "topic": topic,
                                    "title": item.id,
                                    "access": access,
                                }
                except Exception as exc:  # noqa: BLE001 — record, keep migrating.
                    record["action"] = "failed"
                    record["error"] = f"{type(exc).__name__}: {exc}"
                results.append(record)
    finally:
        # Persist whatever succeeded, even on partial failure.
        _write_lock(lock, prefix)

    return results


def publish_all_sync(
    prefix: str | None = None,
    access: str | None = None,
    dry_run: bool = False,
) -> list[dict]:
    """Synchronous wrapper over publish_all for the Click entrypoint in run.py."""
    return asyncio.run(publish_all(prefix=prefix, access=access, dry_run=dry_run))
