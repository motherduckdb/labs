"""Publish compiled boards as MotherDuck Dives.

Runs inside a MotherDuck Flight (see ``flight.py``). Per eligible board:

* find the Dive by **name** — the project's name and the board's path — using the registry
  table first, then the description marker, so a run never creates a second Dive for a board
  it already published, even if the registry was lost;
* ``MD_CREATE_DIVE`` when it is genuinely new, else ``MD_UPDATE_DIVE_CONTENT`` +
  ``MD_UPDATE_DIVE_METADATA``;
* record id, title and URL in ``<database>.<schema>.dbt_charts_dive_registry``.

MotherDuck's dive functions are table functions and cannot take subqueries, so every value
is staged in a session variable (``SET VARIABLE … = ?``) and passed with ``getvariable()``.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

import duckdb

DIVE_URL = "https://app.motherduck.com/dives/{id}"
# Appended to every Dive's description: provenance, and the key that identifies the board
# again when the registry table is gone (two boards may legitimately share a title).
MARKER = "dbt_charts_dive:"
RESOURCE_TYPE = 'STRUCT("name" VARCHAR, alias VARCHAR, url VARCHAR, resource_type VARCHAR)[]'


def publish(
    project_dir: Path,
    con: duckdb.DuckDBPyConnection,
    *,
    database: str,
    schema: str,
    options: dict[str, Any],
    failed: list[str],
    log: Callable[[str], None] = print,
) -> list[dict[str, Any]]:
    from dbt_charts_dive.config import build, plan

    boards = plan(project_dir, options, failed)
    if not boards:
        log("dbt_charts_dive: no boards to publish (dive.publish is none, or charts/ is empty)")
        return []
    registry = f'"{database}"."{schema}"."dbt_charts_dive_registry"'
    con.execute(f"CREATE TABLE IF NOT EXISTS {registry} (dive_key VARCHAR, dive_id UUID, title VARCHAR, dive_url VARCHAR, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ)")
    results: list[dict[str, Any]] = []

    # Compile every board first. Publishing as we go leaves the dashboards half updated when
    # a later board cannot be built — and half-updated is the state nobody can reason about.
    ready: list[tuple[dict[str, Any], dict[str, Any]]] = []
    for b in boards:
        entry: dict[str, Any] = {"key": b["key"], "path": b["path"]}
        results.append(entry)
        if b.get("skip"):
            log(f"dbt_charts_dive: skip {b['path']} ({b['skip']})")
            entry["skipped"] = b["skip"]
            continue
        try:
            built = build(project_dir, b["path"], options)
        except Exception as e:  # noqa: BLE001 — reported per board, and below for the run
            log(f"dbt_charts_dive: FAILED {b['path']}: {type(e).__name__}: {e}")
            entry["error"] = f"{type(e).__name__}: {e}"
            continue
        stale = stale_refs(built.get("refs") or [], failed)
        if stale:
            log(f"dbt_charts_dive: skip {b['path']} (upstream failed: {', '.join(stale)})")
            entry["skipped"] = "upstream failed: " + ", ".join(stale)
            continue
        ready.append((b, built))

    broken = [r for r in results if r.get("error")]
    if broken and options.get("all_or_nothing", True):
        for entry, _ in ((e, None) for e in results if not e.get("error") and not e.get("skipped")):
            entry["skipped"] = "another board in this run failed"
        log(f"dbt_charts_dive: published nothing — {len(broken)} board(s) failed to build (dive: {{all_or_nothing: false}} to publish the rest)")
        return results

    for b, built in ready:
        entry = next(r for r in results if r["key"] == b["key"])
        if entry.get("skipped"):
            continue
        dive_id, action = _upsert(con, registry, b["key"], built, legacy_key=b.get("legacy_key"))
        url = DIVE_URL.format(id=dive_id)
        log(f"dbt_charts_dive: {action} dive {b['key']} -> {url}")
        entry.update(dive_id=dive_id, url=url, action=action, title=built["title"])
    gone = orphaned([b["key"] for b in boards], [r[0] for r in con.execute(f"SELECT dive_key FROM {registry}").fetchall()])
    if gone:
        log(f"dbt_charts_dive: {len(gone)} dive(s) no longer have a board here and were left alone: {', '.join(gone)}")
    return results


def described(description: str, key: str) -> str:
    """The Dive description, with this board's marker appended."""
    body = (description or "").rstrip()
    return f"{body}\n\n{MARKER} {key}" if body else f"{MARKER} {key}"


def _marker_ids(con: duckdb.DuckDBPyConnection, key: str) -> list[str]:
    """Every Dive whose description ends with this board's marker, oldest first.

    ``ends_with`` rather than ``LIKE``: the marker is the last thing ``described()`` writes,
    and a key is not a pattern — ``LIKE '%… analytics:sales%'`` also matches
    ``analytics:sales_old``, and an ``_`` or a ``%`` in a board's own name matches anything.
    """
    con.execute("SET VARIABLE dcd_marker = ?", [f"{MARKER} {key}"])
    rows = con.execute(
        "SELECT id::VARCHAR FROM MD_LIST_DIVES(\"limit\" := 500) WHERE ends_with(description, getvariable('dcd_marker')) ORDER BY created_at"
    ).fetchall()
    return [str(r[0]) for r in rows]


def _find_dive(con: duckdb.DuckDBPyConnection, registry: str, key: str, title: str, *, legacy_key: str | None = None) -> tuple[str | None, str | None]:
    """The Dive this board already owns and the key it was found under, or ``(None, None)``.

    One key at a time, this board's own first: the registry table (keyed by project and
    board path, so a retitled board keeps its Dive), then the ``dbt_charts_dive:`` marker
    this package writes into every description, which survives a lost registry.
    ``legacy_key`` is the same board's key from a version that did not name the project; a
    Dive found under it is adopted, not duplicated — but only once this board's own key has
    come up empty, since a leftover bare-key row may belong to another project by now.

    There is no third way. A Dive this package did not publish carries no marker, and a
    board's title is not a name: matching on it hands a board somebody else's Dive.
    """
    for k in (x for x in (key, legacy_key) if x):
        row = con.execute(f"SELECT dive_id::VARCHAR FROM {registry} WHERE dive_key = ? LIMIT 1", [k]).fetchone()
        if row and row[0]:
            con.execute("SET VARIABLE dcd_id = ?", [row[0]])
            if con.execute("SELECT count(*) FROM MD_GET_DIVE(id := getvariable('dcd_id')::UUID)").fetchone()[0]:
                return str(row[0]), k
        found = _marker_ids(con, k)
        if found:
            return found[0], k
    return None, None


def stale_refs(refs: list[str], failed: list[str]) -> list[str]:
    """The models this board reads that this dbt run did not build. Planning reads the
    board's own text, which names nothing at all when the query came from a partial; the
    compiler resolved every ``ref()`` for real, so ask it before publishing."""
    return sorted(set(refs) & set(failed))


def orphaned(keys: list[str], registered: list[str]) -> list[str]:
    """Registry keys with no board behind them any more — a renamed or deleted board. Their
    Dives are still somebody's link, so they are reported, never removed."""
    return sorted(set(registered) - set(keys))


def _upsert(con: duckdb.DuckDBPyConnection, registry: str, key: str, built: dict[str, Any], *, legacy_key: str | None = None) -> tuple[str, str]:
    con.execute("SET VARIABLE dcd_title = ?", [built["title"]])
    con.execute("SET VARIABLE dcd_description = ?", [described(built["description"], key)])
    con.execute("SET VARIABLE dcd_content = ?", [built["content"]])
    con.execute("SET VARIABLE dcd_resources = ?", [json.dumps(built["required_resources"])])
    resources = f"getvariable('dcd_resources')::JSON::{RESOURCE_TYPE}"

    existing, matched = _find_dive(con, registry, key, built["title"], legacy_key=legacy_key)
    if existing:
        # _find_dive may have matched by marker or title, so bind the id the updates read.
        con.execute("SET VARIABLE dcd_id = ?", [existing])
        con.execute(
            "SELECT * FROM MD_UPDATE_DIVE_CONTENT(id := getvariable('dcd_id')::UUID, content := getvariable('dcd_content'), "
            f"description := getvariable('dcd_description'), api_version := 1, required_resources := {resources})"
        )
        con.execute("SELECT * FROM MD_UPDATE_DIVE_METADATA(id := getvariable('dcd_id')::UUID, title := getvariable('dcd_title'), description := getvariable('dcd_description'))")
        dive_id, action = existing, "updated"
    else:
        dive_id = str(con.execute(
            "SELECT id::VARCHAR FROM MD_CREATE_DIVE(title := getvariable('dcd_title'), content := getvariable('dcd_content'), "
            f"description := getvariable('dcd_description'), api_version := 1, required_resources := {resources})"
        ).fetchone()[0])
        action = "created"
        # Another run can have published this board in the meantime — both looked, both
        # found nothing. The oldest Dive carrying the marker wins and this run withdraws
        # the one it just made, so the board still owns exactly one.
        mine, matched = dive_id, key
        oldest = next(iter(_marker_ids(con, key)), mine)
        if oldest != mine:
            con.execute("SET VARIABLE dcd_id = ?", [mine])
            con.execute("SELECT * FROM MD_DELETE_DIVE(id := getvariable('dcd_id')::UUID)")
            dive_id, action = oldest, "updated"
    # Only this board's rows: a bare legacy key it did not use may belong to another project.
    stale = [key] + ([legacy_key] if legacy_key and matched == legacy_key else [])
    con.execute(f"DELETE FROM {registry} WHERE dive_key IN ({', '.join('?' * len(stale))})", stale)
    con.execute(f"INSERT INTO {registry} SELECT ?, ?::UUID, getvariable('dcd_title'), ?, now(), now()", [key, dive_id, DIVE_URL.format(id=dive_id)])
    return dive_id, action
