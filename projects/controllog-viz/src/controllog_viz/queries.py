"""Derived SQL views over ``events`` / ``postings`` — the semantics layer.

Each function takes a connection from :func:`controllog_viz.reader.connect` and returns
``list[dict]`` rows. Renderers consume these rows and never write SQL themselves.

Conventions:
- A posting slice is "balanced" (must net to zero, spec § 8) when
  ``account_type LIKE 'resource.%'`` OR it is ``value.utility`` / ``truth.state`` —
  mirroring ``controllog.sdk._check_invariants``.
- "Flow" for a totals column is the sum of *positive* deltas on an account/unit. This is
  source-side-agnostic and always non-negative, the universal stand-in for "how much
  moved" without needing to know which ``account_id`` is the project side (spec § 9.1).
"""
from __future__ import annotations

from typing import Any

import duckdb

# SQL fragment: 1 when a slice is subject to the trial-balance invariant, else 0.
_IS_BALANCED = (
    "(account_type LIKE 'resource.%' OR account_type IN ('value.utility', 'truth.state'))"
)
_EPS = 1e-4

# Account types surfaced as scalar totals on the runs table / stats bars.
COST_ACCOUNT = "resource.money"
LATENCY_ACCOUNT = "resource.time_ms"
UTILITY_ACCOUNT = "value.utility"

# Friendly labels for known SDK accounts; unknown accounts fall back to the raw name.
ACCOUNT_LABELS = {
    "resource.money": "Cost",
    "resource.time_ms": "Latency",
    "resource.tokens": "Tokens",
    "value.utility": "Utility",
    "truth.state": "State",
}


def _rows(con: duckdb.DuckDBPyConnection, sql: str, params: list[Any] | None = None) -> list[dict]:
    cur = con.execute(sql, params or [])
    cols = [d[0] for d in cur.description]
    return [dict(zip(cols, row)) for row in cur.fetchall()]


def runs(con: duckdb.DuckDBPyConnection, limit: int | None = None) -> list[dict]:
    """One row per run: time range, event/kind counts, headline totals, invariant flag.

    Always returned oldest-first. ``limit`` keeps only the most recent N runs (then
    re-sorts them oldest-first) — for datasets with thousands of runs.
    """
    order = "ORDER BY ev.first_time DESC" if limit else "ORDER BY ev.first_time"
    limit_clause = f"LIMIT {int(limit)}" if limit else ""
    rows = _rows(
        con,
        f"""
        WITH ev AS (
            SELECT
                run_id,
                CAST(MIN(event_time) AS VARCHAR) AS first_time,
                CAST(MAX(event_time) AS VARCHAR) AS last_time,
                COUNT(*)        AS event_count,
                COUNT(DISTINCT kind) AS kind_count
            FROM events
            GROUP BY run_id
        ),
        po AS (
            SELECT
                e.run_id,
                p.account_type,
                SUM(p.delta_numeric)                                   AS net,
                SUM(CASE WHEN p.delta_numeric > 0 THEN p.delta_numeric ELSE 0 END) AS flow,
                {_IS_BALANCED} AS is_balanced
            FROM postings p
            JOIN events e ON p.event_id = e.event_id
            GROUP BY e.run_id, p.account_type
        )
        SELECT
            ev.run_id,
            ev.first_time,
            ev.last_time,
            ev.event_count,
            ev.kind_count,
            COALESCE(SUM(CASE WHEN po.account_type = '{COST_ACCOUNT}'    THEN po.flow END), 0) AS cost,
            COALESCE(SUM(CASE WHEN po.account_type = '{LATENCY_ACCOUNT}' THEN po.flow END), 0) AS latency_ms,
            COALESCE(SUM(CASE WHEN po.account_type = '{UTILITY_ACCOUNT}' THEN po.flow END), 0) AS utility,
            COALESCE(BOOL_AND(NOT (po.is_balanced AND ABS(po.net) > {_EPS})), TRUE) AS invariant_ok
        FROM ev
        LEFT JOIN po ON ev.run_id = po.run_id
        GROUP BY ev.run_id, ev.first_time, ev.last_time, ev.event_count, ev.kind_count
        {order}
        {limit_clause}
        """,
    )
    if limit:
        rows.reverse()
    return rows


def events_for_run(con: duckdb.DuckDBPyConnection, run_id: str) -> list[dict]:
    """Ordered event timeline for one run, payload as a JSON string for rendering."""
    return _rows(
        con,
        """
        SELECT
            CAST(event_time AS VARCHAR) AS event_time,
            kind,
            actor_agent_id,
            actor_task_id,
            idempotency_key,
            CAST(payload_json AS VARCHAR) AS payload_json
        FROM events
        WHERE run_id IS NOT DISTINCT FROM ?
        ORDER BY event_time, event_id
        """,
        [run_id],
    )


def kind_counts(con: duckdb.DuckDBPyConnection, run_id: str | None = None) -> list[dict]:
    """Histogram of event kinds, optionally scoped to one run."""
    where, params = ("WHERE run_id IS NOT DISTINCT FROM ?", [run_id]) if run_id is not None else ("", [])
    return _rows(
        con,
        f"SELECT kind, COUNT(*) AS count FROM events {where} GROUP BY kind ORDER BY count DESC, kind",
        params,
    )


def kind_counts_by_run(con: duckdb.DuckDBPyConnection) -> list[dict]:
    """Per-run event-kind counts, for the dashboard's stacked bar chart."""
    return _rows(
        con,
        """
        SELECT run_id, kind, COUNT(*) AS count
        FROM events
        GROUP BY run_id, kind
        ORDER BY run_id, kind
        """,
    )


def postings_rollup(con: duckdb.DuckDBPyConnection, run_id: str | None = None) -> list[dict]:
    """Per ``(account_type, unit)``: net, positive flow, and posting count."""
    join, where, params = "", "", []
    if run_id is not None:
        join = "JOIN events e ON p.event_id = e.event_id"
        where = "WHERE e.run_id IS NOT DISTINCT FROM ?"
        params = [run_id]
    return _rows(
        con,
        f"""
        SELECT
            p.account_type,
            p.unit,
            SUM(p.delta_numeric) AS net,
            SUM(CASE WHEN p.delta_numeric > 0 THEN p.delta_numeric ELSE 0 END) AS flow,
            COUNT(*) AS posting_count
        FROM postings p
        {join}
        {where}
        GROUP BY p.account_type, p.unit
        ORDER BY p.account_type, p.unit
        """,
        params,
    )


def trial_balance(con: duckdb.DuckDBPyConnection, run_id: str | None = None) -> list[dict]:
    """Balanced slices whose net deviates from zero — the invariant/drift check.

    Empty result == healthy. Each row is a ``(account_type, unit, net)`` violation.
    """
    join, run_filter, params = "", "", []
    if run_id is not None:
        join = "JOIN events e ON p.event_id = e.event_id"
        run_filter = "AND e.run_id IS NOT DISTINCT FROM ?"
        params = [run_id]
    return _rows(
        con,
        f"""
        SELECT
            p.account_type,
            p.unit,
            SUM(p.delta_numeric) AS net
        FROM postings p
        {join}
        WHERE {_IS_BALANCED.replace("account_type", "p.account_type")}
        {run_filter}
        GROUP BY p.account_type, p.unit
        HAVING ABS(SUM(p.delta_numeric)) > {_EPS}
        ORDER BY p.account_type, p.unit
        """,
        params,
    )


def latest_run_id(con: duckdb.DuckDBPyConnection) -> str | None:
    """Run with the most recent event, for ``--latest``."""
    row = con.execute(
        "SELECT run_id FROM events GROUP BY run_id ORDER BY MAX(event_time) DESC LIMIT 1"
    ).fetchone()
    return row[0] if row else None
