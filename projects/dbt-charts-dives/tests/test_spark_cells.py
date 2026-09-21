"""In-cell sparklines, drawn twice: by dbt Charts in Python and by the Dive in the browser.

``render/chart/spark.py`` draws six marks straight into a table cell — ``line``, ``area``,
``bar``, ``bar-normalize``, ``column`` and ``columns`` — as SVG, against the rows dct
queried at build time. Like the spark bar card, none of it is Vega, so a Dive cannot ship
dct's output and stay live: ``template.tsx`` draws the same six marks from the rows the
browser fetched. These tests hold the two outputs against each other, primitive by
primitive, for every cell of every column of three boards.
"""

from __future__ import annotations

import re
import xml.etree.ElementTree as ET

import harness as H
import pytest

CELLS = H.FIXTURE_BOARDS["spark_cells.yml"]      # line / area / columns, over arrays
MARKS = H.FIXTURE_BOARDS["spark_marks.yml"]      # bar / bar-normalize / column, all positive
SIGNED = H.FIXTURE_BOARDS["spark_signed.yml"]    # the same three around a midline
LABELS = H.FIXTURE_BOARDS["spark_labels.yml"]    # the numbers a `value_visible` bar prints
ODD = H.FIXTURE_BOARDS["spark_odd.yml"]          # cells a single-value mark cannot read
PLACES = 3  # dct writes a coordinate to one decimal; agree well past that

NUMERIC = ("x", "y", "width", "height", "rx", "x1", "y1", "x2", "y2", "cx", "cy", "r", "fill-opacity", "stroke-width", "font-size")
LITERAL = ("fill", "stroke", "stroke-dasharray", "stroke-linecap", "stroke-linejoin", "text-anchor", "dominant-baseline", "font-family", "text")
PRIMITIVES = {H.SVG_NS + tag for tag in ("rect", "line", "polyline", "polygon", "circle", "text")}


def _points(value: str | None) -> list[tuple[float, float]] | None:
    if value is None:
        return None
    return [(float(x), float(y)) for x, y in (pair.split(",") for pair in value.split())]


def _shape(tag: str, attr, text: str | None) -> dict:
    """One drawn primitive, as numbers and strings rather than as the markup around them."""
    out: dict = {"tag": tag}
    for name in NUMERIC:
        raw = attr(name)
        out[name] = None if raw is None else float(raw)
    for name in LITERAL:
        out[name] = attr(name)
    out["points"] = _points(attr("points"))
    if text is not None:
        out["text"] = text
    return out


def _by_column(marks: list[tuple[float, list[dict]]]) -> list[list[list[dict]]]:
    """Marks grouped into table columns, left to right, each column's cells in row order.

    A mark with nothing to draw leaves no element behind on either side — a zero-width
    ``bar`` is a cell with no mark, not an empty box — so the grid has holes and the cells
    cannot simply be dealt out round-robin.
    """
    lanes: dict[float, list[list[dict]]] = {}
    for lane, shapes in marks:
        lanes.setdefault(lane, []).append(shapes)
    return [lanes[lane] for lane in sorted(lanes)]


def _dct_marks(board: str) -> list[list[list[dict]]]:
    """Every spark mark dct drew in this board's table, by column.

    A cell's mark is a ``<g transform="translate(…)">`` holding the inner SVG
    ``_render_spark_cell`` cut out of ``render_spark``'s wrapper — so the group's children
    are exactly the primitives, nothing else in the table nests a group inside one, and the
    translate's x is the cell's lane, the same for every row of a column.
    """
    root = ET.fromstring(H.dct_svg(board))
    marks = []
    for g in root.iter(H.SVG_NS + "g"):
        transform = g.get("transform") or ""
        if not transform.startswith("translate"):
            continue
        children = list(g)
        if not children or any(child.tag not in PRIMITIVES for child in children):
            continue
        lane = float(re.findall(r"-?[\d.]+", transform)[0])
        marks.append((lane, [_shape(c.tag.removeprefix(H.SVG_NS), c.get, "".join(c.itertext()) if c.tag == H.SVG_NS + "text" else None) for c in children]))
    return _by_column(marks)


def _dive_marks(board: str, rows=None) -> list[list[list[dict]]]:
    """The same marks as the Dive draws them, out of the rendered DOM."""
    report = H.dom(board) if rows is None else H.dom_with_rows(board, rows)
    tables = [c for c in report["initial"]["charts"] if c["kind"] == "table"]
    assert len(tables) == 1, f"{board}: expected one table"
    return _by_column([(cell["col"], [_shape(s["tag"], s.get, s.get("text")) for s in cell["shapes"]]) for cell in tables[0]["cell_sparks"]])


def _same(dive: list[list[dict]], dct: list[list[dict]], where: str) -> None:
    assert len(dive) == len(dct), f"{where}: {len(dive)} cells drawn, dct drew {len(dct)}"
    for cell, (got_cell, want_cell) in enumerate(zip(dive, dct, strict=True)):
        assert [s["tag"] for s in got_cell] == [s["tag"] for s in want_cell], f"{where} cell {cell}: shapes"
        for i, (got, want) in enumerate(zip(got_cell, want_cell, strict=True)):
            at = f"{where} cell {cell} {got['tag']} {i}"
            for name in NUMERIC:
                if got[name] is None or want[name] is None:
                    assert (got[name] is None) == (want[name] is None), f"{at} {name}: {got[name]} vs dct {want[name]}"
                else:
                    assert round(got[name] - want[name], PLACES) == 0, f"{at} {name}: {got[name]} vs dct {want[name]}"
            for name in LITERAL:
                assert got.get(name) == want.get(name), f"{at} {name}: {got.get(name)!r} vs dct {want.get(name)!r}"
            if got["points"] is None or want["points"] is None:
                assert (got["points"] is None) == (want["points"] is None), f"{at}: one side drew points"
            else:
                assert len(got["points"]) == len(want["points"]), f"{at}: {len(got['points'])} points, dct drew {len(want['points'])}"
                for j, (a, b) in enumerate(zip(got["points"], want["points"], strict=True)):
                    assert round(a[0] - b[0], PLACES) == 0 and round(a[1] - b[1], PLACES) == 0, f"{at} point {j}: {a} vs dct {b}"


def _compare(board: str, columns: int, index: int, name: str) -> None:
    dive, dct = _dive_marks(board), _dct_marks(board)
    assert len(dive) == len(dct) == columns, f"{name}: {len(dive)} spark columns drawn, dct drew {len(dct)}"
    _same(dive[index], dct[index], name)


# ── line, area and columns: one column per configuration, one row per shape of series ──
# rows: rising, falling, flat, a single value, an empty array, mixed signs, twelve points.
@pytest.mark.parametrize(
    "index,name",
    [(0, "line"), (1, "line + markers + color"), (2, "area + fill_opacity + last"), (3, "columns"), (4, "columns + negative_color")],
)
def test_series_marks_draw_what_dct_draws(index, name):
    _compare(CELLS, 5, index, name)


# ── bar, bar-normalize and column, all-positive: auto ceiling, thresholds, labels ──
@pytest.mark.parametrize(
    "index,name",
    [(0, "bar (auto max)"), (1, "bar + max + color + radius"), (2, "bar-normalize + background + suffix"), (3, "bar-normalize + thresholds"), (4, "column + thresholds")],
)
def test_single_value_marks_draw_what_dct_draws(index, name):
    _compare(MARKS, 5, index, name)


# ── the same three once the column holds a negative: the midline layout ──
@pytest.mark.parametrize(
    "index,name",
    [(0, "bar (midline)"), (1, "bar (midline) + negative_color"), (2, "column (midline) + negative_color"), (3, "bar-normalize (stays edge-anchored)")],
)
def test_signed_marks_draw_what_dct_draws(index, name):
    _compare(SIGNED, 4, index, name)


def test_bar_labels_print_what_dct_prints():
    """dct prints a whole number through Python's ``%g`` and everything else to one decimal.
    Both round half to even, and ``%g`` reads the exponent that decides fixed or exponential
    notation off the value *after* rounding — which is why 999999 prints in full, 1000000
    does not, and 1234565 and 1234575 round in opposite directions. Neither
    ``toExponential`` nor ``toFixed`` will do this: both break a tie away from zero, so the
    port takes the digits off the integer itself. (Fuzzed against ``f"{v:g}"`` over 18,000
    whole numbers while it was written; these are the cases worth keeping.)"""
    _compare(LABELS, 1, 0, "bar-normalize + value_visible")
    labels = [next(s["text"] for s in cell if s["tag"] == "text") for cell in _dive_marks(LABELS)[0]]
    assert labels == [
        "999999 u", "1e+06 u", "9.0072e+15 u", "0.2 u", "100.0 u", "-3 u", "1.23457e+06 u",
        "1.23456e+06 u", "1.23458e+06 u", "-1.23456e+06 u", "1.51111e+09 u",
        "0.1 u", "-0.1 u", "0.8 u", "2.2 u",
    ]


# ── the properties that make the Dive's copy worth having ─────────────────────
def test_a_cell_with_nothing_to_draw_leaves_no_mark_on_either_side():
    """Two cells draw nothing at all, and the Dive must leave the same holes dct does: a
    null (dct never calls the renderer — `value is not None`) and, for the three marks with
    no background track, a zero (`fill_width > 0`). ``bar-normalize`` keeps its track."""
    dive, dct = _dive_marks(SIGNED), _dct_marks(SIGNED)
    rows = len(H.dom(SIGNED)["initial"]["charts"][0]["rows"])
    assert rows == 6
    assert [len(col) for col in dive] == [len(col) for col in dct] == [4, 4, 4, 5]


def test_a_cell_that_is_not_a_number_leaves_the_mark_out():
    """dct puts the cell through ``coerce_numeric_cell`` before a single-value mark draws
    (`table._render_spark_cell`), so a boolean, an empty string and a non-numeric string are
    each left to the cell's own text — and a numeric string still draws."""
    _compare(ODD, 1, 0, "bar over a text column")
    table = H.dom(ODD)["initial"]["charts"][0]
    assert [c["row"] for c in table["cell_sparks"]] == [0, 3], "only the two numeric strings draw"
    assert [row[1:] for row in table["rows"]] == [["", "True"], ["n/a", "False"], ["—", "True"], ["", "False"]]


def test_a_null_inside_a_series_does_not_take_the_card_down():
    """dct raises on one (`math.isfinite(None)`), which costs the whole board its render.
    The Dive skips the member instead: the bars either side of it keep their places."""
    rows = H.dom_with_rows(CELLS, lambda rows: [{**r, "bars": [1.0, None, 3.0]} for r in rows])["initial"]
    assert rows["alerts"] == []
    bars = [c for c in rows["charts"][0]["cell_sparks"] if c["col"] == 4]
    assert bars and all(len([s for s in cell["shapes"] if s["tag"] == "rect"]) == 2 for cell in bars)


def test_the_marks_redraw_when_the_rows_change():
    """The point of drawing them ourselves: dct's SVG is the build's numbers."""
    before = _dive_marks(MARKS)
    after = _dive_marks(MARKS, lambda rows: [{**r, "bar_capped": float(r["bar_capped"]) / 4} for r in rows])
    assert [c[0]["width"] for c in before[1]] != [c[0]["width"] for c in after[1]]
    assert [c[0]["width"] for c in before[0]] == [c[0]["width"] for c in after[0]], "an untouched column must not move"


def test_the_bar_ceiling_follows_the_live_column():
    """`bar` with no authored `max` scales against the column's own largest magnitude
    (`table._spark_column_layout`) — which in a Dive is whatever the browser just fetched,
    so doubling every value leaves the widths where they were and only the ceiling moves."""
    before = [c[0]["width"] for c in _dive_marks(MARKS)[0]]
    after = [c[0]["width"] for c in _dive_marks(MARKS, lambda rows: [{**r, "bar_auto": float(r["bar_auto"]) * 2} for r in rows])[0]]
    assert after == before
    capped = [c[0]["width"] for c in _dive_marks(MARKS, lambda rows: [{**r, "bar_capped": float(r["bar_capped"]) * 2} for r in rows])[1]]
    assert capped != [c[0]["width"] for c in _dive_marks(MARKS)[1]], "an authored `max` is a fixed ceiling"


def test_every_spark_type_dct_renders_is_covered_here():
    """`render_spark`'s own list of variants, against the ones these boards exercise."""
    from dbt_charts.core.compile.models.chart.authored import SparkConfig

    authored = set()
    for board in (CELLS, MARKS, SIGNED):
        chart = next(iter(H.build(board).manifest["charts"].values()))
        authored |= {col["spark"]["type"] for col in chart["table"]["columns"] if col.get("spark")}
    assert authored == set(SparkConfig.model_fields["type"].annotation.__args__)


def test_a_spark_column_never_falls_back_to_the_cell_text():
    """The mark replaces the value: an array column must not print its list literal."""
    table = H.dom(CELLS)["initial"]["charts"][0]
    assert [row[1:] for row in table["rows"]] == [[""] * 5 for _ in table["rows"]]
    assert [row[0] for row in table["rows"]][:3] == ["rise", "fall", "flat"]


def test_the_sizes_an_unsized_mark_falls_back_to_are_dcts_own():
    """dct stretches an unsized mark to the cell it landed in, and a Dive's table is laid
    out by the browser, so the Dive measures the cell — but until it has (the first paint,
    or a headless render that never lays anything out) it draws at dct's own defaults."""
    import pathlib

    from dbt_charts.core.render.chart import spark as dct_spark
    from dbt_charts_dive import presentation as P

    template = (pathlib.Path(P.__file__).parent / "template.tsx").read_text()
    assert f"const SPARK_WIDTH = {int(dct_spark._SPARK_WIDTH)};" in template
    assert f"const SPARK_BAR_WIDTH = {int(dct_spark._SPARK_BAR_WIDTH)};" in template
    assert "const STROKE_WIDTH = 1.5;" in template  # render_spark_line / render_spark_area


def test_the_manifest_carries_the_theme_the_marks_are_drawn_with():
    """No spark token may be read at render time out of thin air: the compile step flattens
    dct's ``style.spark`` into the manifest, and the template reads only those names."""
    import pathlib

    from dbt_charts_dive import presentation as P

    theme = next(iter(H.build(CELLS).manifest["charts"].values()))["table"]["spark"]
    assert set(theme) == {p.replace(".", "_") for p in P._SPARK_TOKENS} | {"negative", "font_family", "font_size"}
    template = (pathlib.Path(P.__file__).parent / "template.tsx").read_text()
    used = set(re.findall(r"\btheme\.([a-z_]+)", template))
    assert used <= set(theme), f"template reads spark tokens the manifest does not carry: {sorted(used - set(theme))}"


# ── the size the browser measures, which no headless render can ───────────────
@pytest.mark.browser
def test_an_unsized_mark_stretches_to_its_cell_in_chromium():
    """dct sizes an unsized mark from the lane it landed in — the cell width less 8 either
    side, capped so the mark clears the edge, except `column`, which stays the narrow
    theme width. An HTML table lays its columns out in the browser, so the Dive measures
    the cell and applies the same rule there; an authored width still wins."""
    board = H.FIXTURE_BOARDS["spark_stretch.yml"]
    report, _ = H.browser(board)
    theme = next(iter(H.build(board).manifest["charts"].values()))["table"]["spark"]
    marks = {m["col"]: m for m in report["table_cell_sparks"][0]}
    assert sorted(marks) == [1, 2, 3, 4, 5], "one mark per spark column of the first row"
    for col in (1, 2):  # bar, line: the lane less its padding
        cell = marks[col]["cell"]
        assert cell > 100, f"column {col} lane is {cell}px — too narrow to tell a stretch from a default"
        assert marks[col]["width"] == min(int(cell - 16), int(cell - 8)), marks[col]
    assert marks[3]["width"] == 40, "an authored width wins over the cell"
    assert marks[4]["width"] == theme["column_width"], "`column` stays the narrow theme mark"
    assert marks[5]["width"] == int(marks[5]["cell"] - 8), "but no mark outgrows its lane"
    assert all(m["width"] <= m["cell"] - 8 for m in marks.values()), marks


def test_a_headless_render_draws_an_unsized_mark_at_dcts_default():
    """Nothing lays the table out in jsdom, so there is no cell to measure: the marks fall
    back to dct's own unsized defaults rather than collapsing to nothing."""
    board = H.FIXTURE_BOARDS["spark_stretch.yml"]
    theme = next(iter(H.build(board).manifest["charts"].values()))["table"]["spark"]
    first = [c for c in H.dom(board)["initial"]["charts"][0]["cell_sparks"] if c["row"] == 0]
    assert [(c["col"], c["width"]) for c in first] == [(1, 100), (2, 80), (3, 40), (4, theme["column_width"]), (5, 300)]
