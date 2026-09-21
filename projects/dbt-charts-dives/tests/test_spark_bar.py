"""The spark bar, drawn twice: by dbt Charts in Python and by the Dive in the browser.

dbt Charts has no Vega-Lite spec for this family — `render/chart/spark_bar.py` writes the
SVG itself, against the rows it queried at build time. A Dive cannot ship that SVG (it is
the build's numbers) so `template.tsx` draws the card from live rows instead, following the
same renderer step for step. These tests hold the two outputs against each other: every
rect and every text, for a card of each configuration and each shape of data.
"""

from __future__ import annotations

import xml.etree.ElementTree as ET

import harness as H
import pytest

CONFIG = H.FIXTURE_BOARDS["spark_config.yml"]
VALUES = H.FIXTURE_BOARDS["spark_values.yml"]
TITLES = H.FIXTURE_BOARDS["spark_titles.yml"]
PLACES = 3  # dct writes a coordinate to one decimal; agree well past that


def _number(value: str | None) -> float | None:
    return None if value is None else float(value)


def _dct_card(board: str, chart_id: str) -> dict:
    """The rects and texts dct's own renderer wrote for this chart, in document order.

    Its board export nests the card's SVG in a `<g transform="translate(…)">` for the card
    padding; the elements inside carry the same coordinates the Dive's own SVG uses.
    """
    root = ET.fromstring(H.dct_svg(board))
    group = next(g for g in root.iter() if g.get("data-chart-id") == chart_id)
    inner = next(g for g in group.iter(H.SVG_NS + "g") if (g.get("transform") or "").startswith("translate"))
    rects, texts = [], []
    for el in inner.iter():
        if el.tag == H.SVG_NS + "rect":
            rects.append({k: _number(el.get(k)) for k in ("x", "y", "width", "height")} | {"fill": el.get("fill"), "rx": _number(el.get("rx"))})
        elif el.tag == H.SVG_NS + "text":
            texts.append({
                "x": _number(el.get("x")), "y": _number(el.get("y")), "text": "".join(el.itertext()).strip(),
                "size": _number(el.get("font-size")), "fill": el.get("fill"), "anchor": el.get("text-anchor"),
                "weight": el.get("font-weight"), "style": el.get("font-style"), "family": el.get("font-family"),
                "kind": el.get("data-authored-kind"),
            })
    return {"rects": rects, "texts": texts}


def _dive_card(board: str, chart_id: str) -> dict:
    """The same card as the Dive draws it, out of the rendered DOM."""
    manifest = H.build(board).manifest
    ids = [cid for cid in H.chart_order(manifest) if manifest["charts"][cid]["kind"] == "spark_bar"]
    return H.dom(board)["initial"]["sparks"][ids.index(chart_id)]


def _same(dive: dict, dct: dict, chart_id: str) -> None:
    assert len(dive["rects"]) == len(dct["rects"]), f"{chart_id}: {len(dive['rects'])} rects, dct drew {len(dct['rects'])}"
    for i, (got, want) in enumerate(zip(dive["rects"], dct["rects"], strict=True)):
        for key in ("x", "y", "width", "height", "rx"):
            assert round(got[key] - want[key], PLACES) == 0, f"{chart_id}: rect {i} {key}: {got[key]} vs dct {want[key]}"
        assert got["fill"] == want["fill"], f"{chart_id}: rect {i} fill"
    assert [t["text"] for t in dive["texts"]] == [t["text"] for t in dct["texts"]], f"{chart_id}: text"
    for i, (got, want) in enumerate(zip(dive["texts"], dct["texts"], strict=True)):
        for key in ("x", "y", "size"):
            assert round(got[key] - want[key], PLACES) == 0, f"{chart_id}: text {i} {key}: {got[key]} vs dct {want[key]}"
        for key in ("fill", "anchor", "weight", "style", "family", "kind"):
            assert got[key] == want[key], f"{chart_id}: text {i} {key}: {got[key]!r} vs dct {want[key]!r}"


# ── one card per configuration ────────────────────────────────────────────────
@pytest.mark.parametrize(
    "chart_id",
    ["s_default", "s_no_labels", "s_no_counts", "s_bare", "s_tall", "s_colors", "s_square",
     "s_wide_label", "s_wide_count", "s_small_font", "s_max_two", "s_min_width"],
)
def test_configuration_draws_what_dct_draws(chart_id):
    _same(_dive_card(CONFIG, chart_id), _dct_card(CONFIG, chart_id), chart_id)


# ── one card per shape of data ────────────────────────────────────────────────
@pytest.mark.parametrize(
    "chart_id",
    ["v_negatives", "v_mixed", "v_zeros", "v_nulls", "v_floats", "v_integral", "v_thousands",
     "v_one", "v_long", "v_twelve"],
)
def test_values_draw_what_dct_draws(chart_id):
    _same(_dive_card(VALUES, chart_id), _dct_card(VALUES, chart_id), chart_id)


# ── titles, subtitles, and the fields dct finds for itself ────────────────────
@pytest.mark.parametrize("chart_id", ["t_subtitle", "t_untitled", "t_auto"])
def test_titles_draw_what_dct_draws(chart_id):
    _same(_dive_card(TITLES, chart_id), _dct_card(TITLES, chart_id), chart_id)


def test_the_card_redraws_when_the_rows_change():
    """The point of drawing it ourselves: dct's SVG is the build's numbers."""
    before = H.dom(CONFIG)["initial"]["sparks"][0]
    after = H.dom_with_rows(CONFIG, lambda rows: [{**r, "count": r["count"] * 3 + 1} for r in rows])["initial"]["sparks"][0]
    assert [t["text"] for t in before["texts"]] != [t["text"] for t in after["texts"]]
    assert [r["width"] for r in before["rects"]] != [r["width"] for r in after["rects"]]


def test_the_fields_dct_detects_are_the_ones_the_dive_reads():
    """`x`/`y` unauthored: dct picks them out of the columns, and the Dive is told which."""
    spark = H.build(TITLES).manifest["charts"]["t_auto"]["spark_bar"]
    assert (spark["x"], spark["y"]) == ("total", "label")
