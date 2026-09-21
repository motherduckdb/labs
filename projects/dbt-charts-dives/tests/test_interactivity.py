"""End-to-end: the six interactions dbt Charts offers, retained by the Dive.

Each test drives the generated Dive (headless Chromium with the real Vega bundle where a
pointer is involved, jsdom otherwise) and compares with dbt Charts' own answer for the same
board: its ``render_board(format="json", variables=...)`` rows, the ``description`` /
``href`` its spec carries, the anchors in its SVG export, its pagination rules and its
resolved layout metadata.
"""

from __future__ import annotations

import json
import re
import xml.etree.ElementTree as ET

import harness as H
import pytest

F = H.FIXTURE_BOARDS
HEADER, SERIES, ORDER = "\u2061", "\u2062", "\u200c"  # emitters/_tooltip.py role markers
SALES = "charts/sales_dashboard.yml"
DRILL = "charts/variables/drill-down.yml"


def _dct_anchors(board: str, chart_id: str) -> list[str]:
    """hrefs of the ``<a>`` elements inside one chart of dct's SVG export, in document order."""
    root = ET.fromstring(H.dct_svg(board))
    group = next(g for g in root.iter() if g.get("data-chart-id") == chart_id)
    return [a.get("href") or a.get("{http://www.w3.org/1999/xlink}href") or "" for a in group.iter(H.SVG_NS + "a")]


def _dct_aria_labels(board: str, chart_id: str) -> list[str]:
    """dct's tooltip content per mark: the ``aria-label`` vl-convert wrote from the spec's
    ``description`` expression (the same expression the Dive's Vega evaluates)."""
    root = ET.fromstring(H.dct_svg(board))
    group = next(g for g in root.iter() if g.get("data-chart-id") == chart_id)
    marks = next(e for e in group.iter(H.SVG_NS + "svg") if (e.get("class") or "") == "marks")
    return [e.get("aria-label") for e in marks.iter() if e.get("aria-label") and (e.get("class") or "") != "background" and e.tag != H.SVG_NS + "g"]


def _rows(board: str, cid: str, variables: dict | None = None) -> list[dict]:
    return H.normalize_rows(H.dct_chart_items(board, json.dumps(variables) if variables else "")[cid]["data"])


# ── 1. hover tooltips ───────────────────────────────────────────────────────────
@pytest.mark.browser
def test_tooltip_matches_dct_description():
    """Hovering a bar in Chromium shows dct's structured tooltip: header = the x value,
    then one ``Label: value`` row per dependent value, exactly the text dct's
    ``description`` expression evaluates to for that datum (its own SVG's aria-label),
    styled from the theme's tooltip block; the other bars recede (hover emphasis)."""
    board = SALES
    m = H.build(board).manifest
    vega_ids = [c for c in H.chart_order(m) if m["charts"][c]["kind"] == "vega"]
    bar = vega_ids.index("revenue_by_product")
    rep, _ = H.browser(board, actions=json.dumps([{"type": "hover", "chart": bar, "index": 0}, {"type": "hover", "chart": bar, "index": 1}]))
    assert rep["console_errors"] == []
    dct_labels = [l for l in _dct_aria_labels(board, "revenue_by_product") if HEADER in l]
    dive_labels = [l for l in rep["marks_aria"][bar] if HEADER in l]
    assert dive_labels == dct_labels, "the marks carry dct's description text"
    for step, label in zip(rep["steps"], dive_labels):
        tt = step["tooltip"]
        assert tt is not None, "tooltip visible after hover"
        header, value = label.split("; ")
        assert [r["kind"] for r in tt["rows"]] == ["header", "value"]
        assert tt["rows"][0]["text"] == header.lstrip(HEADER)
        key, val = value.split(": ")
        # chart_interactivity.js formatFieldName: snake_case -> Title Case
        assert tt["rows"][1]["text"] == key.replace("_", " ").title() + val
        # hover emphasis: exactly the hovered bar keeps its paint
        opac = step["marks_opacity"][bar]
        assert [o == "" for o in opac[: len(dive_labels)]] == [l == label for l in dive_labels], opac
        T = m["style"]["tooltip"]
        assert H.css_color(tt["style"]["background"]) == H.css_color(T["background"])
        assert tt["style"]["fontSize"] == f"{int(T['font']['size'])}px" and tt["style"]["borderRadius"] == f"{int(T['border']['radius'])}px"


@pytest.mark.browser
def test_tooltip_x_unified_for_multi_series_line():
    """A multi-series line (sales_dashboard's revenue trend): hovering a point folds every
    series at that x into one bubble — dct's x-unified grid — one row per series in the
    legend order dct baked (``__dct_tooltip_order``), the hovered row marked active."""
    board = SALES
    m = H.build(board).manifest
    vega_ids = [c for c in H.chart_order(m) if m["charts"][c]["kind"] == "vega"]
    line = vega_ids.index("revenue_trend")
    first, _ = H.browser(board)
    data_marks = first["marks_aria"][line]
    labels = [l for l in data_marks if HEADER in l]
    by_header: dict[str, list[str]] = {}
    for l in labels:
        by_header.setdefault(l.split("; ")[0], []).append(l)
    hovered = next(l for l in labels if len(by_header[l.split("; ")[0]]) >= 2)  # a month with several regions
    index = [l for l in data_marks].index(hovered)
    rep, _ = H.browser(board, actions=json.dumps([{"type": "hover", "chart": line, "index": index}]))
    header = hovered.split("; ")[0].lstrip(HEADER)
    same_x = by_header[hovered.split("; ")[0]]
    tt = rep["steps"][0]["tooltip"]
    assert tt is not None
    rows = [r for r in tt["rows"] if r["kind"] == "row"]
    assert tt["rows"][0] == {"kind": "header", "text": header, "active": None}
    # one row per series at that x, ordered by dct's baked rank

    def rank(l: str) -> int:
        return int(re.search(ORDER + r"(\d+)", l).group(1))
    expected = sorted({l.split("; ")[1].lstrip(SERIES): l for l in same_x}.values(), key=rank)
    assert [r["active"] for r in rows].count("true") == 1
    # each grid row: swatch, series name, value (cells concatenate in textContent)
    assert [r["text"] for r in rows] == [l.split("; ")[1].lstrip(SERIES) + l.split(": ")[-1] for l in expected]
    assert rows[[r["active"] for r in rows].index("true")]["text"].startswith(hovered.split("; ")[1].lstrip(SERIES))


# ── 2. variables ───────────────────────────────────────────────────────────────
def test_variable_variants_compile_from_dct_controls():
    """The manifest carries dct's resolved control (input, options, default, unset label)
    and, per query reading it, one pre-rendered SQL per option value — each equal to what
    dbt-charts itself executes for that value (its json render with the variable set)."""
    m = H.build(SALES).manifest
    ctrl = m["board"]["variables"]
    assert [(c["key"], c["input"], c["default"], c["options"], c["can_unset"], c["unset_label"]) for c in ctrl] == [("region", "select", "All", ["North", "South", "East", "West", "All"], True, "All")]
    for qname in ("sales_by_month", "sales_by_product", "total_revenue"):
        qv = m["query_variables"][qname]
        assert qv["dims"] == [{"key": "region", "kind": "value"}] and set(qv["variants"]) == {"North", "South", "East", "West", "All", ""}
        assert all(v["slots"] == [] for v in qv["variants"].values())
    assert H.dive_sql(m, "sales_by_product") == m["queries"]["sales_by_product"], "the default variant is the default SQL"
    for region in ("North", "West"):
        for cid, qname in (("revenue_by_product", "sales_by_product"), ("total_revenue_kpi", "total_revenue")):
            got = H.normalize_rows(H.fetch_rows(H.dive_sql(m, qname, {"region": region})))
            assert H.as_multiset(got) == H.as_multiset(_rows(SALES, cid, {"region": region})), f"{region} {cid}"


@pytest.mark.browser
def test_select_variable_reruns_dependent_queries_in_chromium():
    """Changing ``Region`` in the Dive's select re-runs exactly the queries that read it
    with the pre-rendered SQL for that value; the KPIs and the bar chart show dct's rows
    for ``render_board(variables={"region": "North"})``; the selection lands in the Dive
    state under dct's variable name."""
    board = SALES
    m = H.build(board).manifest
    north = tuple(H.dive_sql(m, q, {"region": "North"}) for q in ("sales_by_month", "sales_by_product", "total_revenue"))
    rep, _ = H.browser(board, actions=json.dumps([{"type": "select", "key": "region", "value": "North", "expectVega": 2}]), extra_sql=north)
    assert rep["console_errors"] == [] and rep["alerts"] == []
    assert [v["input"] for v in rep["variables"]] == ["select"] and rep["variables"][0]["label"] == "Region:"
    step = rep["steps"][0]
    assert step["dive_state"]["region"] == "North" and step["alerts"] == []
    sql_after = step["sql_log"][len(rep["sql_log"]) :]  # the distinct SQL texts the change produced
    assert sorted(sql_after) == sorted(north), "exactly the three region queries re-ran, with the North variant"
    items = H.dct_chart_items(board, json.dumps({"region": "North"}))
    for cid, dom_value in zip([c for c in H.chart_order(m) if m["charts"][c]["kind"] == "kpi"], step["kpi_values"]):
        row = items[cid]["data"][0]
        assert dom_value == H.dct_kpi_text(row[items[cid]["chart"]["value"]], items[cid]["chart"].get("format")), cid
    vega_ids = [c for c in H.chart_order(m) if m["charts"][c]["kind"] == "vega"]
    bar = vega_ids.index("revenue_by_product")
    want = {(r["product_category"], round(float(r["total_revenue"]), 2)) for r in items["revenue_by_product"]["data"]}
    got = set()
    for label in step["marks_aria"][bar]:
        mm = re.fullmatch(HEADER + "(.+); total revenue: (.+)", label)
        if mm:
            got.add((mm.group(1), round(float(mm.group(2).replace(",", "")), 2)))
    assert got == want


@pytest.mark.browser
def test_multiselect_daterange_number_checkbox_in_chromium():
    """The free-input strategies, end to end on the synthetic board: a multiselect (one SQL
    shape per selection count, members inlined as an IN list), a daterange (``DATE`` slots),
    a number (``{{ }}`` interpolation) and a checkbox the Jinja branches on. After each
    change the Dive's SQL equals the harness' prediction and its table equals dct's rows for
    the same variable values."""
    board = F["variables_multi.yml"]
    m = H.build(board).manifest
    qv = m["query_variables"]["by_region"]
    assert [d["kind"] for d in qv["dims"]] == ["count", "set", "set", "checkbox"] and len(qv["variants"]) == 5 * 2 * 2 * 2
    assert m["board"]["variable_notes"] == []
    steps = [
        # members are committed in option order, whatever the click order (dct's popover too)
        ({"regions": ["North", "East", "West"]}, {"type": "multiselect", "key": "regions", "values": ["East", "West", "North"]}),
        ({"regions": ["North", "East", "West"], "period": ["2023-03-01", "2023-09-30"]}, {"type": "daterange", "key": "period", "values": ["2023-03-01", "2023-09-30"]}),
        ({"regions": ["North", "East", "West"], "period": ["2023-03-01", "2023-09-30"], "min_orders": 5}, {"type": "input", "key": "min_orders", "value": 5}),
        ({"regions": ["North", "East", "West"], "period": ["2023-03-01", "2023-09-30"], "min_orders": 5, "large_only": True}, {"type": "checkbox", "key": "large_only", "value": True}),
        ({"regions": [], "period": ["2023-03-01", "2023-09-30"], "min_orders": 5, "large_only": True}, {"type": "multiselect", "key": "regions", "values": []}),
    ]
    predicted = [H.dive_sql(m, "by_region", values) for values, _ in steps]
    assert len(set(predicted)) == len(predicted)
    assert "region IN ('North', 'East', 'West')" in predicted[0] and "BETWEEN DATE '2023-03-01' AND DATE '2023-09-30'" in predicted[1]
    assert "HAVING COUNT(*) >= 5" in predicted[2] and "revenue >= 100" in predicted[3] and "WHERE 1=1" in predicted[4]
    rep, _ = H.browser(board, actions=json.dumps([a | {"expectVega": 1} for _, a in steps]), extra_sql=tuple(predicted))
    assert rep["console_errors"] == [] and rep["alerts"] == []
    assert [v["input"] for v in rep["variables"]] == ["multiselect", "daterange", "number", "checkbox"]
    for (values, _), sql, step in zip(steps, predicted, rep["steps"]):
        assert step["alerts"] == [], step["alerts"]
        assert step["sql_log"][-1] == sql
        dct_rows = _rows(board, "region_table", values)
        dive_rows = step["table_rows"][0]
        assert [r[0] for r in dive_rows] == [r["region"] for r in dct_rows], values
        assert [int(r[1]) for r in dive_rows] == [int(r["orders"]) for r in dct_rows]
    assert rep["steps"][-1]["dive_state"] == {"regions": [], "period": ["2023-03-01", "2023-09-30"], "min_orders": 5, "large_only": True, "region_table_page": 1}


def test_drill_down_daterange_and_slider_slots():
    """drill-down.yml: the select keeps one variant per region, the daterange and the
    slider become typed slots; the Dive's SQL for a chosen range/threshold returns dct's rows
    for the same values (``filter_date_range`` -> ``CAST(col AS DATE) BETWEEN DATE .. AND DATE ..``)."""
    m = H.build(DRILL).manifest
    qv = m["query_variables"]["filtered_sales"]
    assert [d["kind"] for d in qv["dims"]] == ["value", "set", "set"]
    assert [c["input"] for c in m["board"]["variables"]] == ["select", "daterange", "slider"]
    values = {"region": "North", "date_range": ["2023-01-01", "2023-12-31"], "min_revenue": 100}
    sql = H.dive_sql(m, "filtered_sales", values)
    assert "region = 'North'" in sql and "BETWEEN DATE '2023-01-01' AND DATE '2023-12-31'" in sql and "HAVING SUM(revenue) >= 100" in sql
    got = H.normalize_rows(H.fetch_rows(sql))
    want = _rows(DRILL, "sales_table", values)
    assert got and H.as_multiset(got) == H.as_multiset(want)


@pytest.mark.parametrize(
    "branch",
    [
        "{% if min_orders != 2 %}HAVING COUNT(*) >= 2{% endif %}",
        # both probes (the default, and one far away) fall on the same side of this one, so
        # rendering twice cannot see it; the template says plainly that it reads the value.
        "{% if min_orders == 5 %}HAVING COUNT(*) >= 5{% endif %}",
        "{% if min_orders == 5 %}HAVING COUNT(*) >= 5{% else %}HAVING COUNT(*) >= 1{% endif %}",
    ],
)
def test_unsupported_jinja_falls_back_with_note(branch):
    """A query whose Jinja branches on a free value cannot be
    inlined: the two probe renders (the default and a far value) disagree, so the query keeps
    its default SQL and the Dive shows a note naming the variable. (A branch both probes land
    on the same side of — ``== 5`` with default 2 — is the documented blind spot.)"""
    src = (H.project_dir() / F["variables_multi.yml"]).read_text(encoding="utf-8")
    text = src.replace("HAVING COUNT(*) >= {{ min_orders }}", branch)
    board = H.FIXTURE_REL + "/branching_tmp.yml"
    (H.project_dir() / board).write_text(text, encoding="utf-8")
    try:
        m = H._dbt_charts_dive().build_dive_from_boards(H.project_dir(), [board]).manifest
    finally:
        (H.project_dir() / board).unlink()
    qv = m["query_variables"]["by_region"]
    assert "variants" not in qv and "branches on the value of min_orders" in qv["note"]
    assert m["board"]["variable_notes"] and "min_orders" in m["board"]["variable_notes"][0]
    assert H.dive_sql(m, "by_region", {"min_orders": 99}) == m["queries"]["by_region"]


def test_visible_and_enabled_conditions_pre_evaluated():
    """A layout ``visible: show_extra`` condition ships as a table over the checkbox's two
    values and hides its item until ticked; a variable's ``enabled`` condition arrives the
    same way (constant here)."""
    m = H.build(F["tabs_details.yml"]).manifest
    detail = m["board"]["layout"]["items"][1]["board"]["layout"]["items"]
    assert detail[2]["visible"] == {"dims": [{"key": "show_extra", "kind": "checkbox"}], "table": {"true": True, "false": False}, "default": False}
    assert "region_bar" not in H.chart_order(m) and "region_bar" in H.chart_order(m, values={"show_extra": True})
    assert "region_bar" in H.chart_order(m, tab=0)
    assert all(c["enabled"] is True for c in m["board"]["variables"])


# ── 3. drill-down links ─────────────────────────────────────────────────────────
@pytest.mark.browser
def test_links_equal_dct_hrefs_in_chromium():
    """``link:`` on a bar, a KPI, a table (row band) and a table column: the Dive carries
    the hrefs dct's SVG export carries for the same rows — on the bar marks as Vega's
    evaluated ``href`` (dct's own ``encoding.href``, minus its vl-convert sentinel; a click
    opens it in a new tab), on KPI / table cells as anchors (``{{ col }}`` /
    ``{{ col | urlencode }}`` resolved per row like dct's ``resolve_cell_link``)."""
    from dbt_charts.core.render.chart.table_support import resolve_cell_link

    board = F["links.yml"]
    m = H.build(board).manifest
    rep, _ = H.browser(board, actions=json.dumps([{"type": "clickMark", "chart": 0, "index": 0}, {"type": "clickMark", "chart": 0, "index": 1}]))
    assert rep["console_errors"] == [] and rep["alerts"] == []
    # bar: the href Vega evaluated per bar equals dct's <a href>, and clicking opens it in a new tab
    dct_bar = _dct_anchors(board, "category_bar")
    dive_bar = [h for h in rep["marks_hrefs"][0] if h]
    assert dive_bar == dct_bar == ["https://example.com/orders?category=Gadgets", "https://example.com/orders?category=Widgets"]
    assert [step["popup_url"] for step in rep["steps"]] == dct_bar
    calc = json.dumps(m["charts"]["category_bar"]["spec"])
    assert "dct.invalid" not in calc and "__df_href__" in calc
    # KPI: the card is the anchor; dct's SVG carries the raw template, resolved here per dct's rule
    items = H.dct_chart_items(board)
    kpi_row = items["total_kpi"]["data"][0]
    (dct_kpi,) = _dct_anchors(board, "total_kpi")
    assert rep["kpi_hrefs"] == [{"href": resolve_cell_link(dct_kpi, kpi_row, list(kpi_row)), "target": "_blank", "rel": "noopener noreferrer"}]
    assert rep["kpi_hrefs"][0]["href"] == "https://example.com/orders?scope=all+regions"
    # table: header link, per-cell column links and the whole-row band, in dct's order
    t = rep["table_links"][0]
    dct_table = _dct_anchors(board, "product_table")
    assert t["headers"] == [None, "https://example.com/categories", None]
    rows = items["product_table"]["data"]
    for r, cells, band, anchors in zip(rows, t["cells"], t["rows"], t["row_anchor_hrefs"], strict=True):
        assert band == resolve_cell_link(m["charts"]["product_table"]["link"], r, list(r)) and anchors == [band]
        assert [c and c["href"] for c in cells] == [None, resolve_cell_link("https://example.com/orders?category={{ product_category }}", r, list(r)), None]
        assert all(c is None or (c["target"] == "_blank" and c["rel"] == "noopener noreferrer") for c in cells)
    expected = ["https://example.com/categories"] + [h for r in rows for h in (resolve_cell_link(m["charts"]["product_table"]["link"], r, list(r)), f"https://example.com/orders?category={r['product_category']}")]
    assert dct_table == expected, "dct's own SVG anchors, the oracle for the table hrefs above"


def test_table_links_in_jsdom():
    """The same links resolved without a browser: cell, header and row-band anchors."""
    board = F["links.yml"]
    t = H.dom(board)["initial"]["tables"][0]
    assert t["header_links"] == [None, "https://example.com/categories", None]
    assert t["row_links"] == ["https://example.com/products?name=Gadget+Y", "https://example.com/products?name=Gadget+X", "https://example.com/products?name=Widget+B", "https://example.com/products?name=Widget+A"]
    assert [c[1] for c in t["cell_links"]] == ["https://example.com/orders?category=Gadgets"] * 2 + ["https://example.com/orders?category=Widgets"] * 2
    assert H.dom(board)["initial"]["kpis"][0]["href"] == "https://example.com/orders?scope=all+regions"


# ── 4. table pagination ─────────────────────────────────────────────────────────
@pytest.mark.browser
def test_pagination_page_3_shows_rows_11_to_12_in_chromium():
    """12 rows, page_rows 5: dct's paginator (``‹ 1 2 3 ›``, ``Rows 1–5 of 12``); clicking
    page 3 shows rows 11–12 with the label ``Rows 11–12 of 12``, page 2 rows 6–10; the page
    lives in the Dive state under dct's ``<chart>_page`` variable name."""
    board = F["table_paged.yml"]
    m = H.build(board).manifest
    rows = H.live_rows(board)[m["queries"]["customers"]]
    rep, _ = H.browser(board, actions=json.dumps([{"type": "page", "n": 3}, {"type": "page", "n": 2}]))
    assert rep["console_errors"] == []
    p = m["charts"]["paged"]["table"]["pagination"]
    assert p["page_rows"] == 5 and p["grow_cap"] == 2
    assert rep["pagers"] == [{"label": "Rows 1–5 of 12", "items": ["‹", "1", "2", "3", "›"], "current": "1", "clickable": ["2", "3", "2"]}]
    assert "Rows 1–5 of 12" in H.svg_groups(H.dct_svg(board))["paged"]["texts"]
    s3, s2 = rep["steps"]
    assert s3["pagers"][0]["label"] == "Rows 11–12 of 12" and s3["pagers"][0]["current"] == "3" and s3["tables"] == [2]
    assert [r[0] for r in s3["table_rows"][0]] == [str(r["customer_id"]) for r in rows[10:12]]
    assert s3["dive_state"]["paged_page"] == 3
    assert s2["pagers"][0]["label"] == "Rows 6–10 of 12" and [r[0] for r in s2["table_rows"][0]] == [str(r["customer_id"]) for r in rows[5:10]]


def test_pagination_window_and_grow_rule():
    """dct's paginator window on many pages (boundary 1, sibling 1, one ellipsis per gap)
    and the grow-by-2 rule, in jsdom: 7 rows with page_rows 5 draw on one page with no
    pager, exactly as dct's SVG does."""
    board = F["table_paged.yml"]
    out = H.dom(board, options=json.dumps({"clickPage": 3}))
    assert out["initial"]["tables"][0]["pager"] == {"label": "Rows 1–5 of 12", "items": ["‹", "1", "2", "3", "›"], "current": "1"}
    assert out["after_page"]["tables"][0]["pager"]["label"] == "Rows 11–12 of 12" and len(out["after_page"]["tables"][0]["rows"]) == 2
    grow = H.dom(F["table_grow.yml"])["initial"]["tables"][0]
    assert len(grow["rows"]) == 7 and grow["pager"] is None and grow["more"] == ""
    dct_texts = H.svg_groups(H.dct_svg(F["table_grow.yml"]))["grown"]["texts"]
    assert not any(t.startswith("Rows ") for t in dct_texts) and (len(dct_texts) - 1 - 3) // 3 == 7


# ── 5. tabs ─────────────────────────────────────────────────────────────────────
@pytest.mark.browser
def test_tabs_default_and_click_in_chromium():
    """``tabs: {id: view, default: Detail}``: the Dive opens on dct's default tab (slug
    ``detail``, active weight), the state key is dct's tab variable ``view``; clicking
    ``Overview`` swaps the content (bar chart in, KPIs out) and sets ``view=overview``."""
    board = F["tabs_details.yml"]
    m = H.build(board).manifest
    node = m["board"]["layout"]
    assert (node["type"], node["key"], node["slugs"], node["default"], node["position"]) == ("tabs", "view", ["overview", "detail"], 1, "top")
    rep, _ = H.browser(board, actions=json.dumps([{"type": "tab", "slug": "overview", "expectVega": 1}, {"type": "tab", "slug": "detail"}]))
    assert rep["console_errors"] == [] and rep["alerts"] == []
    T = m["style"]["tabs"]
    assert [(t["slug"], t["active"], t["weight"]) for t in rep["tabs"]] == [("overview", False, T["inactive_weight"]), ("detail", True, T["active_weight"])]
    assert rep["dive_state"]["view"] == "detail" and rep["kpi_values"] == ["11k", "100"] and rep["vega_svgs"] == 0
    texts = H.svg_groups(H.dct_svg(board))
    assert set(texts) == {"revenue_kpi", "orders_kpi"}, "dct renders only the default tab's charts"
    s1, s2 = rep["steps"]
    assert s1["dive_state"]["view"] == "overview" and s1["vega_svgs"] == 1 and s1["kpi_values"] == [] and [t["active"] for t in s1["tabs"]] == [True, False]
    assert s2["dive_state"]["view"] == "detail" and s2["vega_svgs"] == 0 and s2["kpi_values"] == ["11k", "100"]


def test_tabs_in_jsdom():
    board = F["tabs_details.yml"]
    out = H.dom(board, options=json.dumps({"clickTab": 0}))
    assert out["initial"]["tabs"] == ["Overview", "Detail"] and out["initial"]["active_tab"] == "detail"
    assert out["after_click"]["active_tab"] == "overview" and out["after_click"]["vega_charts"] == 1 and out["after_click"]["kpis"] == []


# ── 6. details ──────────────────────────────────────────────────────────────────
@pytest.mark.browser
def test_details_toggle_in_chromium():
    """``details: {summary, expanded_title, expanded: false}``: a collapsed summary bar
    (``▶ Show categories``, dct's own label); clicking expands it (``▼ Hide categories``),
    reveals the section's table and sets dct's hidden details variable to true."""
    board = F["tabs_details.yml"]
    rep, _ = H.browser(board, actions=json.dumps([{"type": "details", "index": 0}, {"type": "details", "index": 0}]))
    assert rep["details"] == [{"key": "_details_row1", "expanded": False, "summary": "▶Show categories"}] and rep["tables"] == []
    assert rep["dive_state"]["_details_row1"] is False
    assert "Show categories" in H.svg_groups(H.dct_svg(board)) or "Show categories" in H.dct_svg(board)
    s1, s2 = rep["steps"]
    assert s1["details"][0]["expanded"] is True and s1["details"][0]["summary"] == "▼Hide categories" and s1["tables"] == [2] and s1["dive_state"]["_details_row1"] is True
    assert s2["details"][0]["expanded"] is False and s2["tables"] == [] and s2["dive_state"]["_details_row1"] is False


def test_details_in_jsdom():
    board = F["tabs_details.yml"]
    m = H.build(board).manifest
    d = m["board"]["layout"]["items"][1]["board"]["layout"]["items"][1]["details"]
    assert d == {"key": "_details_row1", "summary": "Show categories", "expanded_summary": "Hide categories", "expanded": False}
    out = H.dom(board, options=json.dumps({"clickDetails": 0}))
    assert out["initial"]["details"][0]["expanded"] is False and out["initial"]["tables"] == []
    assert out["after_details"]["details"][0]["expanded"] is True and len(out["after_details"]["tables"]) == 1
