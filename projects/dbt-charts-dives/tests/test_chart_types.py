"""Every chart type dbt Charts offers, and what a Dive does with it.

A Dive fetches its own rows when it opens, so "it compiled" is not the question — the
question is whether the card is drawn from those rows. Each type is rendered twice here,
against the rows the board returns and against the same rows with the measure moved, with
the Dive's own Vega bundle (or jsdom, for the two cards the Dive draws itself). A card that
draws the same picture both times is reading something that was baked in at build time.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

import harness as H

TYPES = H.FIXTURE_BOARDS["chart_types.yml"]
MAPS = H.FIXTURE_BOARDS["map_types.yml"]

# What the Dive does with each of dbt Charts' chart types (ChartType in
# compile/models/chart/authored/_type.py). "live" means the card is drawn from the rows the
# Dive fetched; "frozen" means it compiles and re-runs the query but draws build-time rows.
EXPECTED = {
    "bar": "live", "line": "live", "area": "live", "scatter": "live", "heatmap": "live",
    "pie": "live", "donut": "live", "histogram": "live", "table": "live", "kpi": "live",
    "point_map": "live", "bubble_map": "live", "geoshape": "live", "map": "live",
    "callout": "static",        # dbt Charts ignores the rows for a callout too
    "spark_bar": "live",        # dbt Charts draws it as SVG; template.tsx draws the same card
}


def _moved(rows: list[dict]) -> list[dict]:
    """The same rows with every number moved, so a chart that reads them must look different."""
    return [{k: (v * 3 + 1 if isinstance(v, (int, float)) and not isinstance(v, bool) else v) for k, v in r.items()} for r in rows]


def _redrawn(board: str, charts: dict[str, dict]) -> dict[str, list[str]]:
    """Each chart's spec rendered against the board's rows and against moved rows."""
    from test_bundle import _bundle_js

    js = Path(__file__).parent / "build" / "liveness_bundle.js"
    js.parent.mkdir(exist_ok=True)
    js.write_text(_bundle_js(H.build(board).content), encoding="utf-8")
    rows_by_sql = H.live_rows(board)
    jobs = [
        {"id": cid, "spec": c["spec"], "rows": [rows := rows_by_sql[H.build(board).manifest["queries"][c["query"]]], _moved(rows)]}
        for cid, c in charts.items()
    ]
    job_file = js.with_name("liveness_jobs.json")
    job_file.write_text(json.dumps(jobs), encoding="utf-8")
    proc = subprocess.run(["node", str(Path(__file__).parent / "render_spec.mjs"), str(js), str(job_file)], capture_output=True, text=True, cwd=Path(__file__).parent, timeout=300)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr[-2000:])
    return json.loads(proc.stdout)


# Which card in which fixture board is which authored type. dbt Charts normalizes the
# aliases away (donut -> pie, map -> geoshape, bubble_map -> point_map), so the authored
# type only survives in the id we gave the card.
CARD = {
    "bar": (TYPES, "c_bar"), "line": (TYPES, "c_line"), "area": (TYPES, "c_area"),
    "scatter": (TYPES, "c_scatter"), "heatmap": (TYPES, "c_heatmap"), "pie": (TYPES, "c_pie"),
    "donut": (TYPES, "c_donut"), "histogram": (TYPES, "c_histogram"), "table": (TYPES, "c_table"),
    "kpi": (TYPES, "c_kpi"), "spark_bar": (TYPES, "c_spark"), "callout": (TYPES, "c_callout"),
    "geoshape": (MAPS, "m_geoshape"), "map": (MAPS, "m_map"),
    "point_map": (MAPS, "m_point"), "bubble_map": (MAPS, "m_bubble"),
}


def _card(chart_type: str) -> tuple[str, dict]:
    board, cid = CARD[chart_type]
    return board, H.build(board).manifest["charts"][cid]


def test_the_table_of_chart_types_is_the_whole_list():
    """dbt Charts' own enum, so a new chart type shows up here as a failure rather than as a
    card nobody checked."""
    from dbt_charts.core.compile.models.chart.authored._type import ChartType

    assert {t.value for t in ChartType} == set(EXPECTED)


def test_every_type_in_the_table_has_a_card_to_check():
    assert set(CARD) == set(EXPECTED)


@pytest.mark.parametrize("chart_type", sorted(t for t, verdict in EXPECTED.items() if verdict == "live" and t not in ("table", "kpi", "spark_bar")))
def test_a_vega_chart_redraws_when_the_rows_change(chart_type):
    board, entry = _card(chart_type)
    assert entry["kind"] == "vega" and entry["query"], entry
    before, after = _redrawn(board, {entry["id"]: entry})[entry["id"]]
    assert before != after, f"{chart_type} drew the same picture for different rows"


def test_the_cards_the_dive_draws_itself_redraw_when_the_rows_change():
    """Table, KPI and spark bar, in jsdom: the rows it was given, then other rows."""
    before = H.dom(TYPES)["initial"]
    after = H.dom_with_rows(TYPES, _moved)["initial"]
    assert before["tables"][0]["rows"] != after["tables"][0]["rows"]
    assert before["kpis"][0]["value"] != after["kpis"][0]["value"]
    assert [r["width"] for r in before["sparks"][0]["rects"]] != [r["width"] for r in after["sparks"][0]["rects"]]


def test_a_callout_says_the_same_thing_however_the_data_moves():
    """Not a defect: dbt Charts' own callout renderer discards the rows as well."""
    _, entry = _card("callout")
    assert entry["kind"] == "svg" and entry["query"] is None and "snapshot" not in entry


@pytest.mark.parametrize("chart_type", ["geoshape", "map"])
def test_a_choropleth_reads_the_live_rows(chart_type):
    """A choropleth joins its rows to the geometry with a lookup transform, which carries
    them as data — so the rows have to arrive there, not in the dataset the other families
    read."""
    _, entry = _card(chart_type)
    baked = [t for layer in (entry["spec"].get("layer") or []) for t in (layer.get("transform") or []) if (t.get("from") or {}).get("data", {}).get("values")]
    assert baked == [], f"{chart_type} carries its rows in {len(baked)} lookup transform(s)"


@pytest.mark.parametrize("chart_type", ["geoshape", "map"])
def test_a_choropleth_needs_no_network_when_it_opens(chart_type):
    """Its geometry was a URL on vega.github.io; a Dive that has to fetch a third party to
    draw is a Dive that stops drawing when the sandbox says no."""
    _, entry = _card(chart_type)
    urls = [d for d in json.dumps(entry["spec"]).split('"url": "')[1:]]
    assert urls == [], f"{chart_type} still fetches {urls[:1]}"


def test_a_spark_bar_is_drawn_by_the_dive_itself():
    """dbt Charts draws this family in Python; `test_spark_bar.py` holds the Dive's own
    rendering of it against dct's, card by card."""
    board, entry = _card("spark_bar")
    assert entry["kind"] == "spark_bar" and entry["query"], entry
    assert entry["spark_bar"]["x"] and entry["spark_bar"]["y"]
