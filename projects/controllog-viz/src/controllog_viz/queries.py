"""Derived SQL views over ``events`` / ``postings`` — the semantics layer.

Each function takes a connection from :func:`controllog_viz.reader.connect` and returns
``list[dict]`` rows. Renderers consume these rows and never write SQL themselves.

Conventions:
- Every ``(account_type, unit)`` slice must net to zero — the conservation invariant
  applies to *all* accounts (``controllog.sdk._check_invariants`` balances every slice;
  ``controllog.motherduck.verify`` checks every slice with no type filter). So the
  trial-balance / drift checks here do not special-case any account type.
- "Flow" for a totals column is the sum of *positive* deltas on an account/unit. This is
  source-side-agnostic and always non-negative, the universal stand-in for "how much
  moved" without needing to know which ``account_id`` is the project side (spec § 9.1).
- Totals recognize both the canonical ``truth.*`` accounts emitted by ``projects/controllog``
  and the legacy ``resource.money`` / ``resource.time_ms`` / ``value.utility`` names used by
  older datasets (e.g. agentic-sql), so either source produces non-zero cost/latency/utility.
"""
from __future__ import annotations

from typing import Any

import duckdb

_EPS = 1e-4

# SQL IN-lists: account types that map to each headline total (canonical + legacy names).
_COST_IN = "('truth.money', 'resource.money')"
_LATENCY_IN = "('truth.time', 'resource.time_ms')"
_UTILITY_IN = "('truth.utility', 'value.utility')"

# Friendly labels for known SDK accounts; unknown accounts fall back to the raw name.
ACCOUNT_LABELS = {
    "truth.money": "Cost",
    "resource.money": "Cost",
    "truth.time": "Latency",
    "resource.time_ms": "Latency",
    "truth.utility": "Utility",
    "value.utility": "Utility",
    "resource.tokens": "Tokens",
    "truth.state": "State",
}


def _rows(con: duckdb.DuckDBPyConnection, sql: str, params: list[Any] | None = None) -> list[dict]:
    cur = con.execute(sql, params or [])
    cols = [d[0] for d in cur.description]
    return [dict(zip(cols, row)) for row in cur.fetchall()]


def _in_list(run_ids: list[str] | None) -> str | None:
    """Render run_ids as a safely-quoted SQL ``IN`` list, or None for no filter.

    Values come from our own catalog (run_ids), but are escaped regardless. Used to
    scope cross-run queries to the shown runs so the engine prunes scans.
    """
    if not run_ids:
        return None
    return "(" + ", ".join("'" + str(r).replace("'", "''") + "'" for r in run_ids) + ")"


def recent_run_ids(con: duckdb.DuckDBPyConnection, limit: int | None = None) -> list[str]:
    """The most-recent run_ids (newest-first). Cheap — used to scope the other queries."""
    limit_clause = f"LIMIT {int(limit)}" if limit else ""
    rows = con.execute(
        f"SELECT run_id FROM events GROUP BY run_id ORDER BY MAX(event_time) DESC {limit_clause}"
    ).fetchall()
    return [r[0] for r in rows]


def runs(
    con: duckdb.DuckDBPyConnection,
    limit: int | None = None,
    run_ids: list[str] | None = None,
) -> list[dict]:
    """One row per run: time range, event/kind counts, headline totals, invariant flag.

    Returned newest-first. ``run_ids`` scopes the scan to specific runs (the fast path —
    the engine prunes postings/events to those runs). ``limit`` keeps only the most recent
    N (used when no run_ids filter is given).
    """
    inl = _in_list(run_ids)
    ev_where = f"WHERE run_id IN {inl}" if inl else ""
    po_where = f"WHERE e.run_id IN {inl}" if inl else ""
    limit_clause = f"LIMIT {int(limit)}" if (limit and not inl) else ""
    rows = _rows(
        con,
        f"""
        WITH ev AS (
            SELECT
                run_id,
                CAST(MIN(event_time) AS VARCHAR) AS first_time,
                CAST(MAX(event_time) AS VARCHAR) AS last_time,
                COUNT(*)        AS event_count,
                COUNT(DISTINCT kind) AS kind_count,
                ANY_VALUE(project_id) AS project
            FROM events
            {ev_where}
            GROUP BY run_id
        ),
        po AS (
            SELECT
                e.run_id,
                p.account_type,
                p.unit,
                SUM(p.delta_numeric)                                   AS net,
                SUM(CASE WHEN p.delta_numeric > 0 THEN p.delta_numeric ELSE 0 END) AS flow
            FROM postings p
            JOIN events e ON p.event_id = e.event_id
            {po_where}
            GROUP BY e.run_id, p.account_type, p.unit
        )
        SELECT
            ev.run_id,
            ev.first_time,
            ev.last_time,
            ev.event_count,
            ev.kind_count,
            ev.project,
            COALESCE(SUM(CASE WHEN po.account_type IN {_COST_IN}    THEN po.flow END), 0) AS cost,
            COALESCE(SUM(CASE WHEN po.account_type IN {_LATENCY_IN} THEN po.flow END), 0) AS latency_ms,
            COALESCE(SUM(CASE WHEN po.account_type IN {_UTILITY_IN} THEN po.flow END), 0) AS utility,
            COALESCE(BOOL_AND(ABS(po.net) <= {_EPS}), TRUE) AS invariant_ok
        FROM ev
        LEFT JOIN po ON ev.run_id = po.run_id
        GROUP BY ev.run_id, ev.first_time, ev.last_time, ev.event_count, ev.kind_count, ev.project
        ORDER BY ev.first_time DESC
        {limit_clause}
        """,
    )
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


def kind_counts_by_run(con: duckdb.DuckDBPyConnection, run_ids: list[str] | None = None) -> list[dict]:
    """Per-run event-kind counts, for the dashboard's stacked bar chart."""
    inl = _in_list(run_ids)
    where = f"WHERE run_id IN {inl}" if inl else ""
    return _rows(
        con,
        f"""
        SELECT run_id, kind, COUNT(*) AS count
        FROM events
        {where}
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
    """``(account_type, unit)`` slices whose net deviates from zero — the drift check.

    Every slice must conserve (spec § 8), so no account type is exempt. Empty result ==
    healthy. Each row is a ``(account_type, unit, net)`` violation.
    """
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
            SUM(p.delta_numeric) AS net
        FROM postings p
        {join}
        {where}
        GROUP BY p.account_type, p.unit
        HAVING ABS(SUM(p.delta_numeric)) > {_EPS}
        ORDER BY p.account_type, p.unit
        """,
        params,
    )


def has_any_eval_results(con: duckdb.DuckDBPyConnection) -> bool:
    """True if the dataset contains any ``evaluation_result`` events (enables the matrix tab)."""
    return con.execute(
        "SELECT COUNT(*) FROM events WHERE kind = 'evaluation_result'"
    ).fetchone()[0] > 0


def eval_matrix(con: duckdb.DuckDBPyConnection, run_ids: list[str] | None = None) -> list[dict]:
    """Per (run_id, question_id) correctness from ``evaluation_result`` events.

    For the run × question progression/regression matrix. If a question is evaluated
    more than once in a run (retries), the latest event wins.
    """
    inl = _in_list(run_ids)
    run_filter = f"AND run_id IN {inl}" if inl else ""
    return _rows(
        con,
        f"""
        SELECT run_id, question_id, is_correct
        FROM (
            SELECT
                run_id,
                payload_json->>'question_id'        AS question_id,
                (payload_json->>'is_correct')::BOOLEAN AS is_correct,
                ROW_NUMBER() OVER (
                    PARTITION BY run_id, payload_json->>'question_id'
                    ORDER BY event_time DESC
                ) AS rn
            FROM events
            WHERE kind = 'evaluation_result'
            {run_filter}
        )
        WHERE rn = 1
        """,
    )


def latest_run_id(con: duckdb.DuckDBPyConnection) -> str | None:
    """Run with the most recent event, for ``--latest``."""
    row = con.execute(
        "SELECT run_id FROM events GROUP BY run_id ORDER BY MAX(event_time) DESC LIMIT 1"
    ).fetchone()
    return row[0] if row else None
