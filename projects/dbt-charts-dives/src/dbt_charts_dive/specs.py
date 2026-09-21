"""The Vega-Lite spec a Dive renders, against rows it has not seen yet.

dbt-charts compiles a spec for the rows it queried at build time and bakes some of its own
Python into the data: the pie's geometry and slice labels, the canonicalized time buckets an
x axis was built against. The Dive fetches its own rows, so each of those is re-derived here
as a Vega transform or expression — and where that is not possible, the spec keeps what
dbt-charts wrote.

From dbt-charts' private surface: ``render.chart.vega_lite._render_vl_artifact`` (via the
caller) and ``render.converters.chart.render_vega_spec``, whose in-place corrections to a
concat/facet spec the browser needs as much as the SVG export did.
"""

from __future__ import annotations

import hashlib
import json
import re
import urllib.request
from typing import Any

LIVE_ROWS = "dcd_rows"  # the dataset name template.tsx fills with what the query returned
_MAX_GEOMETRY_BYTES = 8_000_000
_GEOMETRY: dict[str, Any] = {}  # one fetch per URL per compile


# ─────────────────────────────────────────────────────────────────────────────
# dct's hand-off sentinels
# ─────────────────────────────────────────────────────────────────────────────
def _strip_sentinels(node: Any) -> Any:
    """Drop dbt-charts' internal ``$df_*`` hand-off keys from a Vega-Lite spec."""
    if isinstance(node, dict):
        return {k: _strip_sentinels(v) for k, v in node.items() if not str(k).startswith("$df_")}
    if isinstance(node, list):
        return [_strip_sentinels(x) for x in node]
    return node


_HREF_SENTINEL_PREFIX = "'http://dct.invalid' + "


def _strip_href_sentinel(node: Any) -> None:
    """dct prefixes a relative ``link:`` with a sentinel origin so vl-convert leaves it
    alone, then strips it from the SVG (``converters/chart.py``). The browser needs the
    same href dct's SVG carries, so the prefix comes off the calculate expression here."""
    if isinstance(node, dict):
        calc = node.get("calculate")
        if isinstance(calc, str) and calc.startswith(_HREF_SENTINEL_PREFIX):
            node["calculate"] = calc[len(_HREF_SENTINEL_PREFIX) :]
        for v in node.values():
            _strip_href_sentinel(v)
    elif isinstance(node, list):
        for v in node:
            _strip_href_sentinel(v)


# ─────────────────────────────────────────────────────────────────────────────
# a pie's slice labels
# ─────────────────────────────────────────────────────────────────────────────
_PY_FORMAT_CALL = re.compile(r"^\{:([^}]*)\}$")
_D3_SPEC = re.compile(r"^[+ ]?[$]?,?(\.\d+)?[%fdegs]?$")


def _label_expr(node: Any, names: dict[str, str]) -> str | None:
    """One Jinja expression from a label template as a Vega expression, or None.

    Small on purpose: a name from the label context, a literal, and the two ways dct's own
    templates format a number — ``{{ value | format(',.0f') }}`` and Python's
    ``{{ '{:.0%}'.format(percent) }}``. Anything else is not reproducible here.
    """
    from jinja2 import nodes

    if isinstance(node, nodes.Name):
        return names.get(node.name)
    if isinstance(node, nodes.Const):
        return json.dumps("" if node.value is None else node.value)
    if isinstance(node, nodes.Filter) and node.name == "format" and len(node.args) == 1 and isinstance(node.args[0], nodes.Const):
        inner, spec = _label_expr(node.node, names), str(node.args[0].value)
        return f"format({inner}, {json.dumps(spec)})" if inner and _D3_SPEC.match(spec) else None
    if isinstance(node, nodes.Call) and isinstance(node.node, nodes.Getattr) and node.node.attr == "format":
        owner = node.node.node
        if isinstance(owner, nodes.Const) and isinstance(owner.value, str) and len(node.args) == 1:
            m = _PY_FORMAT_CALL.match(owner.value)
            inner = _label_expr(node.args[0], names)
            if m and inner and _D3_SPEC.match(m.group(1)):
                return f"format({inner}, {json.dumps(m.group(1))})"
    return None


def _pie_label_expr(chart: Any, labels: Any, fields: list[str]) -> str | None:
    """dct's slice-label template as one Vega expression over the live row, or None.

    dct renders the template per row in Python (``prepare_pie_label_data``), so its output
    is the percentage of the rows it compiled against. The template is small — literal text
    and a few names — so compile it and let the browser evaluate it against what the query
    returns now.
    """
    from jinja2 import nodes

    from dbt_charts.core.compile.template.labels_env import label_jinja_env

    if labels is None or labels.where or not labels.template:
        return None
    names = {f: f"datum[{json.dumps(f)}]" for f in fields if not f.startswith("__dbt_")}
    names |= {
        "percent": "datum.__dbt_pct",
        "value": f"datum[{json.dumps(chart.theta)}]",
        "total": "datum.__dbt_total",
        "index": "datum.__dbt_row_idx",
        "is_first": "datum.__dbt_row_idx === 0",
    }
    if chart.identity_field:
        names["color"] = f"datum[{json.dumps(chart.identity_field)}]"
    parts: list[str] = []
    try:
        ast = label_jinja_env().parse(labels.template)
    except Exception:  # noqa: BLE001 — dct parsed it; if we cannot, keep its own output
        return None
    for output in ast.find_all(nodes.Output):
        for child in output.nodes:
            if isinstance(child, nodes.TemplateData):
                parts.append(json.dumps(child.data))
            else:
                expr = _label_expr(child, names)
                if expr is None:
                    return None
                parts.append(f"({expr} == null ? '' : {expr})")
    for other in ast.body:  # {% if %}, {% for %}, {% set %} — not an expression
        if not isinstance(other, nodes.Output):
            return None
    return " + ".join(parts) if parts else None


def _pie_live_transforms(spec: dict[str, Any], chart: Any, snapshot: list[dict[str, Any]]) -> None:
    """Recompute, in Vega-Lite, the per-slice fields dct adds to a pie's rows in Python.

    ``_augment_pie_data`` bakes ``__dbt_row_idx/_total/_pct/_mid/_top/_right`` and the
    finalized slice labels into the data. With live rows those fields are absent, so the
    geometry is re-derived with window/joinaggregate transforms, and the label template is
    evaluated as an expression — including dct's rule that a slice under
    ``wedge_label_min_share`` carries no label. A template too involved to compile keeps
    dct's own text, carried over by slice key.
    """
    theta, key = chart.theta, chart.identity_field
    t = f"datum[{json.dumps(theta)}]"
    transforms: list[dict[str, Any]] = [
        {"window": [{"op": "row_number", "as": "__dbt_rn"}, {"op": "sum", "field": theta, "as": "__dbt_cum"}], "frame": [None, 0]},
        {"joinaggregate": [{"op": "sum", "field": theta, "as": "__dbt_total"}]},
        {"calculate": "datum.__dbt_rn - 1", "as": "__dbt_row_idx"},
        {"calculate": f"datum.__dbt_total ? {t} / datum.__dbt_total : 0", "as": "__dbt_pct"},
        {"calculate": f"datum.__dbt_total ? 2 * PI * (datum.__dbt_cum - {t} / 2) / datum.__dbt_total : 0", "as": "__dbt_mid"},
        {"calculate": "cos(datum.__dbt_mid) >= 0", "as": "__dbt_top"},
        {"calculate": "sin(datum.__dbt_mid) >= 0", "as": "__dbt_right"},
    ]
    labels = getattr(getattr(chart.style, "slice_mark", None), "labels", None)
    expr = _pie_label_expr(chart, labels, list(snapshot[0]) if snapshot else [])
    if expr:
        from dbt_charts.core.compile.config import get_chart_rendering

        floor = float(get_chart_rendering().pie.wedge_label_min_share)
        transforms += [
            {"calculate": f"datum.__dbt_pct > {floor} ? split({expr}, '\\n') : null", "as": "__dbt_label"},
            {"calculate": "datum.__dbt_label ? length(datum.__dbt_label) : 0", "as": "__dbt_label_lines"},
        ]
    else:
        carried = [{key: r.get(key), "__dbt_label": r["__dbt_label"], "__dbt_label_lines": r.get("__dbt_label_lines", 0)} for r in snapshot if key and r.get("__dbt_label")]
        if carried:
            transforms.append({"lookup": key, "from": {"data": {"values": carried}, "key": key, "fields": ["__dbt_label", "__dbt_label_lines"]}})
    spec["transform"] = transforms + list(spec.get("transform") or [])


# ─────────────────────────────────────────────────────────────────────────────
# a cartesian chart's x axis
# ─────────────────────────────────────────────────────────────────────────────
_ISO_DATE = re.compile(r"\d{4}-\d{2}-\d{2}")


def _canonical_iso(v: Any) -> str | None:
    """dct's ``canonicalize_and_sort_ordinal_x`` / ``normalize_labeled_temporal`` collapse of
    a bucketed-time x value to a date-only ISO string, for the forms a Vega expression can
    mirror: ``YYYY-MM-DD[T| ]…`` -> first 10 chars, ``YYYY-MM`` -> ``-01``, ``YYYY`` -> ``-01-01``."""
    if not isinstance(v, str):
        return None
    if _ISO_DATE.match(v):
        return v[:10]
    if re.fullmatch(r"\d{4}-\d{2}", v):
        return v + "-01"
    if re.fullmatch(r"\d{4}", v):
        return v + "-01-01"
    return None


def _cartesian_live_transforms(spec: dict[str, Any], raw: list[dict[str, Any]]) -> None:
    """Mirror, in Vega-Lite, what dct did to the rows before compiling the x axis.

    dct canonicalizes a bucketed-time x column to date-only ISO strings and sorts the rows
    ascending before it builds ``axis.values``/``labelExpr`` against them; the spec then
    only matches rows in that form. Live rows arrive as the SQL returns them
    (``'2023-01-01 00:00:00'``, ``'2023-01'``, DESC order), so — when the snapshot proves
    that collapse is exactly what dct applied — a ``calculate`` rewrites the field the same
    way and an ordinal x sorts ascending. (dct's gap fill of missing buckets is not mirrored.)
    """
    unit = spec["hconcat"][0] if isinstance(spec.get("hconcat"), list) and spec["hconcat"] else spec
    enc = unit.get("encoding") or next((layer.get("encoding") for layer in unit.get("layer") or [] if isinstance(layer, dict) and layer.get("encoding")), None) or {}
    x = (enc.get("x") or {}).get("field") if isinstance(enc.get("x"), dict) else None
    if not x:
        return
    prepared = (spec.get("data") or {}).get("values") or (unit.get("data") or {}).get("values") or []
    prep_x = {r.get(x) for r in prepared if isinstance(r, dict) and r.get(x) is not None}
    raw_x = {r.get(x) for r in raw if r.get(x) is not None}
    if not prep_x or not raw_x or prep_x == raw_x:
        return
    if not all(isinstance(v, str) and _ISO_DATE.fullmatch(v) for v in prep_x):
        return
    if {_canonical_iso(v) for v in raw_x} != prep_x:
        return  # a rewrite this mirror does not know; leave the spec as compiled
    q = json.dumps(x)
    d = f"datum[{q}]"
    iso = f"(length({d}) == 7 ? {d} + '-01' : length({d}) == 4 ? {d} + '-01-01' : slice({d}, 0, 10))"
    # A calculated field is not date-parsed by Vega-Lite, so a temporal x must become a Date
    # here — toDate() of a date-only ISO string is UTC midnight, exactly how Vega-Lite parses
    # dct's snapshot strings (and independent of the reader's time zone).
    temporal = (enc.get("x") or {}).get("type") == "temporal"
    expr = f"isString({d}) ? {'toDate' + iso if temporal else iso} : {d}"
    spec["transform"] = [{"calculate": expr, "as": x}] + list(spec.get("transform") or [])

    def sort_ordinal(node: Any) -> None:
        if isinstance(node, dict):
            xe = node.get("x") if "x" in node and isinstance(node.get("x"), dict) else None
            if xe and xe.get("field") == x and xe.get("type") in ("ordinal", "nominal") and not xe.get("sort"):
                xe["sort"] = "ascending"
            for v in node.values():
                sort_ordinal(v)
        elif isinstance(node, list):
            for v in node:
                sort_ordinal(v)

    sort_ordinal(spec)


def _apply_render_time_corrections(spec: dict[str, Any], style: Any, item: Any, chart_id: str) -> None:
    """Run dct's own spec-to-SVG pass on the spec, for its side effects.

    ``render_vega_spec`` (``render/converters/chart.py``) is where dct consumes the
    ``$df_*`` hand-off sentinels: it wraps titles to the card and, because Vega-Lite
    ignores ``autosize: fit`` on concat/facet composites, probes the spec once with
    vl-convert and shrinks the resizable panes so the outer size lands on the card
    (``_correct_concat_overshoot`` / ``_correct_facet_overshoot``). Those edits happen
    in place on the spec dct then renders; the browser gets the same corrected spec.
    The SVG itself is discarded (the sizing pass has already cached it).
    """
    try:
        from dbt_charts.core.render.converters.chart import render_vega_spec

        render_vega_spec(spec, "svg", style, width=item.width, height=item.height, is_placeholder=False, chart_id=chart_id)
    except Exception:  # noqa: BLE001, S110 — no vl-convert / a probe failure: ship the spec as compiled
        pass


# ─────────────────────────────────────────────────────────────────────────────
# the spec the Dive gets
# ─────────────────────────────────────────────────────────────────────────────
def _is_the_rows(values: Any, rows: list[dict[str, Any]]) -> bool:
    """Whether an embedded dataset is the rows dct compiled against — the whole row, or the
    fields a transform picked out of it."""
    return (
        isinstance(values, list)
        and len(values) == len(rows)
        and bool(rows)
        and all(isinstance(v, dict) and v.items() <= r.items() for v, r in zip(values, rows, strict=True))
    )


def _name_the_rows(node: Any, rows: list[dict[str, Any]]) -> None:
    """Point every dataset that holds dct's rows at the one the Dive fills.

    A cartesian chart reads the spec's own dataset, so replacing that was enough. A
    choropleth reads its rows through the ``lookup`` transform that joins them to the
    geometry, which carries them as data — and a Dive that swapped only the top-level
    dataset re-ran the query and drew the build's numbers.
    """
    if isinstance(node, dict):
        data = node.get("data")
        if isinstance(data, dict) and _is_the_rows(data.get("values"), rows):
            node["data"] = {"name": LIVE_ROWS}
        for value in list(node.values()):
            _name_the_rows(value, rows)
    elif isinstance(node, list):
        for value in node:
            _name_the_rows(value, rows)


def _carry_the_geometry(spec: dict[str, Any], node: Any) -> None:
    """Fetch what a spec points a ``data.url`` at, once, and carry it in the Dive.

    dct's map families name a TopoJSON on vega.github.io. Leaving the URL there makes every
    viewer fetch a third party to draw the card — and a sandbox that refuses the request is
    a card that never draws. Too large to carry, or unreachable, keeps the URL.
    """
    if isinstance(node, dict):
        data = node.get("data")
        if isinstance(data, dict) and isinstance(data.get("url"), str):
            url = data["url"]
            if url not in _GEOMETRY:
                try:
                    with urllib.request.urlopen(url, timeout=60) as r:  # noqa: S310 — the URL dct compiled in
                        raw = r.read(_MAX_GEOMETRY_BYTES + 1)
                    _GEOMETRY[url] = json.loads(raw) if len(raw) <= _MAX_GEOMETRY_BYTES else None
                except Exception as e:  # noqa: BLE001 — the Dive can still fetch it itself
                    print(f"dbt_charts_dive: keeping {url} as a link ({type(e).__name__}); the Dive will fetch it", flush=True)
                    _GEOMETRY[url] = None
            geometry = _GEOMETRY[url]
            if geometry is not None:
                name = "dcd_geo_" + hashlib.sha256(url.encode()).hexdigest()[:8]  # stable: the same board publishes the same Dive
                spec.setdefault("datasets", {})[name] = geometry
                node["data"] = {"name": name, **({"format": data["format"]} if data.get("format") else {})}
        for value in list(node.values()):  # the fetch adds `datasets` to the spec as we walk it
            _carry_the_geometry(spec, value)
    elif isinstance(node, list):
        for value in node:
            _carry_the_geometry(spec, value)


def live_spec(spec: dict[str, Any], chart: Any, style: Any, item: Any, data: list[dict[str, Any]]) -> dict[str, Any]:
    """dct's compiled spec, ready to render against rows the Dive has yet to fetch.

    dct's own render-time corrections first — they happen in place on the spec it renders,
    and the browser needs the same ones the SVG export got — then its hand-off sentinels
    out, then the Python it baked into the rows re-derived as transforms. Last, every
    dataset that holds those rows — the spec's own, and the one a choropleth's lookup
    carries — is named for the Dive to fill, and whatever the spec pointed a URL at is
    carried with it.
    """
    from dbt_charts.core.compile.models.chart.resolved import ResolvedPieChart

    _apply_render_time_corrections(spec, style, item, chart.id)
    spec = _strip_sentinels(spec)
    _strip_href_sentinel(spec)  # ``link:`` → dct's own encoding.href, minus the vl-convert guard
    if isinstance(chart, ResolvedPieChart):
        _pie_live_transforms(spec, chart, spec.get("data", {}).get("values", []))
    else:
        _cartesian_live_transforms(spec, data)
    _name_the_rows(spec, data)
    _carry_the_geometry(spec, spec)
    spec["data"] = {"name": LIVE_ROWS}
    return spec
