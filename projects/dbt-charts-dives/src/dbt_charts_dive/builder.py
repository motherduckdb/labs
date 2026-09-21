"""Compile dbt Charts boards into a MotherDuck Dive.

Everything dbt-charts decides about a board is decided here, at compile time, with
dbt-charts' own code, and handed to ``template.tsx`` as data:

  board YAML ──compile_file──▶ Board ──build_resolved_board──▶ sized layout + resolved charts
      vega family (bar/line/area/scatter/pie/heatmap/maps…) ──▶ Vega-Lite spec (``specs``)
      kpi, table ──▶ dct's own resolved geometry, colours and format plans (``presentation``)
      callout, board titles, prose ──▶ dct-rendered SVG, embedded verbatim
      fonts ──▶ the @font-face set dct would embed in an offline export

plus, per board query, the exact SQL dbt-charts would put on the wire (``sql``) so the Dive
queries live, and — for queries that read a variable — one SQL per value combination the
controls can reach (``variables``), so the Dive re-runs them without Jinja. dbt Charts'
other interactions ship as data too: the resolved controls of the variables strip, tabs
(active tab = a Dive state key), ``details:`` sections, ``visible:``/``enabled`` conditions
pre-evaluated per combination, ``link:`` templates, table pagination, and the theme's
tooltip style (the tooltip content is the ``description`` expression dct already puts on
every mark).

The result is a single ``.tsx`` file: ``template.tsx`` with the manifest, the
``REQUIRED_DATABASES`` and the gzip+base64 Vega bundle spliced in. The template holds no
chart-styling decisions of its own; it lays out what the manifest says and formats live
values with the plans the modules below compile.

This module is the assembly: open a board, compile its queries, walk dct's resolved layout,
and write the manifest. What each piece of it looks like belongs to its own module —
``sql`` (the statement a Dive sends), ``presentation`` (what a card looks like), ``specs``
(the Vega-Lite a Dive renders), ``variables`` (what a control does) — and each of those
names the dbt-charts private surface it leans on.

From that surface, here: ``agent_api._paths.resolve_board_or_error`` (board path ->
``BoardFile``), ``render.boards._render_title_svg`` / ``_render_text_svg`` and
``render.chart.vega_lite._render_vl_artifact`` (dct's own SVG and spec emitters), and
``execute.chart_resolution.resolve_chart_with_runtime_inputs``, monkey-patched for the
duration of one compile by ``_tolerant_resolution``. ``md_compat.py`` patches four more
(see its docstring).
"""

from __future__ import annotations

import dataclasses
import datetime as _dt
import decimal
import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import dbt_charts_dive.presentation as P
import dbt_charts_dive.specs as SPEC
import dbt_charts_dive.sql as S
import dbt_charts_dive.variables as V  # importing the package applies md_compat

_HERE = Path(__file__).resolve().parent
TEMPLATE_PATH = _HERE / "template.tsx"

DEFAULT_DIVE_WIDTH = 880  # px of usable width in the Dive viewport


@dataclass
class DiveBuild:
    title: str
    description: str
    content: str
    required_resources: list[dict[str, str]]
    refs: list[str]  # the dbt models the boards resolved, however they named them
    manifest: dict[str, Any] = field(repr=False)


# ─────────────────────────────────────────────────────────────────────────────
# helpers
# ─────────────────────────────────────────────────────────────────────────────
def _jsonable(v: Any) -> Any:
    if isinstance(v, decimal.Decimal):
        return float(v)
    if isinstance(v, (_dt.datetime, _dt.date, _dt.time)):
        return v.isoformat()
    if isinstance(v, (set, frozenset, tuple)):
        return [_jsonable(x) for x in v]
    if hasattr(v, "model_dump"):
        return _jsonable(v.model_dump(mode="json", exclude_none=True))
    if dataclasses.is_dataclass(v) and not isinstance(v, type):
        return _jsonable(dataclasses.asdict(v))
    if isinstance(v, dict):
        return {str(k): _jsonable(x) for k, x in v.items()}
    if isinstance(v, list):
        return [_jsonable(x) for x in v]
    return v


# ─────────────────────────────────────────────────────────────────────────────
# board compilation
# ─────────────────────────────────────────────────────────────────────────────
class _tolerant_resolution:
    """Make dct's sizing pass survive a chart that raises a non-dct exception.

    Its two resolve call sites catch ``DbtChartsError`` and record the chart as a
    resolve failure (rendered as an error placard); anything else takes the whole
    board down. ``render_chart_item`` already wraps such exceptions as
    ``ERR_INTERNAL`` at render time — do the same at resolve time, for the duration
    of one compile, so one bad chart becomes one error card instead of no Dive.
    """

    def __enter__(self) -> None:
        from dbt_charts.core.diagnostics import ERR_INTERNAL
        from dbt_charts.core.diagnostics.base import DbtChartsError
        from dbt_charts.core.execute.chart_resolution import resolve_chart_with_runtime_inputs as original
        from dbt_charts.core.render import board_resolve, layout_sizing
        from dbt_charts.core.render.errors import RenderError

        def wrapped(*args: Any, **kwargs: Any) -> Any:
            try:
                return original(*args, **kwargs)
            except DbtChartsError:
                raise
            except Exception as e:  # noqa: BLE001 — becomes dct's own internal-error placard
                raise RenderError.from_code(ERR_INTERNAL, message=f"{type(e).__name__}: {e}") from e

        self._modules = (board_resolve, layout_sizing)
        for m in self._modules:
            m.resolve_chart_with_runtime_inputs = wrapped  # type: ignore[attr-defined]
        self._original = original

    def __exit__(self, *exc: Any) -> None:
        for m in self._modules:
            m.resolve_chart_with_runtime_inputs = self._original  # type: ignore[attr-defined]


# ─────────────────────────────────────────────────────────────────────────────
# one board
# ─────────────────────────────────────────────────────────────────────────────
def compile_board(project_dir: Path, board_rel: str, *, dive_width: int = DEFAULT_DIVE_WIDTH, prefix: str = "") -> dict[str, Any]:
    """Compile one board into a manifest fragment: queries, charts, layout, databases."""
    from dbt_charts.agent_api import ProjectSession
    from dbt_charts.core.render.board_resolve import build_resolved_board

    with ProjectSession.open(project_dir) as session:
        board, executor, variables = _open_board(session, board_rel, dive_width)
        controls, dims, notes = _compile_controls(board, executor, variables, prefix)
        compiled = _compile_queries(session, board, executor, variables, dims, prefix)
        # dct's own sizing and resolution pass, at the Dive width.
        with _tolerant_resolution():
            resolved, _cache = build_resolved_board(board, executor, variables, resolve_errors={})
        walk = _BoardCompiler(
            prefix=prefix,
            board=board,
            executor=executor,
            variables=variables,
            style=resolved.style,
            card_padding=float(resolved.card_padding or 0.0),
            dims=dims,
            queries=compiled.queries,
        )
        root = walk.board_node(resolved)
        root["variables"] = controls  # dct draws the strip under the board title
        root["variable_notes"] = notes + compiled.notes
        if walk.charts and len(walk.failures) == len(walk.charts):
            raise RuntimeError("every chart failed to compile:\n  " + "\n  ".join(walk.failures))

        return {
            "title": resolved.title or Path(board_rel).stem,
            "notes": resolved.notes or "",
            "board": root,
            "style": P.board_style(resolved.style, resolved, walk.card_padding),
            "queries": compiled.queries,
            "query_variables": compiled.query_variables,
            "charts": walk.charts,
            "databases": sorted(compiled.databases),
            "refs": sorted(compiled.refs),
            "failures": walk.failures,
        }


# Channels an author can spell a null into by hand. dct's own channel validator already
# treats a falsy field as "no channel" (``resolve/chart/channel.py::_validate_channel_field``:
# ``if not data_field or data_field in available_columns: return``), but YAML only parses
# ``null``/``NULL``/``~``/empty as a null — ``None`` and ``nil`` arrive as strings and are then
# looked up as column names, which fails the whole chart. Read them as the empty one.
#
# Only the optional encodings. A null-ish ``x``, ``y``, ``theta`` or ``latitude`` is left to
# fail: those are optional in the model because dct auto-detects them when absent, so blanking
# one would draw a chart that looks right while plotting a column the author never named.
_NULLABLE_CHANNELS = ("color", "size", "shape")
_SPELLED_NULL = {"", "none", "null", "nil"}


def _read_spelled_nulls_as_unset(board: Any, board_rel: str) -> None:
    for cid, chart in board.charts.items():
        for channel in _NULLABLE_CHANNELS:
            value = getattr(chart, channel, None)
            if isinstance(value, str) and value.strip().lower() in _SPELLED_NULL:
                setattr(chart, channel, None)
                print(f"dbt_charts_dive: {board_rel}: {cid}.{channel} is {value!r}, reading it as no {channel} channel", flush=True)


def _open_board(session: Any, board_rel: str, dive_width: int) -> tuple[Any, Any, dict[str, Any]]:
    """dct's compiled board, pinned to the Dive viewport, and the executor that runs it."""
    from dbt_charts.agent_api import Diagnostic
    from dbt_charts.agent_api._paths import resolve_board_or_error
    from dbt_charts.core.compile.compiler import compile_file
    from dbt_charts.core.execute.executor import Executor, merge_board_variables

    bf = resolve_board_or_error(Path(board_rel), session.project)
    if isinstance(bf, Diagnostic):
        raise RuntimeError(f"{board_rel}: {bf.model_dump(exclude_none=True)}")
    cr = compile_file(bf)
    if not cr.success or cr.board is None:
        errs = "; ".join(str(e.model_dump(exclude_none=True)) for e in cr.errors)
        raise RuntimeError(f"{board_rel} failed to compile: {errs}")
    board = cr.board
    _read_spelled_nulls_as_unset(board, board_rel)
    frame = board.resolved_style.frame.model_copy(update={"width": float(dive_width)})
    board.resolved_style = dataclasses.replace(board.resolved_style, frame=frame)
    executor = Executor(board, adapter_registry=session.adapter_registry, query_registry=cr.query_registry, use_cache=False)
    return board, executor, merge_board_variables(board, {})


def _compile_controls(board: Any, executor: Any, variables: dict[str, Any], prefix: str) -> tuple[list[dict[str, Any]], dict[str, V.Dimension], list[str]]:
    """The variables strip: dct's resolved controls, and the variant dimension of each."""
    from dbt_charts.core.render.variables_resolve import resolve_controls

    notes: list[str] = []
    try:
        resolved = resolve_controls(board.variables, variables, executor, board.resolved_style.variables)
    except Exception as e:  # noqa: BLE001 — a board whose controls cannot be resolved keeps its defaults
        resolved, notes = (), [f"variables not interactive: {e}"]
    dims: dict[str, V.Dimension] = {}
    controls: list[dict[str, Any]] = []
    for rc in resolved:
        key = prefix + rc.name
        dim = V.dimension_for(rc, key)
        if dim is not None:
            dims[rc.name] = dim
        controls.append(V.control_spec(rc, key))
    for spec, rc in zip(controls, resolved, strict=True):
        spec["enabled"] = V.compile_condition(rc.var_def.enabled, True, dims, variables, executor, f"Variable '{rc.name}' enabled")
    return controls, dims, notes


@dataclass
class _CompiledQueries:
    """What a board's queries contribute to the manifest."""

    queries: dict[str, str] = field(default_factory=dict)
    query_variables: dict[str, Any] = field(default_factory=dict)
    databases: set[str] = field(default_factory=set)
    refs: set[str] = field(default_factory=set)  # the dbt models they resolved, partials included
    notes: list[str] = field(default_factory=list)


def _compile_queries(session: Any, board: Any, executor: Any, variables: dict[str, Any], dims: dict[str, V.Dimension], prefix: str) -> _CompiledQueries:
    """One live statement per board query, plus one per combination of control values."""
    out = _CompiledQueries()
    for qname, q in board.queries.items():
        if getattr(q, "query_type", "sql") != "sql":
            continue  # inline values / http / csv — charts using them get a snapshot
        try:
            tmpl = S.query_template(session, board, q, qname)
            sql = S.render_sql(tmpl, variables)
            rows = executor.execute_query(qname, variables)
            out.refs |= {str(r.ref_name) for r in (tmpl.relations or []) if getattr(r, "ref_name", None)}
            casts = S.column_casts(rows)
            sql, found = S.qualify_tables(sql, tmpl.source_db or "")
            out.queries[prefix + qname] = S.wrap_sql(sql, casts)
            out.databases |= found
        except Exception:  # noqa: BLE001 — surfaced per chart below (resolve fails too)
            continue
        deps = sorted(getattr(q, "variable_dependencies", ()) or ())
        if not (deps and dims):
            continue

        def finish(s: str, _db: str = tmpl.source_db or "", _casts: dict[str, str] = casts) -> str:
            """Post-process a variant the way the default SQL was; slot tokens ride through."""
            return S.wrap_sql(S.qualify_tables(s, _db)[0], _casts)

        qv = V.compile_query_variants(tmpl.sql, deps, dims, variables, tmpl.warehouse, tmpl.strict, finish)
        if qv is None:
            continue
        out.query_variables[prefix + qname] = qv
        if qv.get("note"):
            out.notes.append(f"{qname}: {qv['note']}")
        # What the Dive runs before anyone touches a control. Taken from the variant table
        # rather than rendered again, so the query this manifest advertises is the one the
        # Dive sends.
        at_defaults = {d.key: variables.get(name) for name, d in dims.items()}
        out.queries[prefix + qname] = V.variant_sql(qv, out.queries[prefix + qname], at_defaults)
    return out


# ─────────────────────────────────────────────────────────────────────────────
# the walk of dct's resolved board
# ─────────────────────────────────────────────────────────────────────────────
@dataclass
class _BoardCompiler:
    """The walk of dct's resolved board, and the state each step of it needs.

    dct hands back a tree of boards, layouts and positioned items. The Dive needs that tree
    as data, with every chart compiled on the way past — so the walk carries what it
    accumulates (the charts, and the ones that failed) and what every level reads: the
    prefix that keeps two boards in one Dive apart, dct's resolved style, and the variable
    values its conditions are evaluated at.
    """

    prefix: str
    board: Any  # dct's compiled board, for the decisions that are the board's (auto_link)
    executor: Any
    variables: dict[str, Any]
    style: Any
    card_padding: float
    dims: dict[str, V.Dimension]
    queries: dict[str, str]
    charts: dict[str, Any] = field(default_factory=dict)
    failures: list[str] = field(default_factory=list)

    def board_node(self, b: Any, path: str = "0") -> dict[str, Any]:
        from dbt_charts.core.compile.resolve.style.typography import board_is_prose
        from dbt_charts.core.render.boards import _render_text_svg, _render_title_svg

        measure_w = max(float(b.layout.content_width or b.layout.width) - 2 * self.card_padding, 0.0)
        node: dict[str, Any] = {"title_svg": "", "text_svg": "", "layout": self._layout_node(b.layout, path)}
        if b.title:
            node["title_svg"] = _render_title_svg(b.title, self.variables, measure_w, self.style, text_align=self.style.text.align, level=b.level, prose=board_is_prose(b.text))
        if b.text:
            node["text_svg"] = _render_text_svg(b.text, self.variables, measure_w, self.style, self.style.text)[0]
        return node

    def _layout_node(self, layout: Any, path: str) -> dict[str, Any]:
        ltype = layout.type.value if hasattr(layout.type, "value") else str(layout.type)
        items = list(layout.items)
        if ltype == "tabs":
            titles = list(layout.tab_titles) if len(layout.tab_titles) == len(items) else [f"Tab {i + 1}" for i in range(len(items))]
            slugs = list(layout.tab_slugs) if len(layout.tab_slugs) == len(items) else [f"tab_{i}" for i in range(len(items))]
            return {
                "type": "tabs",
                "gap": float(layout.gap),
                "titles": titles,
                "slugs": slugs,
                # A tab group with no `id:` is still where it is: the viewer's open tab is
                # kept in Dive state under this key, so it has to survive a republish.
                "key": self.prefix + (layout.tab_variable or f"_tab_{path}"),
                "default": int(layout.default_tab or 0),
                "position": layout.tab_position or "top",
                "items": [self._item_node(it, f"{path}.{i}") for i, it in enumerate(items)],
            }
        if ltype == "rows":
            ordered = sorted(items, key=lambda it: it.y)
            return {"type": "rows", "gap": _spacing(ordered, "y"), "items": [self._item_node(it, f"{path}.{i}") for i, it in enumerate(ordered)]}
        # cols / grid: dct positioned every item; one CSS grid band per distinct y, column
        # tracks proportional to the widths it chose.
        bands: dict[int, list[Any]] = {}
        for it in items:
            bands.setdefault(round(it.y), []).append(it)
        nodes = []
        rows_of_items = []
        for band, y in enumerate(sorted(bands)):
            row = sorted(bands[y], key=lambda it: it.x)
            rows_of_items.append(row)
            nodes.append({"type": "cols", "gap": _spacing(row, "x"), "columns": " ".join(f"{max(round(it.width), 1)}fr" for it in row), "items": [self._item_node(it, f"{path}.{band}.{i}") for i, it in enumerate(row)]})
        if len(nodes) == 1:
            return nodes[0]
        # Several bands stack as rows; each band is a layout item (a title-less board node).
        band_gaps = [max(0.0, nxt[0].y - max(it.y + it.height for it in cur)) for cur, nxt in zip(rows_of_items, rows_of_items[1:], strict=False)]
        return {"type": "rows", "gap": round(sum(band_gaps) / len(band_gaps), 2), "items": [{"board": {"title_svg": "", "text_svg": "", "layout": n}} for n in nodes]}

    def _item_node(self, it: Any, path: str) -> dict[str, Any] | None:
        if it.chart is not None or it.chart_error is not None:
            node: dict[str, Any] = {"chart": self._chart_node(it)}
        elif it.board is not None:
            node = {"board": self.board_node(it.board, path)}
            if it.details_variable and it.details_summary:
                # dct's collapsible section (render/chart/rendering.py): a summary bar, the
                # content only when the (hidden, checkbox) details variable is true.
                node["details"] = {
                    "key": self.prefix + it.details_variable,
                    "summary": it.details_summary,
                    "expanded_summary": it.details_expanded_summary or it.details_summary,
                    "expanded": str(self.variables.get(it.details_variable, False)).lower() == "true",
                }
        else:
            return None
        visible = V.compile_condition(it.visible, True, self.dims, self.variables, self.executor, "layout item visible")
        if visible is not True:
            node["visible"] = visible
        return node

    def _chart_node(self, item: Any) -> str:
        """Compile one positioned chart into the manifest, and answer with its id."""
        if item.chart is None:  # resolution failed inside dct
            err = item.chart_error
            cid = self.prefix + err.identity.id
            message = getattr(err.diagnostic, "message", None) or str(err.diagnostic)
            self.failures.append(f"{err.identity.id}: {message}")
            self.charts[cid] = {"id": cid, "type": err.identity.chart_type, "kind": "unsupported", "width": round(item.width), "height": round(item.height), "message": message}
            return cid
        chart = item.chart
        cid = self.prefix + chart.id
        qname = chart.query_name
        live = (self.prefix + qname) if qname and (self.prefix + qname) in self.queries else None
        entry: dict[str, Any] = {"id": cid, "type": chart.chart_type, "query": live, "width": round(item.width), "height": round(item.height)}
        link = P.chart_link(chart, self.board, self.executor, self.failures) if chart.chart_type in ("kpi", "table") else None
        if link:
            entry["link"] = link  # KPI: the card is the anchor; table: dct's whole-row link band
        try:
            self._card(entry, chart, item)
        except Exception as e:  # noqa: BLE001 — one bad chart must not sink the board
            self.failures.append(f"{chart.id}: {e}")
            entry.update(kind="unsupported", message=f"{chart.chart_type} '{chart.id}' could not be compiled: {e}")
        self.charts[cid] = entry
        return cid

    def _card(self, entry: dict[str, Any], chart: Any, item: Any) -> None:
        """What the Dive draws for this chart: an SVG, a KPI card, a table, or a Vega spec.

        Writes into ``entry`` as it learns, so a chart that fails halfway still carries what
        it had — the rows of a chart with no live SQL are the only copy of them there is.
        """
        from dbt_charts.core.render.chart.callout import render_callout_chart_svg
        from dbt_charts.core.render.chart.spec_builders import additive_padding
        from dbt_charts.core.render.layout_sizing import build_chart_datasets

        if chart.chart_type == "callout":
            entry.update(kind="svg", svg=render_callout_chart_svg(chart, [], width=item.width, height=item.height))
            return
        datasets = build_chart_datasets(chart, self.executor, self.variables)
        data = datasets[chart.query_name]
        if entry["query"] is None:  # no live SQL (inline rows, an http source): dct's own rows ship
            entry["snapshot"] = _jsonable(data)
        pad = additive_padding(self.card_padding, chart.layout_padding)
        if chart.chart_type in ("kpi", "spark_bar"):
            # dct draws both of these itself, at the card size minus its padding.
            inner_w = item.width - pad["left"] - pad["right"]
            inner_h = item.height - pad["top"] - pad["bottom"]
            if chart.chart_type == "kpi":
                entry.update(kind="kpi", pad=pad, kpi=P.kpi_presentation(chart, data, inner_w, inner_h, self.style))
            else:
                entry.update(kind="spark_bar", pad=pad, spark_bar=P.spark_bar_presentation(chart, data, inner_w, inner_h, self.style))
        elif chart.chart_type == "table":
            entry.update(kind="table", pad=pad, table=P.table_presentation(chart, data, self.style))
        else:
            entry.update(self._vega_card(chart, item, data, datasets, pad))

    def _vega_card(self, chart: Any, item: Any, data: Any, datasets: Any, pad: dict[str, float]) -> dict[str, Any]:
        """dct's Vega-Lite spec for this chart, and the legend table a pie composes with it."""
        from dbt_charts.core.compile.models.chart.resolved import ResolvedPieChart
        from dbt_charts.core.render.chart.emitters.pie import prepare_pie_render_rows
        from dbt_charts.core.render.chart.vega_lite import _render_vl_artifact, render_resolved_chart

        card: dict[str, Any] = {}
        if isinstance(chart, ResolvedPieChart) and chart.attached_table is not None:
            # dct composes wheel + legend table as one SVG; the legend rows are a Python
            # projection of the snapshot, so they stay a snapshot here.
            art = _render_vl_artifact(chart, data, self.style, width=chart.wheel_width, height=None, is_placeholder=False, datasets=None, padding=pad)
            legend_rows = _jsonable(prepare_pie_render_rows(chart, data)[1])
            card["legend"] = {"table": P.table_presentation(chart.attached_table, legend_rows, self.style), "rows": legend_rows}
        else:
            width = chart.resolution_width if isinstance(chart, ResolvedPieChart) else item.width
            art = render_resolved_chart(chart, data, self.style, width=width, height=item.height, datasets=datasets, padding=pad)
        if art.kind != "vega_spec" or not isinstance(art.payload, dict):
            raise RuntimeError(f"chart type '{chart.chart_type}' rendered as {art.kind}, not a Vega-Lite spec")
        return card | {"kind": "vega", "spec": SPEC.live_spec(_jsonable(art.payload), chart, self.style, item, _jsonable(data))}


def _spacing(items: list[Any], axis: str) -> float:
    """The gap dct actually left between consecutive positioned items along ``axis``
    (``layout.gap`` is a sizing-pass input; cards in a band tile the width, bands are
    separated by the frame's card gap)."""
    gaps = []
    for a, b in zip(items, items[1:], strict=False):
        end = (a.x + a.width) if axis == "x" else (a.y + a.height)
        gaps.append(max(0.0, (b.x if axis == "x" else b.y) - end))
    return round(sum(gaps) / len(gaps), 2) if gaps else 0.0


# ─────────────────────────────────────────────────────────────────────────────
# dive assembly
# ─────────────────────────────────────────────────────────────────────────────
def _required_databases(names: list[Any]) -> tuple[list[dict[str, str]], list[dict[str, str]]]:
    """(REQUIRED_DATABASES for the TSX, required_resources for MD_CREATE_DIVE).

    Each entry is a database or a share, written any of these ways::

        analytics                                   # database
        md:analytics                                # database
        md:_share/analytics_share/<uuid>            # share, alias taken from the URL
        analytics=md:_share/analytics_share/<uuid>  # share under an explicit alias
        {alias: analytics, path: md:_share/...}     # the same, spelled out

    The alias matters: it is the catalog name the Dive's SQL is qualified with, so pointing a
    board's Dive at a share of the same database needs `alias` to stay the database's name —
    which is what lets a published Dive read shared data without recompiling its queries.
    """
    tsx: list[dict[str, str]] = []
    sql: list[dict[str, str]] = []
    for entry in names:
        alias: str | None = None
        if isinstance(entry, dict):
            name = str(entry.get("path") or entry.get("url") or "")
            alias = str(entry["alias"]) if entry.get("alias") else None
        else:
            name = str(entry)
            if "=" in name and "://" not in name:
                alias, name = (part.strip() for part in name.split("=", 1))
        if not name:
            continue
        if name.startswith("md:_share/"):
            path = name
            alias = alias or name.split("/")[1]
        elif name.startswith("md:"):
            path = name
            alias = alias or name[3:]
        else:
            path = f"md:{name}"
            alias = alias or name
        rtype = "share" if "_share/" in path else "database"
        tsx.append({"type": rtype, "path": path, "alias": alias})
        sql.append({"name": alias, "alias": alias, "url": path, "resource_type": rtype})
    return tsx, sql


def build_dive_from_boards(
    project_dir: Path | str,
    boards: list[str],
    *,
    title: str | None = None,
    description: str | None = None,
    required_databases: list[str] | None = None,
    dive_width: int = DEFAULT_DIVE_WIDTH,
    options: dict[str, Any] | None = None,
) -> DiveBuild:
    """Compile one or more boards into the Dive that renders them."""
    project_dir = Path(project_dir).resolve()
    if not boards:
        raise ValueError("build_dive needs at least one board path (relative to the dbt project)")
    parts = [compile_board(project_dir, b, dive_width=dive_width, prefix="" if len(boards) == 1 else Path(b).stem + ".") for b in boards]
    root, board_title, notes = _one_root(parts, boards, title)

    charts = {k: v for p in parts for k, v in p["charts"].items()}
    databases = required_databases or sorted({d for p in parts for d in p["databases"]})
    tsx_dbs, sql_resources = _required_databases(list(databases))
    manifest: dict[str, Any] = {
        "title": title or board_title,
        "built_at": _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "style": parts[0]["style"],
        "board": root,
        "queries": {k: v for p in parts for k, v in p["queries"].items()},
        "query_variables": {k: v for p in parts for k, v in p["query_variables"].items()},
        "charts": charts,
    }
    manifest["fonts"] = P.font_faces(json.dumps(manifest, default=_jsonable))
    # The Vega runtime: the exact Vega-Lite the specs were compiled for (see bundle.py).
    from dbt_charts_dive.bundle import get_bundle

    specs = [c["spec"] for c in charts.values() if c.get("kind") == "vega" and isinstance(c.get("spec"), dict)]
    vega_bundle = get_bundle(project_dir, options or {}, specs)
    manifest["bundle"] = vega_bundle.manifest()

    return DiveBuild(
        title=manifest["title"],
        description=description or notes or f"dbt Charts board {', '.join(boards)}",
        content=_fill_template(manifest, boards, tsx_dbs, vega_bundle.b64),
        required_resources=sql_resources,
        refs=sorted({r for part in parts for r in part.get("refs", ())}),
        manifest=manifest,
    )


def _one_root(parts: list[dict[str, Any]], boards: list[str], title: str | None) -> tuple[dict[str, Any], str, str]:
    """One board is the Dive's root; several become the tabs of one."""
    if len(parts) == 1:
        return parts[0]["board"], parts[0]["title"], parts[0]["notes"]
    root = {
        "title_svg": "",
        "text_svg": "",
        "variables": [],
        "variable_notes": [],
        "layout": {
            "type": "tabs",
            "gap": 0.0,
            "titles": [p["title"] for p in parts],
            "slugs": [Path(b).stem for b in boards],
            "key": "_tab_dive",
            "default": 0,
            "position": "top",
            "items": [{"board": p["board"]} for p in parts],
        },
    }
    return root, title or "dbt Charts", ""


def _fill_template(manifest: dict[str, Any], boards: list[str], tsx_dbs: list[dict[str, str]], bundle: str) -> str:
    """``template.tsx`` with this Dive's manifest, databases and Vega runtime in it.

    One pass, so a value can never contain the next placeholder: a board titled
    ``__VEGA_BUNDLE_B64__`` would otherwise have the whole runtime spliced into its manifest
    by the following replace.
    """
    filled = {
        "__BOARD_PATHS__": ", ".join(boards),
        "__REQUIRED_DATABASES_JSON__": json.dumps(tsx_dbs),
        "__MANIFEST_JSON__": json.dumps(manifest, default=_jsonable),
        "__VEGA_BUNDLE_B64__": bundle,
    }
    return re.sub("|".join(filled), lambda m: filled[m.group(0)], TEMPLATE_PATH.read_text(encoding="utf-8"))
