"""The SQL a Dive puts on the wire.

One board query becomes one statement: dbt-charts resolves ``{{ ref() }}`` and renders the
variables, and this module takes it from there — every table given its database (a Dive
attaches the databases it declares and defaults to none of them), and the columns a
JavaScript double cannot hold cast to text.

From dbt-charts' private surface: ``execute.adapters.dbt_adapter._read_target_dict`` and the
adapter's ``_dbt_refs`` (the profile target behind a ``dbt_profile`` source, and its ``ref()``
resolver).
"""

from __future__ import annotations

import datetime as _dt
import decimal
import json
import re
from dataclasses import dataclass
from typing import Any

# ─────────────────────────────────────────────────────────────────────────────
# values the browser can hold
# ─────────────────────────────────────────────────────────────────────────────
_JS_SAFE_INTEGER = 2**53 - 1


def column_casts(rows: list[dict[str, Any]]) -> dict[str, str]:
    """Per-column SQL rewrites so the browser receives plain JSON-friendly values.

    Dates and timestamps are formatted in SQL (the Dive guide's recommendation) exactly the
    way dbt-charts inlines them (ISO 8601). Numbers a JavaScript double cannot hold — every
    DECIMAL, and an integer past 2^53 — come across as their own digits instead: dbt-charts
    formats a Python Decimal or int, so widening one to a double here is the difference
    between an order id and its neighbour, or between cents and nearly cents.
    """
    casts: dict[str, str] = {}
    if not rows:
        return casts
    for col in rows[0]:
        sample = next((r[col] for r in rows if r.get(col) is not None), None)
        q = '"' + col.replace('"', '""') + '"'
        if isinstance(sample, _dt.datetime):
            casts[col] = f"strftime({q}, '%Y-%m-%dT%H:%M:%S') AS {q}"
        elif isinstance(sample, _dt.date):
            casts[col] = f"strftime({q}, '%Y-%m-%d') AS {q}"
        elif isinstance(sample, decimal.Decimal) or (isinstance(sample, int) and not isinstance(sample, bool) and abs(sample) > _JS_SAFE_INTEGER):
            casts[col] = f"CAST({q} AS VARCHAR) AS {q}"
    return casts


def wrap_sql(sql: str, casts: dict[str, str]) -> str:
    sql = sql.strip().rstrip(";").strip()
    if not casts:
        return sql
    return "SELECT * REPLACE (" + ", ".join(casts.values()) + ")\nFROM (\n" + sql + "\n) AS __dcd"


@dataclass
# ─────────────────────────────────────────────────────────────────────────────
# one board query, rendered
# ─────────────────────────────────────────────────────────────────────────────
class QueryTemplate:
    """A board query with ``{{ queries.X }}`` composed and ``{{ ref() }}`` resolved:
    the Jinja dbt-charts renders per request, plus how to render it."""

    sql: str
    relations: list[Any]
    source_db: str | None
    warehouse: Any
    strict: bool


def query_template(session: Any, board: Any, query: Any, qname: str) -> QueryTemplate:
    from dbt_charts.core.dialects import get_dialect
    from dbt_charts.core.execute.adapters.dbt_utils import DbtRefResolver
    from dbt_charts.core.execute.executor import resolve_query_references

    composed = resolve_query_references(query, all_queries=dict(board.queries), query_name=qname)
    registry = session.adapter_registry
    source = registry.resolve_query_source(composed, board=board, query_name=qname)
    dialect_name = getattr(source, "type", None) or "duckdb"
    adapter = registry.get_adapter(composed, source)
    refs = getattr(adapter, "_dbt_refs", None) or DbtRefResolver(session.project)
    sql, relations = refs.resolve(composed.sql)
    return QueryTemplate(sql, list(relations or []), _source_database(adapter, source), get_dialect(dialect_name), not getattr(composed, "lenient_variables", False))


def render_sql(tmpl: QueryTemplate, variables: Any) -> str:
    """The literal SQL dbt-charts executes for ``variables``: every variable and filter
    value bound as a parameter (``adapter_registry._compose_query_refs``), then flattened
    to a literal the way the dbt adapter does, since dbt's execute() takes no bindings."""
    from dbt_charts.core.compile.template.parameterized import render_parameterized
    from dbt_charts.core.execute.sql_literals import INLINE_PLACEHOLDERS, inline_params_for_dialect

    q = render_parameterized(tmpl.sql, variables, dialect=INLINE_PLACEHOLDERS, strict=tmpl.strict, warehouse=tmpl.warehouse)
    if not q.params:
        return q.sql
    return inline_params_for_dialect(q.sql, list(q.params), INLINE_PLACEHOLDERS, escaping=tmpl.warehouse)


def _source_database(adapter: Any, source: Any) -> str | None:
    """The MotherDuck database (``md:<db>``) a query's source connects to, or None.

    A ``dbt_profile`` source is expanded to its target's connection dict; a named
    ``duckdb`` source carries its own ``path``. Anything that is not an ``md:`` path
    (a local file, another warehouse) has no database the Dive could declare.
    """
    path = getattr(source, "path", None)
    if not isinstance(path, str) and hasattr(adapter, "dbt_project_path"):
        try:
            from dbt_charts.core.execute.adapters.dbt_adapter import _read_target_dict

            adapter._get_dbt_adapter()  # resolves profile_name from dbt_project.yml
            path = _read_target_dict(adapter.dbt_project_path, adapter.profile_name, adapter.target_name, render=True).get("path")
        except Exception:  # noqa: BLE001 — no dbt profile to read: no database to declare
            return None
    if not isinstance(path, str):
        return None
    idx = path.find("md:")
    if idx < 0 or (idx > 0 and path[idx - 1] not in "/\\"):
        return None
    db = path[idx + 3 :].split("?", 1)[0].strip()
    return db or None


# ─────────────────────────────────────────────────────────────────────────────
# every table, with its database
# ─────────────────────────────────────────────────────────────────────────────
def qualify_tables(sql: str, database: str) -> tuple[str, set[str]]:
    """Give every table reference a database, and name the databases the SQL then reads.

    dbt-charts runs a board's SQL on the source's own connection, where the target database
    is the default catalog, so ``FROM main.orders`` resolves. The Dive runs the same SQL on
    the reader's MotherDuck connection, where only the databases in REQUIRED_DATABASES are
    attached and none of them is the default — a table named without one resolves nowhere.
    So one pass over DuckDB's own parse tree (``json_serialize_sql`` /
    ``json_deserialize_sql``) fills in the missing catalog and collects every catalog the
    query ends up naming, the ones ``{{ ref() }}`` already wrote included. CTE names are left
    alone. A statement the parser cannot round-trip keeps its text, and its databases are
    read off the three-part names in it.
    """
    import duckdb

    try:
        con = duckdb.connect()
        ast = json.loads(con.execute("SELECT json_serialize_sql(?::VARCHAR)", [sql]).fetchone()[0])
        if ast.get("error") or len(ast.get("statements") or []) != 1:
            return sql, _relation_databases(sql)
        ctes: set[str] = set()

        def collect_ctes(node: Any) -> None:
            if isinstance(node, dict):
                for entry in (node.get("cte_map") or {}).get("map") or []:
                    ctes.add(entry.get("key"))
                for v in node.values():
                    collect_ctes(v)
            elif isinstance(node, list):
                for x in node:
                    collect_ctes(x)

        databases: set[str] = set()
        changed = False

        def qualify(node: Any) -> None:
            nonlocal changed
            if isinstance(node, dict):
                if node.get("type") == "BASE_TABLE" and node.get("table_name") not in ctes:
                    if not node.get("catalog_name") and database:
                        node["catalog_name"] = database
                        changed = True
                    if node.get("catalog_name"):
                        databases.add(node["catalog_name"])
                for v in node.values():
                    qualify(v)
            elif isinstance(node, list):
                for x in node:
                    qualify(x)

        collect_ctes(ast)
        qualify(ast)
        if not changed:
            return sql, databases
        return con.execute("SELECT json_deserialize_sql(?::JSON)", [json.dumps(ast)]).fetchone()[0], databases
    except Exception:  # noqa: BLE001 — leave the SQL exactly as dbt-charts wrote it
        return sql, _relation_databases(sql)


_QUALIFIED_NAME = re.compile(r'"([^"]+)"\s*\.\s*"[^"]+"\s*\.\s*"[^"]+"')


def _relation_databases(sql: str) -> set[str]:
    """Database names of every fully qualified ``"db"."schema"."table"`` in the SQL — the
    answer for a statement DuckDB's parser will not round-trip, where dbt-charts' own
    ``{{ ref() }}`` spelling is all there is to go on."""
    return {m.group(1) for m in _QUALIFIED_NAME.finditer(sql)}
