#!/usr/bin/env python
"""Guide round-trip smoketest: create -> list -> retrieve (-> cleanup).

Exercises the guides MCP surface end-to-end through the fork's own client
(`src/mcp_client.py`) under the **topic/uuid** model (post-2026-07-23 deploy),
so a PASS means the semantic layer is actually usable by the agent:

  1. get_query_guide — confirm the entry point returns the org catalog.
  2. create_guide    — write a throwaway personal guide (topic + marker body);
                       capture the server-minted uuid.
  3. list_guides     — confirm it shows up under its topic, carrying that uuid.
  4. get_guide       — fetch by uuid and check the marker comes back in the body.
  5. delete_guide    — clean up by uuid (best-effort).

Exit code 0 iff get_guide(uuid) returns the marker body; 1 otherwise.

Usage (from the project root, with a write-capable MOTHERDUCK_TOKEN in .env):

    uv run python scripts/guide_smoketest.py
    uv run python scripts/guide_smoketest.py --keep   # skip cleanup
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path

# Make `src` importable and load .env the same way the CLI does.
_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_ROOT))

try:
    from dotenv import load_dotenv

    load_dotenv(_ROOT / ".env")
except ModuleNotFoundError:
    pass

from mcp import ClientSession  # noqa: E402
from mcp.client.streamable_http import streamablehttp_client  # noqa: E402

from src.mcp_client import (  # noqa: E402
    call_tool_write,
    create_mcp_session,
    mcp_url,
)

MARKER = "SMOKETEST-MARKER-90d1f2"
TOPIC = "dabstep/zz-smoketest"


def _payload(result_text: str) -> dict:
    """Parse an MCPResult.text back into its JSON payload (best-effort)."""
    try:
        obj = json.loads(result_text)
        return obj if isinstance(obj, dict) else {}
    except (ValueError, TypeError):
        return {}


def _body_of(payload: dict) -> str:
    """Pull the guide body out of a get_guide payload, whatever the shape.

    get_guide returns structuredContent={"text": "<rendered guide markdown>"}
    (the whole guide as one rendered string), so `text` is the primary source;
    the guide/body/content shapes are kept as defensive fallbacks.
    """
    guide = payload.get("guide")
    if isinstance(guide, dict):
        return guide.get("body") or guide.get("content") or ""
    return payload.get("text") or payload.get("body") or payload.get("content") or ""


async def _raw_delete(uuid: str) -> str:
    """delete_guide is not on the fork's allowlist (agent never deletes), so hit
    the raw MCP session directly for cleanup."""
    token = os.environ["MOTHERDUCK_TOKEN"]
    headers = {"Authorization": f"Bearer {token}"}
    async with streamablehttp_client(mcp_url(), headers=headers) as (r, w, _):
        async with ClientSession(r, w) as s:
            await s.initialize()
            res = await s.call_tool("delete_guide", {"uuid": uuid})
            return json.dumps(getattr(res, "structuredContent", None) or {})


async def main(keep: bool) -> int:
    if not os.environ.get("MOTHERDUCK_TOKEN"):
        print("FAIL: MOTHERDUCK_TOKEN is not set (need a write-capable token).")
        return 1

    access = os.environ.get("DABSTEP_GUIDES_ACCESS", "user")
    print(f"endpoint : {mcp_url()}")
    print(f"topic    : {TOPIC}  (access={access})\n")

    uuid: str | None = None
    got_body = False
    async with create_mcp_session(session_hint="guide-smoketest") as mcp:
        # 0. ENTRY POINT ----------------------------------------------------
        entry = await mcp.call_tool("get_query_guide", {})
        print(f"[0] get_query_guide -> {'OK' if not entry.is_error else 'FAIL'}")
        if entry.is_error:
            print(f"    {entry.text[:300]}")
            return 1

        # 1. CREATE ---------------------------------------------------------
        create = await call_tool_write(
            mcp,
            "create_guide",
            {
                "topic": TOPIC,
                "title": "Guide smoketest",
                "description": "throwaway round-trip probe",
                "access": access,
                "external_id": "zz-smoketest",
                "content": f"# Guide Smoketest\n\n{MARKER}\n",
            },
        )
        cpayload = _payload(create.text)
        guide = cpayload.get("guide") if isinstance(cpayload, dict) else None
        uuid = guide.get("id") if isinstance(guide, dict) else None
        if create.is_error or not uuid:
            print(f"[1] create_guide    -> FAIL\n    {create.text[:300]}")
            return 1
        print(f"[1] create_guide    -> OK   uuid={uuid}")

        # 2. LIST -----------------------------------------------------------
        listing = await mcp.call_tool("list_guides", {"topic": TOPIC})
        lpayload = _payload(listing.text)
        guides = lpayload.get("guides", []) if isinstance(lpayload, dict) else []
        seen = any(
            isinstance(g, dict) and g.get("uuid") == uuid for g in guides
        )
        print(f"[2] list_guides     -> {'OK  (uuid present)' if seen else 'WARN (uuid not in topic listing)'}")

        # 3. RETRIEVE BY UUID ----------------------------------------------
        r = await mcp.call_tool("get_guide", {"uuid": uuid})
        body = _body_of(_payload(r.text))
        got_body = (not r.is_error) and (MARKER in body)
        if got_body:
            print(f"[3] get_guide(uuid) -> PASS (marker returned)")
        else:
            err = _payload(r.text).get("error") or r.text
            print(f"[3] get_guide(uuid) -> fail -> {str(err)[:120]}")

        # 4. CLEANUP --------------------------------------------------------
    if keep:
        print(f"\n[4] cleanup         -> SKIPPED (--keep); delete uuid {uuid} manually")
    elif uuid:
        try:
            print(f"\n[4] delete_guide    -> {await _raw_delete(uuid)}")
        except Exception as exc:  # best-effort cleanup
            print(f"\n[4] delete_guide    -> WARN could not delete: {exc}")

    print("\n" + ("=" * 52))
    if got_body:
        print("RESULT: PASS ✅  guide retrieval works — semantic layer is live.")
        return 0
    print("RESULT: FAIL ⛔  create+list work but get_guide(uuid) did not return")
    print("        the marker body. Investigate the topic/uuid round-trip.")
    return 1


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--keep", action="store_true", help="skip cleanup delete")
    args = ap.parse_args()
    raise SystemExit(asyncio.run(main(args.keep)))
