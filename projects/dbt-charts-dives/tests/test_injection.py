"""End-to-end: a variable value is data, never SQL.

dbt Charts binds every ``{{ var }}`` as a parameter (``adapter_registry._compose_query_refs``
renders through ``render_parameterized``), so no value a viewer supplies can become SQL
syntax. The Dive resolves the same variables in the viewer's browser, against the viewer's
own MotherDuck session, so it has to keep that property — and produce the same SQL dbt
Charts does for the same values.
"""

from __future__ import annotations

import json
import re

import harness as H
import pytest

F = H.FIXTURE_BOARDS
BOARD = F["injection.yml"]
QUERY = "by_region"
DEFAULTS = {"needle": "North", "period": ["2023-01-01", "2023-12-31"], "min_orders": 1}
# What a viewer can type into each control; every one of them is a value, not a predicate.
HOSTILE = {
    "needle": "North' OR '1'='1",
    "period": ["x' OR '1", "2023-12-31"],  # short enough to survive the 10-char date slice
    "min_orders": "1 OR 1=1",
}


def _skeleton(sql: str) -> str:
    """The SQL with every value blanked — a literal, a typed literal, NULL, a number. What
    is left is the statement itself, and no variable value may change it."""
    sql = re.sub(r"\b(?:DATE|TIMESTAMP|TIME)\s+'(?:[^']|'')*'", "?", sql)
    sql = re.sub(r"'(?:[^']|'')*'", "?", sql)
    sql = re.sub(r"\bNULL\b", "?", sql)
    return re.sub(r"(?<![\w.])\d+(?:\.\d+)?(?![\w.])", "?", sql)


def test_text_variable_is_quoted_like_dbt_charts():
    """dct binds ``WHERE region = {{ needle }}``, so its SQL compares against a string.
    The Dive's default SQL has to run, and return dct's rows."""
    m = H.build(BOARD).manifest
    sql = m["queries"][QUERY]
    assert "region = 'North'" in sql, sql
    dive_rows = H.fetch_rows(sql)
    dct_rows = H.dct_chart_items(BOARD)["region_table"]["data"]
    assert [r["region"] for r in dive_rows] == [r["region"] for r in dct_rows]


@pytest.mark.parametrize("key", sorted(HOSTILE))
def test_one_hostile_value_cannot_change_the_query(key: str):
    """Substituting one control's value rewrites literals and nothing else."""
    m = H.build(BOARD).manifest
    benign = _skeleton(H.dive_sql(m, QUERY, DEFAULTS))
    attack = _skeleton(H.dive_sql(m, QUERY, {**DEFAULTS, key: HOSTILE[key]}))
    assert attack == benign


def test_hostile_values_still_produce_a_query_the_warehouse_runs():
    """All three at once: the SQL is valid, and selects no more than the honest query."""
    m = H.build(BOARD).manifest
    sql = H.dive_sql(m, QUERY, {**DEFAULTS, **HOSTILE})
    assert "1=1" not in _skeleton(sql)
    assert len(H.fetch_rows(sql)) <= len(H.fetch_rows(H.dive_sql(m, QUERY, DEFAULTS)))


def test_number_slot_keeps_its_type():
    """A number variable is a number slot, so the Dive spells it the way dct binds it."""
    m = H.build(BOARD).manifest
    slots = {s["key"]: s for v in m["query_variables"][QUERY]["variants"].values() for s in v["slots"]}
    assert slots["min_orders"]["type"] == "number"
    assert "HAVING COUNT(*) >= 3" in H.dive_sql(m, QUERY, {**DEFAULTS, "min_orders": 3})


@pytest.mark.browser
def test_hostile_text_value_in_chromium():
    """Typed into the live Dive: the SQL it sends is the harness' prediction, the query
    returns nothing, and nothing throws."""
    m = H.build(BOARD).manifest
    predicted = H.dive_sql(m, QUERY, {**DEFAULTS, "needle": HOSTILE["needle"]})
    actions = [{"type": "input", "key": "needle", "value": HOSTILE["needle"]}]
    rep, _ = H.browser(BOARD, actions=json.dumps(actions), extra_sql=(predicted,))
    assert rep["console_errors"] == [] and rep["alerts"] == []
    step = rep["steps"][-1]
    assert step["sql_log"][-1] == predicted
    assert step["table_rows"][0] == []


# ── a slot only ever stands where a value stands ──────────────────────────────
def test_a_value_is_never_interpolated_inside_a_literal():
    """`'{{ r }}'` puts the value inside the author's own quotes, where an escaped quote
    re-balances them and the rest of the value is code. The query keeps its default SQL."""
    m = H.build(F["quoted_slot.yml"]).manifest
    qv = m["query_variables"]["by_region"]
    assert "variants" not in qv and qv["note"]
    assert H.dive_sql(m, "by_region", {"regions": ["' OR 1=1 --"]}) == m["queries"]["by_region"]


# ── the Python spelling of a literal is the browser's ─────────────────────────
@pytest.mark.parametrize(
    "value, slot, expected",
    [
        (1, {"type": "bool", "member": 0}, "FALSE"),      # JS: v === true || v === "true"
        (True, {"type": "bool", "member": 0}, "TRUE"),
        ("true", {"type": "bool", "member": 0}, "TRUE"),
        (1e-06, {"type": "number", "member": 0}, "0.000001"),   # JS String(Number(x))
        (1e21, {"type": "number", "member": 0}, "1e+21"),
        (1.5e-08, {"type": "number", "member": 0}, "1.5e-8"),
        (2.5, {"type": "number", "member": 0}, "2.5"),
        (7, {"type": "number", "member": 0}, "7"),
        ("1 OR 1=1", {"type": "number", "member": 0}, "NULL"),
        ("2024-02-31", {"type": "date", "member": 0}, "DATE '2024-02-31'"),
        ("x' OR '1", {"type": "date", "member": 0}, "NULL"),
    ],
)
def test_sql_literal_says_what_the_dive_says(value, slot, expected):
    assert H.sql_literal(value, slot) == expected


def test_a_number_the_board_wrote_does_not_become_a_slot():
    """Qualifying a variant's tables means reparsing it, so slot tokens are swapped for
    numbers that parse where a value parses — and swapped back by text. A board that wrote
    the same number would have had it filled in with whatever the viewer typed."""
    m = H.build(F["sentinel_number.yml"]).manifest
    variant = next(iter(m["query_variables"]["by_region"]["variants"].values()))
    assert "987654301" in variant["sql"]
    assert len(variant["slots"]) == 1
    assert variant["sql"].count(variant["slots"][0]["token"]) == 1
    assert "987654301 >" in H.dive_sql(m, "by_region", {"min_orders": 3})
