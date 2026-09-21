"""End-to-end: board YAML -> compiled Dive -> live SQL on MotherDuck -> rendered DOM,
compared with dbt Charts' own render of the same board.

Run against a dbt project that has dbt Charts boards (see README.md). Every test here asserts equalities against
one of three oracles: dbt-charts' JSON render (resolved chart semantics + the rows it
executed), its SVG/PNG export pinned to the Dive width, or its formatting functions.
"""

from __future__ import annotations

import json
import re

import harness as H
import pytest
from imgcompare import compare, compare_region

ALL = H.BOARDS + list(H.FIXTURE_BOARDS.values())
DCT_OK = [b for b in ALL if b not in H.DCT_FAILING_BOARDS]
F = H.FIXTURE_BOARDS
# dct's sizing pass vs the manifest: widths must agree to the pixel; heights may differ by
# the table shrink-to-content dct applies at render time (measured below, reported).
HEIGHT_TOL = 3.0


def _kind_ids(manifest: dict, kind: str) -> list[str]:
    return [cid for cid in H.chart_order(manifest) if manifest["charts"][cid]["kind"] == kind]


# ── 1. every board: structure of the rendered DOM ─────────────────────────────
@pytest.mark.parametrize("board", ALL)
def test_board_renders_every_chart(board):
    """Board -> Dive -> live rows -> DOM: one rendered piece per chart, in layout order,
    with tables showing exactly the rows the SQL returned (dct's first page: page_rows, or
    every row when they exceed it by at most 2) under the resolved header labels, nulls as
    the house em dash and nothing else blank."""
    m = H.build(board).manifest
    rep = H.dom(board)["initial"]
    rows_by_sql = H.live_rows(board)
    assert rep["skeletons"] == 0, "charts still loading after render"
    assert [c["kind"] for c in rep["charts"] if c["kind"] != "svg"] == H.expected_dom_kinds(m)
    assert len(rep["alerts"]) == len(_kind_ids(m, "unsupported"))
    assert len(rep["kpis"]) == len(_kind_ids(m, "kpi"))
    dom_tables = [c for c in rep["charts"] if c["kind"] == "table"]
    for dom_t, cid in zip(dom_tables, _kind_ids(m, "table"), strict=True):
        c = m["charts"][cid]
        rows = H.rows_for_chart(m, rows_by_sql, c)
        page = c["table"]["pagination"]
        want = H.rows_shown(len(rows), page)  # dct's first page, grow-by-2 included
        assert len(dom_t["rows"]) == want, f"{cid}: {len(dom_t['rows'])} DOM rows, SQL returned {len(rows)}, pagination={page}"
        assert dom_t["headers"] == [col["label"] for col in c["table"]["columns"]]
        assert dom_t["title"] == c["table"]["title"]
        for r, dom_row in zip(rows[:want], dom_t["rows"]):
            for col, cell in zip(c["table"]["columns"], dom_row, strict=True):
                if col.get("spark"):
                    continue  # the cell holds a drawn mark, not a string (test_spark_cells)
                assert (cell == "—") == (r[col["key"]] in (None, "")), f"{cid}.{col['key']}: {cell!r} for {r[col['key']]!r}"
                assert cell != ""


# ── 2. every board: the Dive's live rows are dct's rows ───────────────────────
@pytest.mark.parametrize("board", DCT_OK)
def test_live_sql_rows_equal_dct(board):
    """The SQL the Dive runs (refs resolved through target/manifest.json, variables and
    filter() rendered, dates cast in SQL) returns exactly the rows dbt-charts executed for
    the same chart — row for row, value for value. Inline ``values:`` snapshots too."""
    m = H.build(board).manifest
    rows_by_sql = H.live_rows(board)
    items = H.dct_chart_items(board)
    assert set(items) == set(m["charts"])
    for cid, item in items.items():
        c = m["charts"][cid]
        if c["kind"] in ("svg", "unsupported"):
            continue
        assert "_error" not in item, f"dct failed chart {cid}: {item.get('_error')}"
        got = H.normalize_rows(H.rows_for_chart(m, rows_by_sql, c))
        want = H.normalize_rows(item["data"])
        assert len(got) == len(want), f"{cid}: Dive SQL returned {len(got)} rows, dct executed {len(want)}"
        assert H.as_multiset(got) == H.as_multiset(want), f"{cid}: rows differ"
        # same order too, unless the SQL leaves ties for the engine to break
        if got != want:
            assert H.has_order_ties(want, m["queries"][c["query"]]) if c.get("query") else False, f"{cid}: row order differs without ORDER BY ties"


# ── 3. KPI text == dct's SVG text (and dct's format_kpi_parts) ────────────────
@pytest.mark.parametrize("board", DCT_OK)
def test_kpi_text_equals_dct(board):
    """Every KPI headline and label the Dive draws equals the <text> dct draws for that
    chart (SVG pinned to 880px), and equals ``format_kpi_parts`` run on dct's resolved
    format against the live value: narrative SI (``12mn``), currency lane, percent, exact
    digits below 1000, sub-unit fallback."""
    m = H.build(board).manifest
    kpi_ids = _kind_ids(m, "kpi")
    if not kpi_ids:
        pytest.skip("board has no KPI")
    rep = H.dom(board)["initial"]
    groups = H.svg_groups(H.dct_svg(board))
    items = H.dct_chart_items(board)
    rows_by_sql = H.live_rows(board)
    for cid, dom_kpi in zip(kpi_ids, rep["kpis"], strict=True):
        texts = groups[cid]["texts"]
        assert dom_kpi["value"] == texts[0], f"{cid}: Dive {dom_kpi['value']!r} vs dct {texts[0]!r}"
        label = m["charts"][cid]["kpi"]["layout"]["label_lines"]
        if label:
            assert dom_kpi["label"] == texts[1], f"{cid}: label"
            assert dom_kpi["label_lines"] == list(label)
        ch = items[cid]["chart"]
        row = H.rows_for_chart(m, rows_by_sql, m["charts"][cid])[0]
        expected = H.dct_kpi_text(row[ch["value"]], ch.get("format"), native=bool(ch.get("format_native")))
        assert dom_kpi["value"] == expected, f"{cid}: format_kpi_parts says {expected!r}"
        # the three lanes: a currency prefix is its own tspan, so is a magnitude/unit suffix
        assert "".join(dom_kpi["value_spans"]).replace(" ", "") == dom_kpi["value"].replace(" ", "")


def test_kpi_threshold_boundaries():
    """The synthetic board crosses every KPI formatting decision: both branches of
    ``finalize_kpi_value_format`` around 1000 (exact digits vs ``.2~s``), narrative
    k/mn/bn, the minus glyph, currency's sub-$1 fallback, percent, integer, number_full,
    currency_whole rounding, the analytic house register and a native d3 spec."""
    board = F["kpi_thresholds.yml"]
    m = H.build(board).manifest
    rep = H.dom(board)["initial"]
    values = {k["label"]: k["value"] for k in rep["kpis"]}
    expected = {
        "Below 1000 (Exact Digits)": "999",
        "At 1000 (Compact SI)": "1k",
        "1234.5 Unformatted": "1.2k",
        "Millions Narrative": "12mn",
        "Negative Compact": "−1.5k",
        "Billions Narrative": "2.5bn",
        "Currency Sub-Unit Fallback": "$0.42",
        "Currency Compact": "$1.23k",
        "Percent": "15.6%",
        "Integer": "12,345,678",
        "Number Full": "1,234.50",
        "Currency Whole": "$1,235",
        "Number (Analytic House)": "12.3mn",
        "Zero": "0",
        "Inline D3 Spec": "12M",
    }
    assert values == expected
    dct_values = {g["texts"][1]: g["texts"][0] for g in H.svg_groups(H.dct_svg(board)).values()}
    assert dct_values == expected
    # the plan carries both branches so the browser can pick per live value
    plan = m["charts"]["k_at"]["kpi"]["format"]
    assert plan["threshold"] == 1000 and plan["small"]["spec"] == "" and plan["spec"] == ".2~s"
    assert plan["si"]["M"] == "mn" and plan["si"]["G"] == "bn"
    assert m["charts"]["k_cents"]["kpi"]["format"]["sub_unit"] == {"floor": 0.005, "spec": ",.2f"}
    assert m["charts"]["k_pct"]["kpi"]["format"]["pct"] is True


# ── 4. table cells == dct's SVG text (and dct's cell formatter) ───────────────
@pytest.mark.parametrize("board", DCT_OK)
def test_table_cells_equal_dct(board):
    """For every table: title, header labels and each visible cell string equal the
    <text> dct draws, in the same order; and each cell equals dct's own numeric
    three-lane formatter / temporal formatter for that value and column format,
    including ``symbol_mode: anchors`` (currency prefix and % suffix on the first row only)."""
    m = H.build(board).manifest
    table_ids = _kind_ids(m, "table")
    if not table_ids:
        pytest.skip("board has no table")
    rep = H.dom(board)["initial"]
    groups = H.svg_groups(H.dct_svg(board))
    items = H.dct_chart_items(board)
    rows_by_sql = H.live_rows(board)
    dom_tables = [c for c in rep["charts"] if c["kind"] == "table"]
    for cid, dom_t in zip(table_ids, dom_tables, strict=True):
        c = m["charts"][cid]
        texts = groups[cid]["texts"]
        head = ([dom_t["title"]] if dom_t["title"] else []) + dom_t["headers"]
        assert texts[: len(head)] == head, f"{cid}: title/headers differ from dct's SVG"
        n = len(dom_t["headers"])
        if not dom_t["rows"]:
            assert texts[len(head) :] == ["No data"] and dom_t["empty"] == "No data", f"{cid}: empty-state placeholder"
            continue
        if any(col.get("spark") for col in c["table"]["columns"]):
            # A spark cell draws a mark rather than a string, so it contributes no <text>
            # and the rows no longer come n at a time — except a `value_visible` bar, whose
            # label sits inside the mark and is read by both sides. Compare what has text.
            assert texts[len(head) :] == [v for row in dom_t["rows"] for v in row if v != ""], f"{cid}: cell strings differ from dct's SVG"
            continue
        body = texts[len(head) : len(head) + n * len(dom_t["rows"])]
        dct_rows = [body[i : i + n] for i in range(0, len(body), n)]
        assert sorted(dct_rows) == sorted(dom_t["rows"]), f"{cid}: cell strings differ from dct's SVG"
        if dct_rows != dom_t["rows"]:  # same rows, other order: only legitimate when the SQL leaves ties
            assert H.has_order_ties(H.rows_for_chart(m, rows_by_sql, c), m["queries"][c["query"]]), f"{cid}: row order differs"
        tail = texts[len(head) + n * len(dom_t["rows"]) :]
        if dom_t["more"]:  # the Dive paginates: dct's paginator label comes next in its SVG
            assert tail and tail[0] == dom_t["more"], f"{cid}: dct tail {tail[:2]} vs {dom_t['more']!r}"
        else:
            assert not tail or tail[0] == "No data", f"{cid}: dct drew more than the Dive: {tail[:3]}"
        cols = c["table"]["columns"]
        dct_cols = items[cid]["chart"].get("columns") or {}
        for i, (r, dom_row) in enumerate(zip(H.rows_for_chart(m, rows_by_sql, c), dom_t["rows"])):
            for col, cell in zip(cols, dom_row, strict=True):
                if col["swatch"] or col.get("spark"):
                    continue
                fmt = (dct_cols.get(col["key"]) or {}).get("format")
                want = H.dct_table_cell(r[col["key"]], fmt, i, c["table"]["symbol_mode"])
                assert cell == want, f"{cid} row {i} {col['key']}: Dive {cell!r}, dct formatter {want!r}"


def test_table_page_rows_stripes_alignment_and_dates():
    """Synthetic paged table (12 rows, page_rows 5): the Dive shows dct's first page and
    dct's paginator (``Rows 1–5 of 12``, ``‹ 1 2 3 ›``); odd rows carry the theme stripe; numeric and date columns are
    right-aligned like dct's column verdicts, text left; DATE, TIMESTAMP and a custom
    strftime column format like dct (``%-d %b %Y`` default, ``%b %Y`` authored)."""
    board = F["table_paged.yml"]
    m = H.build(board).manifest
    t = H.dom(board)["initial"]["tables"][0]
    spec = m["charts"]["paged"]["table"]
    rows = H.live_rows(board)[m["queries"]["customers"]]
    assert len(rows) == 12 and spec["page_rows"] == 5 and spec["pagination"]["page_rows"] == 5
    assert len(t["rows"]) == 5 and t["more"] == "Rows 1–5 of 12" and t["pager"]["items"] == ["‹", "1", "2", "3", "›"]
    dct_texts = H.svg_groups(H.dct_svg(board))["paged"]["texts"]
    assert "Rows 1–5 of 12" in dct_texts, "dct paginates the same 5 rows"
    first, second = t["rows"][0], t["rows"][1]
    assert (first[0], first[1]) == (str(rows[0]["customer_id"]), str(rows[0]["orders"]))
    assert re.fullmatch(r"\$[\d,]+", first[2]), first[2]              # currency prefix, anchor row
    assert re.fullmatch(r"\d+\.\d%", first[3]), first[3]              # percent suffix, anchor row
    assert re.fullmatch(r"\d{1,2} \w{3} \d{4}", first[4]), first[4]   # DATE -> %-d %b %Y
    assert re.fullmatch(r"\d{1,2} \w{3} \d{4}", first[5]), first[5]   # TIMESTAMP -> the same
    assert re.fullmatch(r"\w{3} \d{4}", first[6]), first[6]           # authored %b %Y
    assert re.fullmatch(r"[\d,]+", second[2]) and re.fullmatch(r"\d+\.\d", second[3]), (
        "anchors: the $ and the % belong to the first row only")
    # stripes: theme colour on odd rows, none on even
    assert spec["row"]["stripe"]
    assert [bool(bg) for bg in t["row_background"]] == [False, True, False, True, False]
    assert all(H.css_color(bg) == H.css_color(spec["row"]["stripe"]) for bg in t["row_background"][1::2]), t["row_background"]
    # alignment: dct's resolved verdicts (right for date columns), numeric right, text left
    dct_cols = H.dct_chart_items(board)["paged"]["chart"]["columns"]
    for j, col in enumerate(spec["columns"]):
        verdict = dct_cols.get(col["key"], {}).get("align")
        numeric = isinstance(rows[0][col["key"]], (int, float))
        want = verdict or ("right" if numeric else "left")
        assert t["cell_align"][0][j] == want, f"{col['key']}: {t['cell_align'][0][j]} vs {want}"
        assert t["header_align"][j] == want
    # temporal decisions mirror is_temporal_value on the live values
    times = {c["key"]: c.get("time") for c in spec["columns"]}
    assert times == {"customer_id": None, "orders": None, "revenue": None, "share": None, "first_order": "%-d %b %Y", "last_seen": "%-d %b %Y", "cohort": "%b %Y"}
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}", rows[0]["first_order"]) and re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}", rows[0]["last_seen"])


def test_table_grow_by_two_rule():
    """dbt-charts' grow-by-2 rule (table.py ``_PAGINATION_GROW_CAP``): 7 rows with
    page_rows 5 exceed it by 2, so every row is drawn on one page with no paginator — in
    dct's SVG and in the Dive."""
    board = F["table_grow.yml"]
    t = H.dom(board)["initial"]["tables"][0]
    dct_texts = H.svg_groups(H.dct_svg(board))["grown"]["texts"]
    dct_rows = (len(dct_texts) - 1 - 3) // 3  # title + 3 headers, 3 cells per row
    assert dct_rows == 7
    assert len(t["rows"]) == dct_rows and t["pager"] is None and t["more"] == ""
    assert H.build(board).manifest["charts"]["grown"]["table"]["pagination"]["grow_cap"] == 2


# ── 5. pies: live geometry, carried labels, attached legend ───────────────────
@pytest.mark.parametrize("board", DCT_OK)
def test_pie_transforms_and_legend_equal_dct(board):
    """Pie specs are compiled against a snapshot but drawn from live rows: the spec carries
    the window/joinaggregate/calculate transforms that recompute dct's per-slice fields,
    empty ``data.values``, a lookup of the slice labels dct finalized; the attached legend
    table shows dct's exact share/label/value strings."""
    m = H.build(board).manifest
    pies = [cid for cid in H.chart_order(m) if m["charts"][cid]["type"] == "pie"]
    if not pies:
        pytest.skip("board has no pie")
    rep = H.dom(board)["initial"]
    groups = H.svg_groups(H.dct_svg(board))
    items = H.dct_chart_items(board)
    legends = iter([c for c in rep["charts"] if c["kind"] == "legend"])
    for cid in pies:
        c = m["charts"][cid]
        spec = c["spec"]
        assert spec["data"] == {"name": "dcd_rows"}  # the dataset the Dive fills
        ops = [list(t.keys())[0] for t in spec["transform"]]
        assert ops[:2] == ["window", "joinaggregate"] and ops.count("calculate") >= 5
        theta = items[cid]["chart"]["theta"]
        assert spec["transform"][0]["window"][1]["field"] == theta
        lookup = next((t for t in spec["transform"] if "lookup" in t), None)
        if lookup:
            assert lookup["lookup"] == items[cid]["chart"]["identity_field"]
            assert {v[lookup["lookup"]] for v in lookup["from"]["data"]["values"]} <= {r[lookup["lookup"]] for r in items[cid]["data"]}
        if not c.get("legend"):
            # no attached legend: dct labels the slices inside the wheel, and the Dive
            # computes that text from the live rows (the text itself is checked in Chromium)
            assert any(t.get("as") == "__dbt_label" for t in spec["transform"]), f"{cid}: slice labels must be live"
            continue
        dom_legend = next(legends)
        # legend rows: dct's SVG lists title, then share / label / value per slice
        cells = [cell for r in dom_legend["rows"] for cell in r if cell != ""]
        texts = groups[cid]["texts"]
        title = c["legend"]["table"]["title"] or items[cid]["chart"].get("title", "")
        expected = ([title] if title else []) + cells
        assert texts[: len(expected)] == expected, f"{cid}: legend text differs"
        assert len(dom_legend["rows"]) == len(items[cid]["data"])
        assert all(sw for r in dom_legend["swatches"] for sw in r), "each legend row carries its slice colour"


# ── 6. layout: grid tracks and slot sizes are dct's sizing pass ──────────────
@pytest.mark.parametrize("board", DCT_OK)
def test_layout_matches_dct_sizing(board):
    """dct's own SVG export of the board pinned to the Dive width reports every chart's
    slot (data-chart-width/height). The manifest's chart sizes equal them and each CSS
    grid band's fr tracks are exactly those widths — nested row boards and 24-column
    grids included. dct draws only the default tab, expanded details and visible items;
    that is exactly the set the Dive lays out at the defaults (``chart_order``)."""
    m = H.build(board).manifest
    svg = H.dct_svg(board)
    assert H.svg_root_size(svg)[0] == H.DIVE_WIDTH
    groups = H.svg_groups(svg)
    assert set(groups) == set(H.chart_order(m))
    height_diffs = {}
    for cid, g in groups.items():
        c = m["charts"][cid]
        assert abs(c["width"] - g["width"]) <= 1.0, f"{cid}: width {c['width']} vs dct {g['width']}"
        height_diffs[cid] = c["height"] - g["height"]
        if c["kind"] == "table":
            # dct reports a table's content height (it shrinks the card at render time);
            # the manifest keeps the slot from the sizing pass, which is what the Dive's
            # grid row gets. Content never exceeds the slot; they coincide unless a taller
            # sibling stretched the band.
            assert height_diffs[cid] >= -HEIGHT_TOL, f"{cid}: slot {c['height']} shorter than dct's table {g['height']}"
        else:
            assert abs(height_diffs[cid]) <= HEIGHT_TOL, f"{cid}: height {c['height']} vs dct {g['height']}"
    for node in H.cols_nodes(m["board"]):
        if all(it and "chart" in it and it["chart"] in groups for it in node["items"]):
            tracks = " ".join(f"{max(round(groups[it['chart']]['width']), 1)}fr" for it in node["items"])
            assert node["columns"] == tracks
    style = m["style"]
    assert style["page_padding"] > 0 and style["card_padding"] > 0
    print(f"{board}: max |height diff| = {max(abs(v) for v in height_diffs.values()):.1f}px")


# ── 7. a channel the author spelled a null into, and one that is simply wrong ─
@pytest.mark.parametrize("board", ["charts/general/analytics-dashboard.yml", "charts/variables/analytics-dashboard.yml"])
def test_a_hand_written_null_channel_still_draws(board):
    """``daily_trend`` says ``color: None``. YAML hands that over as the string, dct looks
    for a column of that name, and its own render fails at board level. The Dive reads it as
    the unset channel dct's validator already accepts: all ten charts draw, the line carries
    no colour encoding, and there is no error card."""
    m = H.build(board).manifest
    assert H.dct(board, "json").status != "ok", (
        "dct renders this board now — drop builder._read_spelled_nulls_as_unset?")
    assert [c["kind"] for c in m["charts"].values()].count("unsupported") == 0
    assert len(m["charts"]) == 10 and m["charts"]["daily_trend"]["kind"] == "vega"
    assert "color" not in m["charts"]["daily_trend"]["spec"]["encoding"]
    rep = H.dom(board)["initial"]
    assert rep["alerts"] == [] and rep["vega_charts"] == 7 and len(rep["kpis"]) == 3


def test_every_spelling_of_a_null_channel_is_read_as_unset():
    """``None``, ``nil`` and a quoted empty, one per family — with a real column beside them,
    so the assumption is shown to fire on a spelled null and nothing else."""
    board = F["spelled_nulls.yml"]
    m = H.build(board).manifest
    assert [c["kind"] for c in m["charts"].values()] == ["vega"] * 4
    for cid in ("python_none", "ruby_nil", "quoted_empty"):
        assert "color" not in m["charts"][cid]["spec"]["encoding"], cid
    assert m["charts"]["sized"]["spec"]["encoding"]["color"]["field"] == "region"
    assert H.dom(board)["initial"]["alerts"] == []


def test_a_channel_naming_a_missing_column_is_one_error_card():
    """Nothing can be assumed about a column that is not a null spelling and is not there,
    so this is what the error card is for: it carries dct's own message and the rest of the
    board still draws (``builder._tolerant_resolution``)."""
    board = F["bad_channel.yml"]
    m = H.build(board).manifest
    bad = m["charts"]["broken"]
    assert bad["kind"] == "unsupported" and "column 'no_such_column' not found" in bad["message"]
    assert m["charts"]["fine"]["kind"] == "vega"
    rep = H.dom(board)["initial"]
    assert rep["alerts"] == [bad["message"]] and rep["vega_charts"] == 1


# ── 8. inline values: snapshot, no SQL, no database ───────────────────────────
def test_inline_values_board_uses_snapshot():
    """A board whose queries are inline ``values:``/``rows:`` compiles with no SQL and no
    REQUIRED_DATABASES; charts carry a snapshot equal to dct's executed rows and render
    (table cells and KPI) exactly like dct."""
    board = F["inline_values.yml"]
    b = H.build(board)
    m = b.manifest
    assert m["queries"] == {} and b.required_resources == []
    rep = H.dom(board)["initial"]
    assert rep["required_databases"] == []
    items = H.dct_chart_items(board)
    for cid in m["charts"]:
        assert m["charts"][cid]["query"] is None
        assert H.normalize_rows(m["charts"][cid]["snapshot"]) == H.normalize_rows(items[cid]["data"])
    groups = H.svg_groups(H.dct_svg(board))
    t = rep["tables"][0]
    assert [t["title"]] + t["headers"] + [c for r in t["rows"] for c in r] == groups["score_table"]["texts"]
    assert t["rows"][0] == ["Alice", "92.4", "5 Jan 2024"]
    assert rep["kpis"][0]["value"] == groups["total_kpi"]["texts"][0] == "258.40"
    assert rep["vega_charts"] == 1 and m["charts"]["score_bar"]["spec"]["data"] == {"name": "dcd_rows"}


# ── 9. REQUIRED_DATABASES derived from the SQL ────────────────────────────────
@pytest.mark.parametrize("board", ALL)
def test_required_databases_derived_from_sql(board):
    """REQUIRED_DATABASES names exactly the MotherDuck databases the Dive's SQL touches:
    every ``"db"."schema"."table"`` dct resolved a ref to, plus the source database for
    tables named without ref() (``main.orders``), which the SQL is qualified with so it
    runs on a connection whose default catalog is not that database."""
    b = H.build(board)
    m = b.manifest
    sqls = list(m["queries"].values())
    qualified = {mm for sql in sqls for mm in re.findall(r'(?<![\w."])"?(\w+)"?\.(?:"\w+"|\w+)\.(?:"\w+"|\w+)', sql)}
    declared = {r["name"] for r in b.required_resources}
    reads_tables = any(re.search(r"\b(FROM|JOIN)\s+(?!\(|VALUES\b)", sql, re.I) and re.search(r"\bfct_orders\b|\borders\b|\bproducts\b|\bcustomers\b", sql) for sql in sqls)
    assert declared == ({"dbt_charts_examples"} if reads_tables else set()), (declared, reads_tables)
    assert qualified == declared
    for sql in sqls:
        assert re.search(r"(?<![\w.])main\.\w+", sql) is None, "unqualified schema.table left in SQL"
        assert "{{" not in sql and "{%" not in sql
    assert H.dom(board)["initial"]["required_databases"] == [{"type": "database", "path": f"md:{d}", "alias": d} for d in sorted(declared)]
    assert b.required_resources == [{"name": d, "alias": d, "url": f"md:{d}", "resource_type": "database"} for d in sorted(declared)]


# ── 10. variables rendered with their defaults ────────────────────────────────
def test_variables_rendered_with_defaults():
    """Jinja variables and the filter()/filter_date_range() helpers are rendered into
    literal SQL with the board defaults, exactly as dct does for its default render:
    ``filter(col, None)`` -> ``1=1``, a date range -> two literals, a number default
    inlined; the rows then equal dct's (test_live_sql_rows_equal_dct) — checked again here
    for the variable boards specifically."""
    sales = H.build("charts/sales_dashboard.yml").manifest["queries"]
    assert all("1=1" in sql and "{{" not in sql for sql in sales.values()), sales
    product = H.build("charts/product_performance.yml").manifest["queries"]
    assert "1=1" in product["product_summary"] and "{{" not in product["top_products"]
    drill = H.build("charts/variables/drill-down.yml").manifest["queries"]["filtered_sales"]
    assert "'2024-01-01'" in drill and "'2024-12-31'" in drill and re.search(r"HAVING SUM\(revenue\) >= 10000\b", drill)
    assert "1=1" in drill  # region unset -> no-op filter
    analytics = H.build("charts/general/analytics-dashboard.yml").manifest["queries"]["kpi_metrics"]
    assert "'2023-01-01'" in analytics and "'2023-12-31'" in analytics and "{%" not in analytics
    for board in ("charts/sales_dashboard.yml", "charts/product_performance.yml", "charts/variables/drill-down.yml"):
        m = H.build(board).manifest
        rows_by_sql = H.live_rows(board)
        for cid, item in H.dct_chart_items(board).items():
            assert H.as_multiset(H.normalize_rows(H.rows_for_chart(m, rows_by_sql, m["charts"][cid]))) == H.as_multiset(H.normalize_rows(item["data"])), f"{board} {cid}"


def test_empty_table_is_faithful_not_a_bug():
    """drill-down's ``sales_table``: the default filters (min_revenue 10000 on 2024 data)
    legitimately return no rows in dct too. The Dive draws the header with zero body rows
    and no error — the case that was recently mistaken for a bug."""
    board = "charts/variables/drill-down.yml"
    m = H.build(board).manifest
    item = H.dct_chart_items(board)["sales_table"]
    rows = H.live_rows(board)[m["queries"]["filtered_sales"]]
    assert item["data"] == [] and rows == []
    rep = H.dom(board)["initial"]
    t = rep["tables"][0]
    assert t["rows"] == [] and t["headers"] == [c["label"] for c in m["charts"]["sales_table"]["table"]["columns"]]
    assert rep["alerts"] == [] and rep["vega_charts"] == 2
    assert "No data" in H.svg_groups(H.dct_svg(board))["sales_table"]["texts"]


# ── 11. fonts embedded ────────────────────────────────────────────────────────
@pytest.mark.parametrize("board", ["charts/customer_analytics.yml", "charts/dashboards/themed-dashboard.yml", F["kpi_thresholds.yml"]])
def test_fonts_embedded(board):
    """The Dive injects dct's offline @font-face block (data: URIs) and it covers every
    family the manifest's fonts name — KPI value/label, table, board font — so text is
    measured and drawn with the faces dct laid out for."""
    m = H.build(board).manifest
    rep = H.dom(board)["initial"]
    fonts = rep["fonts"]
    assert fonts["font_faces"] >= len(m["fonts"]["families"]) and fonts["data_uris"] == fonts["font_faces"]
    assert set(m["fonts"]["families"]) <= set(fonts["families"])

    def first(family: str) -> str:
        return family.split(",")[0].strip().strip("'\"")

    used = {first(m["style"]["font"]["family"])}
    for c in m["charts"].values():
        if c["kind"] == "kpi":
            used |= {first(c["kpi"]["value_font"]), first(c["kpi"]["body_font"]), first(c["kpi"]["layout"]["label_font_family"])}
        if c["kind"] == "table":
            used |= {first(c["table"]["font"]["family"]), first(c["table"]["title_font"]["family"]), c["table"]["numeric_font"]}
    assert used <= set(fonts["families"]), used - set(fonts["families"])


# ── 12. tabs: several boards in one Dive ──────────────────────────────────────
def test_tabs_for_multi_board_build():
    """Two boards compile into one Dive with a tabs layout: the tab bar names the boards,
    the first tab shows the first board's charts, clicking the second swaps in the second
    board's (its KPIs, its chart count), each board keeping its own dct sizing."""
    boards = ("charts/customer_analytics.yml", "charts/general/executive_summary.yml")
    b = H.build(*boards)
    m = b.manifest
    assert m["board"]["layout"]["type"] == "tabs" and m["board"]["layout"]["titles"] == ["Customer Analytics", "Executive Summary"]
    assert all(cid.split(".")[0] in ("customer_analytics", "executive_summary") for cid in m["charts"])
    out = H.dom(*boards, options=json.dumps({"clickTab": 1}))
    first, second = out["initial"], out["after_click"]
    assert first["tabs"] == ["Customer Analytics", "Executive Summary"]
    assert [k["label"] for k in first["kpis"]] == ["Total Customers", "Avg Customer Value", "Avg Order Value"] and first["vega_charts"] == 4
    assert [k["label"] for k in second["kpis"]] == ["Total Revenue", "Total Orders"] and second["vega_charts"] == 0 and second["tables"] == []
    single = H.build("charts/general/executive_summary.yml").manifest
    for cid, c in single["charts"].items():
        assert (m["charts"]["executive_summary." + cid]["width"], m["charts"]["executive_summary." + cid]["height"]) == (c["width"], c["height"])


# ── 13. the real thing: headless Chromium, real Vega, screenshot vs dct PNG ───
VISUAL_BOARDS = [
    "charts/general/executive_summary.yml",
    "charts/general/kpi-dashboard.yml",
    "charts/general/marketing_dashboard.yml",
    "charts/general/sales_dashboard.yml",
    "charts/dashboards/themed-dashboard.yml",
    "charts/customer_analytics.yml",
    "charts/product_performance.yml",
    H.FIXTURE_BOARDS["chart_types.yml"],  # one card of every family the Dive can draw
]
# Per-chart SSIM between the Dive's card (Chromium screenshot) and dct's card (its PNG export
# at the same width), both crops scaled to 200px wide. The cards have the same size (dct's
# sizing pass), so this compares what is drawn in them and ignores the vertical drift
# between cards (the Dive's flex gaps vs dct's absolute layout, dct's variables bar).
# Measured on the example boards: KPI cards 0.97–0.995, Vega charts 0.91–0.997 (pies
# 0.80–0.85: in-wheel labels/legend typography), tables 0.33–0.60 (the HTML table lays
# columns out itself; dct packs measured lanes). Different rasterizers (Chromium vs
# vl-convert/resvg) and text antialiasing keep even identical cards below 1.0; a card
# compared with another same-sized card of the board scores ~0.3–0.6 (the rival check).
CARD_SSIM_FLOOR = {"kpi": 0.9, "spark_bar": 0.9, "vega": 0.75, "table": 0.3}
# The pie family scores lower than the rest of the Vega families: what differs is the
# typography of the labels inside the wheel, and a donut leaves more label per drawn pixel
# than a pie does (pie 0.74, donut 0.69 on the chart-types board). The floor sits below both
# with room to spare, because the labels reflow whenever the slice proportions change and
# the demo data is regenerated from time to time. A pie drawing the wrong thing scores far
# lower than this — the rival check below puts a mismatched card at 0.3 to 0.6.
TYPE_SSIM_FLOOR = {"pie": 0.6}
BOARD_SSIM_FLOOR = 0.8


@pytest.mark.browser
@pytest.mark.parametrize("board", VISUAL_BOARDS)
def test_visual_similarity_in_chromium(board, record_property):
    """The generated Dive in headless Chromium with its real Vega bundle and the live rows:
    every Vega chart draws, KPI values match dct, every dct chart title is on the page;
    each chart card, cropped from the 880px screenshot, scores SSIM against the same card
    cropped from dct's PNG export at 880px above its kind's floor (KPI 0.9, Vega 0.75,
    table 0.3; board mean 0.8) and beats the score against any other same-sized card."""
    rep, png = H.browser(board)
    m = H.build(board).manifest
    n_vega = sum(1 for c in m["charts"].values() if c["kind"] == "vega")
    assert rep["alerts"] == [] and rep["console_errors"] == [], rep["console_errors"]
    assert rep["vega_svgs"] == n_vega
    groups = H.svg_groups(H.dct_svg(board))
    assert sum(g["vega_svgs"] for g in groups.values()) == n_vega
    for cid, g in groups.items():
        # the families the Dive draws as SVG put their title in an SVG <text>, which is not
        # page text; their titles are compared in test_spark_bar.py / test_kpi_text_equals_dct
        if m["charts"][cid]["kind"] not in ("kpi", "spark_bar") and g["title"]:
            assert g["title"] in rep["body_text"], f"{cid}: title {g['title']!r} missing from the page"
    kpi_ids = _kind_ids(m, "kpi")
    assert rep["kpi_values"][: len(kpi_ids)] == [groups[cid]["texts"][0] for cid in kpi_ids]
    # every embedded face is declared to the page; the text faces are actually loaded (the
    # emoji fallback only loads when a glyph needs it)
    assert set(m["fonts"]["families"]) <= set(rep["fonts_declared"]), set(m["fonts"]["families"]) - set(rep["fonts_declared"])
    assert set(m["fonts"]["families"]) - {"Noto Emoji"} <= set(rep["fonts_loaded"]), set(m["fonts"]["families"]) - set(rep["fonts_loaded"])
    # per-chart cards: the Dive's boxes (DOM order == layout order) vs dct's boxes by id
    dct_boxes = H.dct_chart_boxes(H.dct_svg(board))
    dct_png = H.dct_png(board)
    ids = [cid for cid in H.chart_order(m) if m["charts"][cid]["kind"] != "svg"]
    assert len(rep["chart_boxes"]) == len(ids), (len(rep["chart_boxes"]), ids)
    scores = {}
    for cid, box in zip(ids, rep["chart_boxes"]):
        dive_box = (box["x"], box["y"], box["w"], box["h"])
        assert abs(box["w"] - dct_boxes[cid][2]) <= 2, f"{cid}: card width {box['w']} vs dct {dct_boxes[cid][2]}"
        scores[cid] = compare_region(png, dive_box, dct_png, dct_boxes[cid])
    page = compare(png, dct_png, crop_bottom=12)
    mean_ssim = sum(v["ssim"] for v in scores.values()) / len(scores)
    record_property("card_ssim", {k: round(v["ssim"], 3) for k, v in scores.items()})
    record_property("board_mean_ssim", round(mean_ssim, 3))
    record_property("page_ssim", round(page["ssim"], 3))
    print(f"\n{board}: mean card ssim={mean_ssim:.3f} page ssim={page['ssim']:.3f} height_ratio={page['height_ratio']:.3f}")
    for cid, v in scores.items():
        print(f"    {cid:<28} ssim={v['ssim']:.3f} ndiff={v['ndiff']:.3f}")
    # control: a card must look more like its own dct card than like any other card of
    # the same kind and size in this board
    for cid, box in zip(ids, rep["chart_boxes"]):
        rivals = [o for o in ids if o != cid and m["charts"][o]["kind"] == m["charts"][cid]["kind"] and abs(dct_boxes[o][2] - dct_boxes[cid][2]) < 2 and abs(dct_boxes[o][3] - dct_boxes[cid][3]) < 2]
        for o in rivals:
            rival = compare_region(png, (box["x"], box["y"], box["w"], box["h"]), dct_png, dct_boxes[o])["ssim"]
            assert scores[cid]["ssim"] > rival, f"{cid} looks more like dct's {o} ({rival:.3f}) than like itself ({scores[cid]['ssim']:.3f})"
    for cid, v in scores.items():
        floor = TYPE_SSIM_FLOOR.get(m["charts"][cid]["type"], CARD_SSIM_FLOOR[m["charts"][cid]["kind"]])
        assert v["ssim"] >= floor, f"{cid} ({m['charts'][cid]['type']}): card ssim {v['ssim']:.3f} < {floor}"
    assert mean_ssim >= BOARD_SSIM_FLOOR


@pytest.mark.browser
def test_numeric_cells_use_dct_tabular_font_in_chromium():
    """Number cells are set in the tabular-figures face dct picks for numbers
    (``_table_numeric_cell_font``), text and date cells in the table face — checked on
    computed styles in Chromium (jsdom drops unquoted multi-word font-family values)."""
    board = F["table_paged.yml"]
    rep, _ = H.browser(board)
    spec = H.build(board).manifest["charts"]["paged"]["table"]
    fonts = rep["table_cell_fonts"][0]
    assert all(spec["numeric_font"] in f for f in fonts[:4]), fonts
    assert all(spec["numeric_font"] not in f and spec["font"]["family"].split(",")[0].strip("'\"") in f for f in fonts[4:]), fonts
    # alignment in Chromium == alignment in jsdom (itself checked against dct's verdicts above)
    assert rep["table_cell_align"][0] == H.dom(board)["initial"]["tables"][0]["cell_align"][0]


@pytest.mark.browser
@pytest.mark.parametrize("board", ["charts/customer_analytics.yml", "charts/product_performance.yml", "charts/dashboards/themed-dashboard.yml"])
def test_pie_slices_recomputed_live_in_chromium(board):
    """With the real Vega runtime the pie's live transforms must produce one arc per SQL row
    with the slice angles dct baked from its snapshot (same rows, so same angles) and the
    slice labels dct finalized; a legend-carrying wheel (no in-wheel labels) matches dct's
    <path d> set to the pixel after rounding."""
    rep, _ = H.browser(board)
    m = H.build(board).manifest
    vega_ids = _kind_ids(m, "vega")
    pies = [cid for cid in vega_ids if m["charts"][cid]["type"] == "pie"]
    assert pies
    svg = H.dct_svg(board)
    import xml.etree.ElementTree as ET

    root = ET.fromstring(svg)
    for cid in pies:
        idx = vega_ids.index(cid)
        dive_arcs = rep["marks_paths"][idx]
        group = next(g for g in root.iter() if g.get("data-chart-id") == cid)
        marks = next(e for e in group.iter(H.SVG_NS + "svg") if (e.get("class") or "") == "marks")
        dct_arcs = [p.get("d") for p in marks.iter(H.SVG_NS + "path") if p.get("d", "").startswith("M") and "A" in p.get("d", "")]
        n_rows = len(H.dct_chart_items(board)[cid]["data"])
        rnd = lambda d: re.sub(r"-?\d+(\.\d+)?", lambda mm: str(round(float(mm.group(0)))), d)  # noqa: E731
        assert len(dive_arcs) == len(dct_arcs) == n_rows, f"{cid}: {len(dive_arcs)} live arcs, dct {len(dct_arcs)}, rows {n_rows}"
        # slice angles are the live transforms' work; the wheel radius follows the fitted
        # plot (label/title measurement differs between vl-convert and Chromium)
        dive_ang, dct_ang = sorted(map(H.arc_angles, dive_arcs)), sorted(map(H.arc_angles, dct_arcs))
        assert all(a[2] == b[2] and max(abs(a[0] - b[0]), abs(a[1] - b[1])) <= 1 for a, b in zip(dive_ang, dct_ang)), f"{cid}: slice angles differ: {dive_ang} vs {dct_ang}"
        if m["charts"][cid].get("legend"):
            assert sorted(map(rnd, dive_arcs)) == sorted(map(rnd, dct_arcs)), f"{cid}: arc geometry differs"
        # slice labels (Jinja templates dct evaluated per snapshot row, carried by slice key)
        dct_labels = sorted(t for t in ["".join(x.itertext()).strip() for x in marks.iter(H.SVG_NS + "text")] if t)
        assert sorted(rep["marks_texts"][idx]) == dct_labels, f"{cid}: slice labels differ"


def _base_tables(sql: str) -> list[dict]:
    """Every base table DuckDB's own parser finds in ``sql``."""
    import duckdb

    ast = json.loads(duckdb.connect().execute("SELECT json_serialize_sql(?::VARCHAR)", [sql]).fetchone()[0])
    found: list[dict] = []

    def walk(node):
        if isinstance(node, dict):
            if node.get("type") == "BASE_TABLE":
                found.append(node)
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for x in node:
                walk(x)

    walk(ast)
    return found


def test_every_table_is_qualified_even_next_to_a_ref():
    """A Dive attaches the databases it declares and defaults to none of them, so a table
    named without a database resolves nowhere. One qualified relation in the query used to
    turn the qualification off for all of them."""
    board = H.FIXTURE_BOARDS["mixed_relations.yml"]
    b = H.build(board)
    sql = b.manifest["queries"]["mixed"]
    unqualified = [t["table_name"] for t in _base_tables(sql) if not t.get("catalog_name")]
    assert unqualified == [], sql
    assert {r["alias"] for r in b.required_resources} == {"dbt_charts_examples"}
    assert H.fetch_rows(sql)


def _pie_charts(manifest):
    return {cid: c for cid, c in manifest["charts"].items() if c.get("kind") == "vega" and any(
        "arc" in json.dumps(layer.get("mark")) for layer in c["spec"].get("layer", []))}


@pytest.mark.parametrize("board", ["charts/product_performance.yml"])
def test_pie_labels_are_computed_from_the_live_rows(board):
    """dct evaluates each slice's label template in Python, so its text carries the
    percentage of the rows it compiled against. Shipping that text would put build-time
    percentages next to live slices."""
    pies = _pie_charts(H.build(board).manifest)
    assert pies
    for cid, c in pies.items():
        transforms = c["spec"].get("transform") or []
        frozen = [t for t in transforms if "lookup" in t and "__dbt_label" in json.dumps(t)]
        assert frozen == [], f"{cid} carries its labels as data"
        computed = [t for t in transforms if t.get("as") == "__dbt_label"]
        assert len(computed) == 1 and "__dbt_pct" in computed[0]["calculate"], cid


def test_kpi_colours_follow_the_live_value():
    """dct resolves a KPI's conditional rules once, against the rows it compiled. The card
    is drawn from whatever the query returns when the Dive is opened, so the rules have to
    travel with it — and resolve to dct's own answer for dct's own rows."""
    board = H.FIXTURE_BOARDS["kpi_conditional.yml"]
    m = H.build(board).manifest
    k = m["charts"]["k_rev"]["kpi"]
    assert k["channels"] and {ch["field"] for ch in k["channels"]} == {"revenue"}
    fills = {json.dumps(case["colors"], sort_keys=True) for case in k["cases"].values()}
    assert len(fills) > 1, "every case resolves to the same colours"
    row = H.fetch_rows(m["queries"]["totals"])[0]
    assert k["cases"][H.kpi_case(k, row)]["colors"] == k["colors"]
    # and the same for a rule that names its values rather than comparing them
    by_name = m["charts"]["k_region"]["kpi"]
    assert by_name["cases"][H.kpi_case(by_name, row)]["colors"] == by_name["colors"]
    assert H.dom(board)["initial"]["kpis"][0]["value_fill"] == k["colors"]["value_fill"]
    # and when the number moves past the rule, so does the card
    other = next(case for key, case in k["cases"].items() if key != H.kpi_case(k, row))
    moved = H.dom_with_rows(board, lambda rs: [{**r, "revenue": 1} for r in rs])
    assert moved["initial"]["kpis"][0]["value_fill"] == other["colors"]["value_fill"]


def test_numbers_a_double_cannot_hold_stay_exact():
    """dct carries Python ints and Decimals to its formatter, so its cells are exact. A
    DECIMAL widened to DOUBLE, or an id past 2^53 turned into a JS number, is a different
    number on screen and in the link."""
    board = H.FIXTURE_BOARDS["exact_numbers.yml"]
    m = H.build(board).manifest
    sql = m["queries"]["exact"]
    assert "AS DOUBLE" not in sql, sql
    row = H.fetch_rows(sql)[0]
    assert row == {"order_id": "9007199254740993", "amount": "123456789012345678.90123456789", "ordinary": "1.5"}
    # what the cell *says* is dct's answer (test_table_cells_equal_dct); what the link
    # carries is the number the warehouse has, not the nearest double to it
    assert H.dom(board)["initial"]["tables"][0]["cell_links"][0][0] == "https://example.com/orders/9007199254740993"


def test_a_tab_group_keeps_the_same_state_key_every_run():
    """A viewer's open tab is kept in Dive state under the group's key. dct names an
    anonymous group after the board and row; where it does not, the key was Python's
    `id()` of the layout object — a different group, or none, after the next publish."""
    board = H.FIXTURE_BOARDS["anonymous_tabs.yml"]
    keys = _tab_keys(H.build(board).manifest["board"])
    H.build.cache_clear()
    assert keys == _tab_keys(H.build(board).manifest["board"])
    assert len(set(keys)) == 2, keys
    assert not any(re.search(r"\d{9,}", k) for k in keys), keys  # never a Python object's address


def _tab_keys(node: dict) -> list[str]:
    found = []

    def walk(layout: dict) -> None:
        if layout.get("type") == "tabs":
            found.append(layout["key"])
        for item in layout.get("items") or []:
            if item and "board" in item:
                walk(item["board"]["layout"])

    walk(node["layout"])
    return found


def test_a_board_that_names_a_template_placeholder_is_not_spliced():
    """The generated Dive is one template with four placeholders filled in. Filling them one
    after another means a value can contain the next one — a board titled
    `__VEGA_BUNDLE_B64__` had the whole Vega runtime pasted into its manifest."""
    board = H.FIXTURE_BOARDS["placeholder_title.yml"]
    b = H.build(board)
    assert b.manifest["title"] == "__VEGA_BUNDLE_B64__ __MANIFEST_JSON__"
    # the only place that text survives is the manifest's title; the runtime was filled in
    # once, where the template asks for it
    assert b.content.count("__VEGA_BUNDLE_B64__") == 1
    assert '"title": "__VEGA_BUNDLE_B64__ __MANIFEST_JSON__"' in b.content


def test_a_chart_that_fails_keeps_the_rows_it_would_have_drawn(monkeypatch):
    """A chart with no live SQL carries dct's own rows; if compiling the card then fails, the
    error card is all the Dive has — losing the rows loses what the board was showing."""
    from dbt_charts_dive import presentation

    board = H.FIXTURE_BOARDS["inline_values.yml"]
    H.build.cache_clear()
    monkeypatch.setattr(presentation, "table_presentation", lambda *a, **k: 1 / 0)
    try:
        m = H.build(board).manifest
    finally:
        H.build.cache_clear()
    table = next(c for c in m["charts"].values() if c["type"] == "table")
    assert table["kind"] == "unsupported" and table["snapshot"], table
