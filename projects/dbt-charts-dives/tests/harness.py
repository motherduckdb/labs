"""Shared plumbing for the end-to-end suite: board -> Dive -> live SQL -> DOM, and the
dbt-charts oracles (its JSON/SVG/PNG renders of the same board) everything is compared to.

Every expensive step is cached for the pytest session, keyed by board path.
"""

from __future__ import annotations

import datetime as dt
import decimal
import json
import math
import os
import re
import shutil
import subprocess
import xml.etree.ElementTree as ET
from functools import cache
from pathlib import Path
from typing import Any

import duckdb
# What the Dive itself resolves with; a test reaches these through `H.` too.
from dbt_charts_dive.variables import dim_key, sql_literal, variant_sql  # noqa: F401

HERE = Path(__file__).resolve().parent
FIXTURES_DIR = HERE / "fixtures"
FIXTURE_REL = "charts/e2e_fixtures"  # where fixtures are copied inside the dbt project
FRAMED_REL = FIXTURE_REL + "/w880"  # copies of boards pinned to the Dive width for dct renders
DIVE_WIDTH = 880
SVG_NS = "{http://www.w3.org/2000/svg}"

# The 12 example boards of dbt Charts' own `examples/tutorial_dbt` (partials under charts/partials/_*.yml are
# not boards). Grouped by what they exercise so tests can parametrize on the right subset.
BOARDS = [
    "charts/customer_analytics.yml",
    "charts/sales_dashboard.yml",
    "charts/product_performance.yml",
    "charts/general/analytics-dashboard.yml",
    "charts/general/executive_summary.yml",
    "charts/general/kpi-dashboard.yml",
    "charts/general/marketing_dashboard.yml",
    "charts/general/sales_dashboard.yml",
    "charts/dashboards/themed-dashboard.yml",
    "charts/variables/analytics-dashboard.yml",
    "charts/variables/celebration.yml",
    "charts/variables/drill-down.yml",
]
# ``daily_trend`` has ``color: None`` — the string, because YAML does not know that spelling
# of a null — which dbt-charts looks up as a column and fails on at board level. The Dive
# reads it as the unset channel instead (``builder._read_spelled_nulls_as_unset``), so these
# two boards render in a Dive and cannot be compared against a dbt-charts render.
DCT_FAILING_BOARDS = {
    "charts/general/analytics-dashboard.yml",
    "charts/variables/analytics-dashboard.yml",
    FIXTURE_REL + "/spelled_nulls.yml",  # the same spelled null, one per spelling
    FIXTURE_REL + "/bad_channel.yml",    # a column that is genuinely not there
}
FIXTURE_BOARDS = {p.name: f"{FIXTURE_REL}/{p.name}" for p in sorted(FIXTURES_DIR.glob("*.yml")) if not p.name.startswith("_")}


def project_dir() -> Path:
    return Path(os.environ["DCD_PROJECT_DIR"]).resolve()


def _dbt_charts_dive():
    import dbt_charts_dive.builder as builder  # applies the MotherDuck compat shim on import

    return builder


# ── values ─────────────────────────────────────────────────────────────────────
def jsonable(v: Any) -> Any:
    if isinstance(v, decimal.Decimal):
        return float(v)
    if isinstance(v, (dt.date, dt.datetime)):
        return v.isoformat()
    return v


def normalize(v: Any) -> Any:
    """One comparable shape for a value from the Dive's SQL, dct's JSON, or a snapshot."""
    v = jsonable(v)
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        return round(float(v), 6)
    if isinstance(v, str):
        if re.fullmatch(r"-?\d+(\.\d+)?", v):
            return round(float(v), 6)  # dct's JSON keeps DECIMAL as an exact string
        # Timestamps at midnight and dates are the same instant to a reader.
        return re.sub(r"T00:00:00(\.0+)?$", "", v)
    return v


def normalize_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [{k: normalize(v) for k, v in r.items()} for r in rows]


def as_multiset(rows: list[dict[str, Any]]) -> list[str]:
    return sorted(json.dumps(r, sort_keys=True, default=str) for r in rows)


def has_order_ties(rows: list[dict[str, Any]], sql: str) -> bool:
    """True when the SQL has no ORDER BY, or its ORDER BY leaves rows the engine may
    order either way (equal sort keys), so two executions can legitimately differ."""
    m = re.search(r"ORDER\s+BY\s+(.+?)(?:\s+LIMIT\b|\s*\)\s*AS\s+__dcd|$)", sql, re.I | re.S)
    if not m:
        return True
    keys: list[str] = []
    cols = list(rows[0].keys()) if rows else []
    for part in m.group(1).split(","):
        tok = part.strip().split()[0].strip('"')
        if tok.isdigit():
            keys.append(cols[int(tok) - 1])
        elif tok in cols:
            keys.append(tok)
        else:
            return True  # an expression we cannot evaluate here: assume ties are possible
    seen = {tuple(json.dumps(r.get(k), default=str) for k in keys) for r in rows}
    return len(seen) < len(rows)


# ── compile + live SQL ─────────────────────────────────────────────────────────
@cache
def build(*boards: str):
    """Compile boards into a Dive exactly as the dbt hook does (cached per board set)."""
    return _dbt_charts_dive().build_dive_from_boards(project_dir(), list(boards))


@cache
def _con() -> duckdb.DuckDBPyConnection:
    # A bare MotherDuck connection: the same situation the Dive's reader is in — the
    # databases the Dive declares are attached, none of them is the default catalog.
    return duckdb.connect("md:")


def fetch_rows(sql: str) -> list[dict[str, Any]]:
    cur = _con().execute(sql)
    cols = [d[0] for d in cur.description]
    return [{c: jsonable(v) for c, v in zip(cols, row)} for row in cur.fetchall()]


@cache
def live_rows(*boards: str) -> dict[str, list[dict[str, Any]]]:
    """Every manifest query executed on MotherDuck, keyed by the SQL text (what the mock hook sees)."""
    manifest = build(*boards).manifest
    return {sql: fetch_rows(sql) for sql in manifest["queries"].values()}


def rows_for_chart(manifest: dict[str, Any], rows_by_sql: dict[str, list[dict[str, Any]]], chart: dict[str, Any]) -> list[dict[str, Any]]:
    if chart.get("query"):
        return rows_by_sql[manifest["queries"][chart["query"]]]
    return chart.get("snapshot") or []


# ── the Dive in jsdom / Chromium ───────────────────────────────────────────────
def slug(board: str) -> str:
    """``charts/general/sales_dashboard.yml`` -> ``general__sales_dashboard`` (stems collide)."""
    rel = board[len("charts/") :] if board.startswith("charts/") else board
    return rel.removesuffix(".yml").replace("/", "__")


def _write_build(boards: tuple[str, ...], extra_sql: tuple[str, ...] = ()) -> tuple[Path, Path]:
    """Write the Dive and its rows file: every default query plus ``extra_sql`` (the texts a
    test expects a control change to produce, so the mock SQL hook can answer them)."""
    b = build(*boards)
    out = HERE / "build"
    out.mkdir(exist_ok=True)
    stem = "+".join(slug(x) for x in boards)
    dive = out / f"{stem}.tsx"
    rows = out / f"{stem}.rows.json"
    dive.write_text(b.content, encoding="utf-8")
    all_rows = dict(live_rows(*boards))
    for sql in extra_sql:
        if sql not in all_rows:
            all_rows[sql] = fetch_rows(sql)
    rows.write_text(json.dumps(all_rows), encoding="utf-8")
    return dive, rows


def _node(*args: str, timeout: int = 180) -> dict[str, Any]:
    proc = subprocess.run(["node", *args], capture_output=True, text=True, cwd=HERE, timeout=timeout)
    if proc.returncode != 0:
        raise RuntimeError(f"node {args[0]} failed:\n{proc.stderr[-3000:]}")
    return json.loads(proc.stdout)


@cache
def dom(*boards: str, options: str = "") -> dict[str, Any]:
    """Render the Dive in jsdom with the live rows; returns run_dive.mjs' report.

    ``options`` is a JSON string (e.g. ``{"clickTab": 1}``); the report has ``initial``
    and, after a click, ``after_click``.
    """
    dive, rows = _write_build(boards)
    args = [str(HERE / "run_dive.mjs"), str(dive), str(rows)]
    if options:
        args.append(options)
    return _node(*args)


def dom_with_rows(board: str, change: Any) -> dict[str, Any]:
    """The Dive in jsdom against rows the query did not return at compile time.

    ``change`` takes the rows of one query and returns the rows to answer with, so a test
    can ask what the card does when the data moves — the whole point of a live Dive.
    """
    dive, rows_file = _write_build((board,))
    rows = json.loads(rows_file.read_text())
    rows_file.write_text(json.dumps({sql: change(rs) for sql, rs in rows.items()}), encoding="utf-8")
    try:
        return _node(str(HERE / "run_dive.mjs"), str(dive), str(rows_file))
    finally:
        rows_file.write_text(json.dumps(rows), encoding="utf-8")


@cache
def browser(*boards: str, width: int = DIVE_WIDTH, actions: str = "", extra_sql: tuple[str, ...] = ()) -> tuple[dict[str, Any], Path]:
    """Render the Dive in headless Chromium with the real Vega bundle; (report, screenshot).

    ``actions`` is a JSON list of interactions (see run_dive_browser.mjs); the report then
    carries one snapshot per action in ``steps``. ``extra_sql`` pre-fetches rows for SQL the
    actions are expected to produce.
    """
    dive, rows = _write_build(boards, extra_sql)
    manifest = build(*boards).manifest
    expect = sum(1 for c in manifest["charts"].values() if c["kind"] == "vega" and c["id"] in chart_order(manifest))
    png = HERE / "build" / f"{dive.stem}.dive.png"
    opts: dict[str, Any] = {"width": width, "expectVega": expect}
    if actions:
        opts["actions"] = json.loads(actions)
    report = _node(str(HERE / "run_dive_browser.mjs"), str(dive), str(rows), str(png), json.dumps(opts), timeout=300)
    (HERE / "build" / f"{dive.stem}.browser.json").write_text(json.dumps(report, indent=1), encoding="utf-8")
    return report, png


# ── dbt-charts' own renders of the same board ──────────────────────────────────
def _session():
    from dbt_charts.agent_api import ProjectSession

    return ProjectSession.open(project_dir())


def _board_file(session, board: str):
    from dbt_charts.agent_api import Diagnostic
    from dbt_charts.agent_api._paths import resolve_board_or_error

    bf = resolve_board_or_error(Path(board), session.project)
    if isinstance(bf, Diagnostic):
        raise RuntimeError(f"{board}: {bf}")
    return bf


@cache
def dct(board: str, fmt: str = "json", variables: str = ""):
    """``ProjectSession.render_board`` for ``board`` — dbt-charts' resolved semantics + rows
    (json), or its own SVG/PNG export. ``variables`` is a JSON object of overrides (what a
    dct URL param / ``--var`` would set). Returns the BoardRenderResult."""
    _dbt_charts_dive()  # md: compat must be applied before dct opens the profile
    with _session() as s:
        return s.render_board(_board_file(s, board), format=fmt, use_cache=False, variables=json.loads(variables) if variables else None)


def dct_json(board: str, variables: str = "") -> dict[str, Any]:
    r = dct(board, "json", variables)
    assert r.status == "ok", f"dct could not render {board}: {r.board_error or r.validation_errors or r.chart_errors}"
    return r.data if isinstance(r.data, dict) else json.loads(r.data)


def dct_chart_items(board: str, variables: str = "") -> dict[str, dict[str, Any]]:
    """dct JSON chart items by chart id, in layout order: {id: {"chart": resolved, "data": rows}}."""
    out: dict[str, dict[str, Any]] = {}

    def walk(n: Any) -> None:
        if isinstance(n, dict):
            if n.get("type") == "chart":
                cid = n.get("id") or n["chart"]["id"]
                out[cid] = n
                return
            for v in n.values():
                walk(v)
        elif isinstance(n, list):
            for x in n:
                walk(x)

    walk(dct_json(board, variables))
    return out


def framed(board: str, width: int = DIVE_WIDTH) -> str:
    """A copy of ``board`` pinned to ``width`` (``style.frame.width``) so dct's sizing pass
    lays out for the Dive viewport. Returns its project-relative path."""
    src = project_dir() / board
    text = src.read_text(encoding="utf-8")
    assert not re.search(r"^style:", text, re.M), f"{board} has a top-level style: block; merge frame.width by hand"
    dst = project_dir() / FRAMED_REL / (slug(board) + ".yml")
    dst.parent.mkdir(parents=True, exist_ok=True)
    for partial in src.parent.glob("_*.yml"):  # `extends:` is relative to the board file
        shutil.copy(partial, dst.parent / partial.name)
    dst.write_text(f"style:\n  frame:\n    width: {width}\n" + text, encoding="utf-8")
    return str(dst.relative_to(project_dir()))


@cache
def dct_svg(board: str, width: int = DIVE_WIDTH) -> str:
    r = dct(framed(board, width), "svg")
    assert r.status == "ok", f"dct could not render {board} as svg: {r.board_error or r.chart_errors}"
    return r.data if isinstance(r.data, str) else r.data.decode()


@cache
def dct_png(board: str, width: int = DIVE_WIDTH) -> Path:
    r = dct(framed(board, width), "png")
    assert r.status == "ok", f"dct could not render {board} as png: {r.board_error or r.chart_errors}"
    out = HERE / "build" / f"{slug(board)}.dct.png"
    out.write_bytes(r.data)
    return out


def svg_groups(svg: str) -> dict[str, dict[str, Any]]:
    """Per chart of a dct SVG: its size and every ``<text>`` it draws, in document order."""
    root = ET.fromstring(svg)
    out: dict[str, dict[str, Any]] = {}
    for g in root.iter():
        cid = g.get("data-chart-id")
        if cid is None:
            continue
        # dct pads number lanes with figure / zero-width spaces (decimal alignment); they are
        # geometry, not text.
        texts = [re.sub("[\u2007\u200b\u00a0]", "", "".join(t.itertext())).strip() for t in g.iter(SVG_NS + "text")]
        out[cid] = {
            "width": float(g.get("data-chart-width")),
            "height": float(g.get("data-chart-height")),
            "title": g.get("data-chart-title") or "",
            "texts": [t for t in texts if t],
            "vega_svgs": sum(1 for e in g.iter(SVG_NS + "svg") if (e.get("class") or "") == "marks"),
        }
    return out


def css_color(value: str) -> tuple[int, int, int] | str:
    """``#F7F8FA`` and jsdom's ``rgb(247, 248, 250)`` as one comparable value."""
    v = (value or "").strip().lower()
    if re.fullmatch(r"#[0-9a-f]{6}", v):
        return tuple(int(v[i : i + 2], 16) for i in (1, 3, 5))
    m = re.fullmatch(r"rgb\((\d+),\s*(\d+),\s*(\d+)\)", v)
    if m:
        return tuple(int(x) for x in m.groups())
    return v


def dct_chart_boxes(svg: str) -> dict[str, tuple[float, float, float, float]]:
    """Each chart's (x, y, width, height) in dct's SVG page coordinates: the
    ``translate()`` chain above the ``data-chart-id`` group plus its declared size."""
    root = ET.fromstring(svg)
    parent = {c: p for p in root.iter() for c in p}
    out: dict[str, tuple[float, float, float, float]] = {}
    for g in root.iter():
        cid = g.get("data-chart-id")
        if cid is None:
            continue
        x = y = 0.0
        e: Any = g
        while e is not None:
            m = re.match(r"translate\(\s*([-\d.]+)\s*[, ]\s*([-\d.]+)\s*\)", e.get("transform") or "")
            if m:
                x += float(m.group(1))
                y += float(m.group(2))
            x += float(e.get("x") or 0) if e.tag == SVG_NS + "svg" and e is not root else 0
            y += float(e.get("y") or 0) if e.tag == SVG_NS + "svg" and e is not root else 0
            e = parent.get(e)
        out[cid] = (x, y, float(g.get("data-chart-width")), float(g.get("data-chart-height")))
    return out


def svg_root_size(svg: str) -> tuple[float, float]:
    root = ET.fromstring(svg)
    return float(root.get("width")), float(root.get("height"))


# ── layout walk ────────────────────────────────────────────────────────────────
def chart_order(manifest: dict[str, Any], tab: int | None = None, values: dict[str, Any] | None = None) -> list[str]:
    """Chart ids in the order the Dive lays them out: only the active tab of a tabs node
    (its ``default`` unless ``tab`` is given), only items whose ``visible`` condition holds
    at ``values`` (the control defaults unless given), collapsed ``details`` content too
    (the section is drawn but its charts are not)."""
    order: list[str] = []
    vals = {**control_defaults(manifest), **(values or {})}

    def layout(node: dict[str, Any]) -> None:
        items = node["items"]
        if node["type"] == "tabs":
            items = [items[min(tab if tab is not None else node.get("default", 0), len(items) - 1)]]
        for it in items:
            if it is None or not cond_value(it.get("visible"), vals):
                continue
            if "chart" in it:
                order.append(it["chart"])
            elif it.get("details") and not it["details"]["expanded"]:
                continue
            else:
                board(it["board"])

    def board(node: dict[str, Any]) -> None:
        layout(node["layout"])

    board(manifest["board"])
    return order


def expected_dom_kinds(manifest: dict[str, Any]) -> list[str]:
    """What run_dive.mjs should report, in order, ignoring dct's SVG (titles, prose, callouts)."""
    kinds: list[str] = []
    for cid in chart_order(manifest):
        c = manifest["charts"][cid]
        if c["kind"] == "vega":
            kinds.append("vega")
            if c.get("legend"):
                kinds.append("legend")
        elif c["kind"] == "unsupported":
            kinds.append("error")
        elif c["kind"] in ("kpi", "table", "spark_bar"):
            kinds.append(c["kind"])
    return kinds


def cols_nodes(node: dict[str, Any]) -> list[dict[str, Any]]:
    """Every CSS-grid band (``cols`` node) in a board tree."""
    out: list[dict[str, Any]] = []

    def layout(n: dict[str, Any]) -> None:
        if n["type"] == "cols":
            out.append(n)
        for it in n["items"]:
            if it and "board" in it:
                layout(it["board"]["layout"])

    layout(node["layout"])
    return out


# ── the Dive's variable machinery: the same resolution template.tsx does, from the
# package itself (``variables.py``), so a test can predict the SQL a control produces ──
def all_controls(node: dict[str, Any]) -> list[dict[str, Any]]:
    out = list(node.get("variables") or [])
    for it in node["layout"]["items"]:
        if it and "board" in it:
            out += all_controls(it["board"])
    return out


def control_defaults(manifest: dict[str, Any]) -> dict[str, Any]:
    return {c["key"]: c["default"] for c in all_controls(manifest["board"])}


def cond_value(cond: Any, values: dict[str, Any]) -> bool:
    """template.tsx ``condValue``: a pre-evaluated ``enabled``/``visible`` condition at ``values``."""
    if cond is None:
        return True
    if isinstance(cond, bool):
        return cond
    key = "|".join(dim_key(d, values.get(d["key"])) for d in cond["dims"])
    return cond["table"].get(key, cond["default"])


def dive_sql(manifest: dict[str, Any], qname: str, values: dict[str, Any] | None = None) -> str:
    """template.tsx ``sqlFor``: the SQL the Dive runs for ``qname`` at ``values``."""
    vals = {**control_defaults(manifest), **(values or {})}
    return variant_sql(manifest["query_variables"].get(qname), manifest["queries"][qname], vals)


def rule_matches(rule: dict[str, Any], value: Any) -> bool:
    """template.tsx ``ruleMatches``: dct's ``match_predicate`` for one serialized rule."""
    if rule.get("default"):
        return True
    if rule.get("is_null") is not None:
        return (value is None) == rule["is_null"]
    if rule.get("eq") is not None:
        return isinstance(value, bool) == isinstance(rule["eq"], bool) and value == rule["eq"]
    if rule.get("ne") is not None:
        return isinstance(value, bool) != isinstance(rule["ne"], bool) or value != rule["ne"]
    if rule.get("in") is not None:  # the manifest spells it `in`, as the browser reads it
        return any(str(candidate) == str(value) for candidate in rule["in"])
    try:
        v = float(value)  # dct coerces the cell; a non-number matches no comparison
    except (TypeError, ValueError):
        return False
    if rule.get("lt") is not None:
        return v < float(rule["lt"])
    if rule.get("lte") is not None:
        return v <= float(rule["lte"])
    if rule.get("gt") is not None:
        return v > float(rule["gt"])
    if rule.get("gte") is not None:
        return v >= float(rule["gte"])
    if rule.get("between") is not None:
        low, high = rule["between"]
        return float(low) <= v <= float(high)
    return False


def kpi_case(kpi: dict[str, Any], row: dict[str, Any]) -> str:
    """template.tsx ``kpiCase``: which of a KPI's precompiled colour sets a row selects."""
    hits = []
    for channel in kpi["channels"]:
        value = row.get(channel["field"])
        hit = "base"
        for i, rule in enumerate(channel["rules"]):
            if rule_matches(rule, value):
                hit = str(i)
        hits.append(hit)
    return "|".join(hits)


def rows_shown(n: int, pagination: dict[str, Any] | None) -> int:
    """dct's ``_resolve_visible_rows``: rows on the first page — every row when the total
    exceeds ``page_rows`` by at most the grow cap, else ``page_rows``."""
    if not pagination:
        return n
    return n if n <= pagination["page_rows"] + pagination["grow_cap"] else min(n, pagination["page_rows"])


# ── dct's formatting functions, called the way its KPI / table renderers call them ──
def format_config(fmt: Any):
    from dbt_charts.core.compile.models.primitives import FormatConfig

    if fmt is None or isinstance(fmt, (str, FormatConfig)):
        return fmt
    return FormatConfig(**fmt)


def dct_kpi_text(value: Any, fmt: Any, native: bool = False, formats: dict[str, str] | None = None) -> str:
    """What dct prints as a KPI headline (``format_kpi_parts`` joined, as the SVG reads)."""
    from dbt_charts.core.render.chart.kpi import coerce_numeric_cell
    from dbt_charts.core.render.format_utils import format_kpi_parts

    numeric = coerce_numeric_cell(value)
    if numeric is None:
        return "" if value is None else str(value)
    return "".join(format_kpi_parts(numeric, format_config(fmt), formats, native=native))


def dct_table_cell(value: Any, fmt: Any, row_idx: int, symbol_mode: str = "anchors", formats: dict[str, str] | None = None) -> str:
    """What dct paints in a table cell (``table.py``'s numeric three-lane path or
    ``format_table_cell_value``), including ``symbol_mode: anchors`` on non-first rows."""
    from dbt_charts.core.render.chart.table_support import format_table_cell_value
    from dbt_charts.core.render.format_utils import MAGNITUDE_SUFFIXES, format_kpi_parts

    fmt = format_config(fmt)
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        prefix, number, suffix = format_kpi_parts(value, fmt, formats, default_number=True)
        if symbol_mode == "anchors" and row_idx != 0:
            prefix = ""
            if not any(suffix.startswith(m) for m in MAGNITUDE_SUFFIXES):
                suffix = ""
        return f"{prefix}{number}{suffix}"
    return format_table_cell_value(value, fmt, formats)


# ── pie arcs ───────────────────────────────────────────────────────────────────
def arc_angles(d: str) -> tuple[int, int, int]:
    """(start°, end°, large-arc flag) of the outer arc of one pie-slice path.

    Vega's arc mark draws ``M … A r,r 0 large sweep x,y … L0,0 Z`` (plus tiny corner
    arcs); the outer arc is the one with the largest radius. Angles are what the live
    window/joinaggregate transforms determine; the radius depends on the fitted plot size
    (text measurement differs between vl-convert and Chromium), so it is not compared.
    """

    tokens = re.findall(r"[MLAZ]|-?\d+(?:\.\d+)?(?:e-?\d+)?", d)
    i, cur, best = 0, (0.0, 0.0), None
    while i < len(tokens):
        cmd = tokens[i]
        i += 1
        if cmd in ("M", "L"):
            cur = (float(tokens[i]), float(tokens[i + 1]))
            i += 2
        elif cmd == "A":
            r = float(tokens[i])
            large = int(float(tokens[i + 3]))
            end = (float(tokens[i + 5]), float(tokens[i + 6]))
            if best is None or r > best[0]:
                best = (r, cur, end, large)
            cur = end
            i += 7
        elif cmd == "Z":
            pass
    assert best is not None, d
    _, start, end, large = best
    deg = lambda p: round(math.degrees(math.atan2(p[1], p[0]))) % 360  # noqa: E731
    return deg(start), deg(end), large
