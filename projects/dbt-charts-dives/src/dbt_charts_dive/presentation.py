"""What a card looks like, decided by dbt-charts and carried as data.

The Dive draws KPI cards and tables itself, and formats their numbers live, so everything
dbt-charts resolved about them — fills, baselines, fonts, column widths, paginator, the
number-format plans — is compiled here and read by ``template.tsx``. Nothing in this module
decides how a card should look; it asks dbt-charts and writes the answer down.

From dbt-charts' private surface: ``compile.format._KPI_SI_COMPACT_THRESHOLD`` (the compact-SI
cutoff), ``render.chart.kpi._resolve_kpi_colors`` / ``_resolve_support_row`` /
``_resolve_kpi_layout`` / ``_emit_card_chrome`` / ``_rule_output_for_channel``,
``render.chart.table._table_numeric_cell_font`` and the ``_PAGINATION_*`` / ``_PAGINATOR_*``
constants, and ``text.format_d3._D3_TO_ANALYTIC`` / ``_D3_TO_NARRATIVE``.
"""

from __future__ import annotations

import dataclasses
import itertools
import math
from collections.abc import Callable
from typing import Any


# ─────────────────────────────────────────────────────────────────────────────
# fonts, cases and number formats
# ─────────────────────────────────────────────────────────────────────────────
def _font(fs: Any) -> dict[str, Any]:
    """A resolved FontStyle as the five CSS properties the template applies."""
    w = fs.weight
    return {
        "family": fs.family,
        "size": float(fs.size) if fs.size is not None else None,
        "weight": None if w is None else str(int(w)) if isinstance(w, (int, float)) else str(w),
        "color": fs.color,
        "style": fs.style,
    }


def _cased(text: str | None, case: Any) -> str:
    from dbt_charts.core.text.case import apply_case

    text = text or ""
    return apply_case(text, case) if text and case and case != "none" else text


def _format_plan(fmt: Any, formats: dict[str, str] | None, *, native: bool = False, default_number: bool = False) -> dict[str, Any]:
    """Everything ``format_kpi_parts`` decides before it sees the value, as data.

    The template mirrors only the value-dependent tail: run the d3 spec, split the SI
    suffix through ``si``, split a trailing ``%``, swap to ``sub_unit`` below $1.
    """
    from dbt_charts.core.compile.format import get_format_prefix_suffix, resolve_format
    from dbt_charts.core.compile.models.primitives import FormatConfig
    from dbt_charts.core.text.format_d3 import _D3_TO_ANALYTIC, _D3_TO_NARRATIVE, is_d3_si_spec
    from dbt_charts.core.text.predefined_formats import PREDEFINED_NATIVE, PREDEFINED_NUMBER_NAMES, PREDEFINED_SPECS, PREDEFINED_SUB_UNIT_FALLBACK, si_sub_unit_floor

    raw = fmt.spec if isinstance(fmt, FormatConfig) else fmt if isinstance(fmt, str) else None
    is_house = raw in PREDEFINED_NUMBER_NAMES
    spec = resolve_format(fmt, formats) or ""
    if not spec and default_number:
        is_house, raw = True, "number"
        spec = resolve_format(raw, formats)
    prefix, suffix = get_format_prefix_suffix(fmt)
    if spec in PREDEFINED_NATIVE:
        # Whole-number percents / point deltas: the value already is the display unit.
        number, unit = PREDEFINED_NATIVE[spec](1.0)
        return {"spec": "+.1f" if number.startswith("+") else ".1f", "prefix": "", "suffix": unit, "si": None, "pct": False}
    plan: dict[str, Any] = {
        "spec": spec.replace("$", ""),
        "prefix": ((prefix or "") + ("$" if "$" in spec else "")).strip(),
        "suffix": (suffix or "").strip(),
        "si": None,
        "pct": "%" in spec,
    }
    if raw in PREDEFINED_SUB_UNIT_FALLBACK:
        plan["sub_unit"] = {
            "floor": si_sub_unit_floor(spec, prefix, suffix),
            "spec": PREDEFINED_SPECS[PREDEFINED_SUB_UNIT_FALLBACK[raw]].replace("$", ""),
        }
    if plan["spec"] and is_d3_si_spec(plan["spec"]):
        notation = fmt.notation if isinstance(fmt, FormatConfig) else None
        effective = notation if notation is not None else ("analytic" if is_house else None)
        if native or effective is None:
            plan["si"] = {k: k for k in _D3_TO_ANALYTIC}
        elif effective == "analytic":
            plan["si"] = {k: v.strip() for k, v in _D3_TO_ANALYTIC.items()}
        else:
            plan["si"] = {k: v.strip() for k, v in _D3_TO_NARRATIVE.items()}
    return plan


def _kpi_value_plan(chart: Any, formats: dict[str, str] | None) -> dict[str, Any]:
    """The headline plan. dct finalizes an unformatted KPI against its value (compact
    SI at |v| >= 1000, exact digits below); emit both branches so live values pick."""
    from dbt_charts.core.compile.format import _KPI_SI_COMPACT_THRESHOLD, finalize_kpi_value_format
    from dbt_charts.core.compile.models.primitives import FormatConfig

    authored = chart.style.kpi.value.format
    if authored.spec if isinstance(authored, FormatConfig) else authored:
        return _format_plan(chart.format, formats, native=chart.format_native)
    plan = _format_plan(finalize_kpi_value_format(authored, _KPI_SI_COMPACT_THRESHOLD), formats)
    plan["small"] = _format_plan(finalize_kpi_value_format(authored, 0.0), formats)
    plan["threshold"] = _KPI_SI_COMPACT_THRESHOLD
    return plan


# ─────────────────────────────────────────────────────────────────────────────
# the KPI card
# ─────────────────────────────────────────────────────────────────────────────
_PREDICATE_KEYS = ("default", "is_null", "eq", "ne", "in_", "lt", "lte", "gt", "gte", "between")


def _kpi_channel_cases(chart: Any, row: dict[str, Any], resolve: Callable[[dict[str, Any]], dict[str, Any]]) -> tuple[list[dict[str, Any]], dict[str, dict[str, Any]]] | None:
    """A KPI's conditional style channels, and the presentation each outcome resolves to.

    dct evaluates the rules against one row and keeps the answer. The rules are a closed,
    tiny grammar, so instead of porting dct's colour derivation the compiler runs it once
    per outcome — the same trick the variable variants use — and the browser only has to
    say which outcome the live row picks.
    """
    import types

    channels = {name: ch for name, ch in (getattr(chart, "resolved_channels", None) or {}).items()
                if name in ("background", "color") and getattr(ch, "mode", None) == "conditional"}
    if not channels:
        return None
    from dbt_charts.core.render.chart.kpi import _rule_output_for_channel

    outcomes: list[list[tuple[str, Any]]] = []
    described: list[dict[str, Any]] = []
    for name, ch in channels.items():
        rules = [r for r in ch.rules if r.default is not True]
        default_rule = next((r for r in ch.rules if r.default is True), None)
        per_channel: list[tuple[str, Any]] = [(str(i), _rule_output_for_channel(r, name)) for i, r in enumerate(rules)]
        per_channel.append(("base", _rule_output_for_channel(default_rule, name) if default_rule is not None else None))
        outcomes.append(per_channel)
        described.append({"name": name, "field": ch.data_field, "rules": [
            {k.removesuffix("_"): getattr(r, k) for k in _PREDICATE_KEYS if getattr(r, k, None) is not None} for r in rules]})
    if math.prod(len(o) for o in outcomes) > 24:
        return None
    cases: dict[str, dict[str, Any]] = {}
    for combo in itertools.product(*outcomes):
        patched = dict(getattr(chart, "resolved_channels", None) or {})
        for (name, _), (_, output) in zip(channels.items(), combo, strict=True):
            patched[name] = types.SimpleNamespace(mode="literal", literal_value=output)
        cases["|".join(key for key, _ in combo)] = resolve(patched)
    return described, cases


def _product_size(groups: list[list[Any]]) -> int:
    size = 1
    for g in groups:
        size *= len(g)
    return size


def kpi_presentation(chart: Any, data: list[dict[str, Any]], width: float, height: float, style: Any) -> dict[str, Any]:
    """Run dct's KPI resolvers (``render/chart/kpi.py``) and keep their answers."""
    from dbt_charts.core.render.chart import kpi as K

    cfg = chart.style.kpi
    defaults = style.chart_defaults
    title_style = cfg.title if cfg.title is not None else defaults.title
    formats = defaults.formats
    row = data[0] if data else {}
    label = _cased(chart.label, cfg.label.font.case)
    palette = K._resolve_kpi_colors(row, chart.format, cfg, chart.resolved_channels, cfg.background, formats, board_style=style)
    support = K._resolve_support_row(chart.support, row, style.tones, palette.muted, chart.id, formats)
    layout = K._resolve_kpi_layout(label, width, height, cfg, title_style, has_support=support is not None)
    out: dict[str, Any] = {
        "value": chart.value,
        "layout": dataclasses.asdict(layout),
        "colors": dataclasses.asdict(palette),
        "chrome": K._emit_card_chrome(palette, cfg, layout.width, layout.height, None),
        "glyph": cfg.glyph.character or "",
        "value_font": cfg.value.font.family,
        "body_font": cfg.font.family,
        "format": _kpi_value_plan(chart, formats),
    }
    cases = _kpi_channel_cases(chart, row, lambda channels: _kpi_colors(chart, row, cfg, channels, formats, style, layout))
    if cases is not None:
        out["channels"], out["cases"] = cases
    if support is not None:
        out["support"] = {
            "value": chart.support.value,
            "glyph": support.glyph,
            "explainer": support.explainer,
            "value_fill": support.value_fill,
            "glyph_fill": support.glyph_fill,
            "format": _format_plan(chart.support.format, formats),
        }
    return out


def _kpi_colors(chart: Any, row: dict[str, Any], cfg: Any, channels: dict[str, Any], formats: Any, style: Any, layout: Any) -> dict[str, Any]:
    """dct's colour pass for one set of resolved channels: the card's fills and its chrome."""
    from dbt_charts.core.render.chart import kpi as K

    palette = K._resolve_kpi_colors(row, chart.format, cfg, channels, cfg.background, formats, board_style=style)
    return {"colors": dataclasses.asdict(palette), "chrome": K._emit_card_chrome(palette, cfg, layout.width, layout.height, None)}


# ─────────────────────────────────────────────────────────────────────────────
# the spark bar
# ─────────────────────────────────────────────────────────────────────────────
def spark_bar_presentation(chart: Any, data: list[dict[str, Any]], width: float, height: float | None, style: Any) -> dict[str, Any]:
    """dct's spark_bar decisions as data: the numbers its own renderer draws with.

    ``render/chart/spark_bar.py`` draws this family in Python, so the Dive cannot ship a
    Vega-Lite spec for it and cannot ship dct's SVG either — that SVG is the build's rows.
    Everything that does not depend on the rows is resolved here (the fields, the colours,
    the reserved widths, the layout constants dct tunes per theme) and ``template.tsx``
    does exactly the per-row arithmetic dct does.
    """
    from dbt_charts.core.compile.config import get_chart_rendering
    from dbt_charts.core.render.chart.spark_bar import _auto_detect_spark_bar_fields, _validate_spark_bar_value_field
    from dbt_charts.core.render.utils import normalize_data_types

    cfg = chart.style.spark_bar
    layout = get_chart_rendering().spark_bar
    rows = normalize_data_types(data)
    x_field, y_field = _auto_detect_spark_bar_fields(rows, chart.x, chart.y)
    _validate_spark_bar_value_field(chart.id, x_field, rows)  # dct's own refusal, at build time
    title_font = chart.style.title_font
    values = [row.get(x_field) for row in rows if x_field and row.get(x_field) is not None]
    return {
        "x": x_field,
        "y": y_field,
        # dct's count lane branches on the Python type: an int prints grouped, a float that
        # happens to be whole prints bare, any other float to one decimal. A browser cannot
        # tell those apart, so the column's own type travels with the card.
        "float_values": bool(values) and all(isinstance(v, float) for v in values),
        "title": _cased(chart.title, style.title.font.case) if chart.title else "",
        "subtitle": chart.subtitle or "",
        "width": max(cfg.preferred_width if width is None else float(width), float(cfg.min_width)),
        "height": float(height) if height else None,
        "max_bars": int(cfg.max_bars),
        "label": {"visible": bool(cfg.label.visible), "width": float(cfg.label.width)},
        "count": {"visible": bool(cfg.count.visible), "width": float(cfg.count.width)},
        "bar": {
            "height": float(cfg.bar.height),
            "padding": float(cfg.bar.padding),
            "color": cfg.bar.color,
            "background": cfg.bar.background,
            "radius": float(cfg.border.radius),
        },
        "font": _font(cfg.font),
        "title_font": {"family": title_font.family, "size": int(title_font.size), "weight": int(title_font.weight)},
        "subtitle_size": float(cfg.subtitle.font.size),
        "muted": style.muted,
        "layout": {
            name: float(getattr(layout, name))
            for name in ("side_padding", "text_baseline_offset", "title_height", "title_baseline_y", "more_rows_font_size", "more_rows_offset_y", "more_rows_bottom_padding", "avg_char_width_px")
        },
    }


# ─────────────────────────────────────────────────────────────────────────────
# the table
# ─────────────────────────────────────────────────────────────────────────────
def _pagination(tc: Any) -> dict[str, Any] | None:
    """dct's table pagination as data: ``page_rows`` and the rules ``_resolve_visible_rows``
    applies to it (rows exceeding ``page_rows`` by at most ``grow_cap`` all fit on one page),
    plus the paginator's look (``_render_pagination_controls``: ``‹ 1 … 4 5 6 … 12 ›``,
    right-anchored, a muted ``Rows a–b of n`` label on the left)."""
    from dbt_charts.core.render.chart import table as T

    if not tc.pagination.enabled or tc.pagination.page_rows is None:
        return None
    p = tc.paginator
    return {
        "page_rows": int(tc.pagination.page_rows),
        "grow_cap": T._PAGINATION_GROW_CAP,
        "control_height": float(T._PAGINATION_CONTROL_HEIGHT),
        "sibling": T._PAGINATOR_SIBLING_COUNT,
        "boundary": T._PAGINATOR_BOUNDARY_COUNT,
        "prev": T._PAGINATOR_PREV_CHEVRON,
        "next": T._PAGINATOR_NEXT_CHEVRON,
        "ellipsis": T._PAGINATOR_ELLIPSIS,
        "aux_slot_ratio": T._PAGINATOR_AUX_SLOT_RATIO,
        "color_active": p.color_active,
        "color_inactive": p.color_inactive,
        "color_disabled": p.color_disabled,
        "font_size": float(p.font.size) if p.font.size is not None else 11.0,
        "weight_active": str(p.weight_active),
        "weight_inactive": str(p.weight_inactive),
        "weight_chevron": str(p.weight_chevron),
        "item_width": float(p.item_width),
    }


def chart_link(chart: Any, board: Any, executor: Any, failures: list[str]) -> str | None:
    """The chart's ``link:`` template, or the one dct synthesizes for ``auto_link: true``
    boards (``auto_link.synthesize_auto_link``; needs schema metadata, best effort)."""
    link = getattr(chart, "link", None)
    if isinstance(link, str) and link:
        return link
    if link is False or not getattr(board, "auto_link", False):
        return None
    try:
        from dbt_charts.core.render.chart.auto_link import set_auto_link_context, synthesize_auto_link

        set_auto_link_context(True)
        try:
            return synthesize_auto_link(board.charts[chart.id], executor) or None
        finally:
            set_auto_link_context(False)
    except Exception as e:  # noqa: BLE001 — no link is what dct shows when it cannot synthesize one
        failures.append(f"{chart.id}: auto_link not synthesized: {e}")
        return None


# Every in-cell spark reads these; one copy per table rather than one per column.
_SPARK_TOKENS = (
    "color", "padding.top", "padding.right", "padding.bottom", "padding.left",
    "empty.inset_x", "empty.stroke.color", "empty.stroke.width", "empty.stroke.dasharray",
    "single_value.inset_x", "single_value.marker_radius",
    "columns.gap", "columns.padding", "columns.min_bar_height", "columns.border.radius",
    "column.width", "column.height",
    "bar.background", "bar.color", "bar.default_max", "bar.border.radius",
    "bar.label.inset_x", "bar.label.fill", "bar.label.fill_opacity",
    "area.fill_opacity",
)


def _spark_theme(style: Any, cell_font: Any) -> dict[str, Any]:
    """dct's ``style.spark`` tokens, flattened, plus the three it reads from elsewhere.

    ``font_family`` and ``font_size`` are the table's own cell font: a bar label inherits it
    whole (``render_spark_bar`` is handed the cell's ``FontStyle``, so its ``bar.label``
    size fallback never fires from a table), and dct unquotes the stack for an SVG attribute
    (``table._svg_font_family``) where the manifest keeps it as CSS.
    """
    from dbt_charts.core.render.chart.table import _svg_font_family

    def read(path: str) -> Any:
        node = style.chart_defaults.spark
        for part in path.split("."):
            node = getattr(node, part)
        return node

    tokens = {path.replace(".", "_"): read(path) for path in _SPARK_TOKENS}
    return tokens | {
        "negative": style.chart_defaults.tones.negative,
        "font_family": _svg_font_family(cell_font.family),
        "font_size": float(cell_font.size),
    }


def _spark_cell(spark: Any, row_height: float) -> dict[str, Any]:
    """One column's spark mark, resolved as far as the rows allow.

    ``render/chart/spark.py`` draws these in Python, per cell, from the rows dct queried.
    The Dive draws them from the rows it queried, so what travels is the configuration and
    the sizing rule — ``bar``'s ceiling is the column's own maximum and the midline layout
    is a column-wide fact, and both of those are answered in the browser against live rows.
    """
    height = min(int(spark.height or row_height - 8), int(row_height - 4))
    return {
        "type": spark.type,
        "width": int(spark.width) if spark.width else None,  # else the cell's own width
        "height": height,
        "color": spark.color,
        "max": spark.max,
        # dct reads its buckets in numeric order (``_get_threshold_color``); sorted pairs
        # travel, not a mapping — a float key would not survive a round trip through a
        # JSON object's string keys (``30.0`` out, ``30`` back).
        "thresholds": sorted((float(k), v) for k, v in (spark.thresholds or {}).items()) or None,
        "background": spark.background,
        "border_radius": spark.border_radius,
        "last_visible": bool(spark.last_visible),
        "min_max_visible": bool(spark.min_max_visible),
        "value_visible": bool(spark.value_visible),
        "value_suffix": spark.value_suffix,
        "fill_opacity": spark.fill_opacity,
        "negative_color": bool(spark.negative_color),
    }


def table_presentation(chart: Any, data: list[dict[str, Any]], style: Any) -> dict[str, Any]:
    """The resolved table style plus one format plan per column."""
    from dbt_charts.core.colors import sanitize_color
    from dbt_charts.core.compile.format import resolve_format
    from dbt_charts.core.render.chart.table import _table_numeric_cell_font
    from dbt_charts.core.render.chart.table_support import is_temporal_value
    from dbt_charts.core.text.numeral_scale import SuffixMode, suffix_at_register
    from dbt_charts.core.text.predefined_formats import PREDEFINED_TIME_SPECS, PredefinedTimeFormat
    from dbt_charts.core.utils import slug_to_text

    ts, tc, formats = chart.style, chart.style.table, chart.style.formats
    configs = chart.columns or {}
    keys = list(data[0].keys()) if data else list(configs)
    columns = []
    for key in keys:
        cfg = configs.get(key)
        if cfg is not None and cfg.visible is False:
            continue
        fmt = cfg.format if cfg is not None else None
        col: dict[str, Any] = {
            "key": key,
            "label": _cased((cfg.label if cfg is not None else None) or slug_to_text(key), tc.header.font.case),
            "align": cfg.align if cfg is not None else None,
            "swatch": bool(cfg is not None and cfg.swatch),
            "format": _format_plan(fmt, formats, default_number=True),
        }
        if cfg is not None and getattr(cfg, "link", None):
            col["link"] = cfg.link  # dct's per-cell link template ({{ col }} / {{ col | urlencode }})
        if cfg is not None and getattr(cfg, "header_link", None):
            col["header_link"] = cfg.header_link
        if any(is_temporal_value(r.get(key)) for r in data if r.get(key) is not None):
            resolved = resolve_format(fmt, formats) if fmt is not None else ""
            col["time"] = resolved if resolved.startswith("%") else PREDEFINED_TIME_SPECS[PredefinedTimeFormat.date_short]
        spark = getattr(cfg, "spark", None) if cfg is not None else None
        if spark is not None:
            col["spark"] = _spark_cell(spark, float(tc.row.height))
        ss = getattr(cfg, "shared_scale", None)
        if ss is not None:
            col["shared"] = {
                "divisor": 10.0**ss.exponent,
                "spec": ss.digit_spec,
                "suffix": suffix_at_register(ss.exponent, ss.register).strip(),
                "repeat": ss.mode is SuffixMode.REPEAT,
            }
        columns.append(col)
    return {
        "title": _cased(chart.title, ts.title_font.case),
        "subtitle": chart.subtitle or "",
        "title_font": _font(ts.title_font),
        "subtitle_font": _font(ts.title.subtitle.font),
        "title_height": float(tc.title_row.height),
        "font": _font(tc.font),
        "numeric_font": _table_numeric_cell_font(tc.font.family),
        "background": tc.background,
        "header": {
            "visible": tc.header.visible,
            "height": float(tc.header.height),
            "font": _font(tc.header.font),
            "background": tc.header.background,
            "rule": float(tc.header.rule.width),
        },
        "row": {"height": float(tc.row.height), "stripe": tc.row.stripe.color if tc.row.stripe else None, "rule": float(tc.row.rule.width)},
        "rule_color": sanitize_color(tc.row.rule.color or (tc.rule.color if tc.rule else None), tc.font.color),
        "cell_padding": float(tc.column_layout.cell_padding),
        "page_rows": tc.pagination.page_rows if tc.pagination.enabled else None,
        "pagination": _pagination(tc),
        "link_color": sanitize_color(style.font.color, tc.font.color),  # table.py: colors["link"] = board_style.font.color
        "symbol_mode": tc.symbol_mode,
        "spark": _spark_theme(style, tc.font) if any("spark" in col for col in columns) else None,
        "more_font": _font(tc.more_rows.font),
        "empty_font": _font(tc.empty_state.font),
        "columns": columns,
    }


# ─────────────────────────────────────────────────────────────────────────────
# the board itself
# ─────────────────────────────────────────────────────────────────────────────
def _border(b: Any) -> dict[str, Any]:
    return {"width": float(b.width), "color": b.color, "radius": float(b.radius)}


def _padding(p: Any) -> dict[str, float]:
    return {"top": float(p.top), "right": float(p.right), "bottom": float(p.bottom), "left": float(p.left)}


def board_style(style: Any, rb: Any, card_padding: float) -> dict[str, Any]:
    """Board-level presentation the template applies: page/card metrics plus the theme's
    tabs, details, variables-strip and tooltip blocks (``layouts.py``, ``variables_strip.py``,
    ``chart_interactivity.js`` read exactly these)."""
    tabs, details, vs, tt = style.layout.tabs, style.layout.details, style.variables, style.chart_defaults.tooltip
    table = style.chart_defaults.table
    header_fill = table.header.background
    stripe_fill = table.row.stripe.color if table.row.stripe else None
    return {
        "background": style.background,
        "muted": style.muted,
        "font": _font(style.font),
        "border_color": style.border.color,
        "page_padding": float(rb.page_padding or 0.0),
        "card_padding": card_padding,
        "gap": float(rb.layout.gap),
        "tabs": {
            "height": float(tabs.bar_height),
            "font": _font(tabs.font),
            "active_weight": str(tabs.active_weight),
            "inactive_weight": str(tabs.inactive_weight),
            "active_color": style.title.font.color,
            "inactive_color": style.variables.font.color,
            "active_fill": header_fill,
            "inactive_fill": stripe_fill,
            "border": _border(tabs.border),
        },
        "details": {
            "summary_height": float(details.summary_height),
            "arrow_x": float(details.arrow.x),
            "arrow_size": float(details.arrow.font.size),
            "label_x": float(details.label_x),
            "font": _font(details.font),
            "color": style.title.font.color,
            "content_y_offset": float(details.content_y_offset),
            "expanded_fill": header_fill,
            "collapsed_fill": stripe_fill,
            "border": _border(details.border),
        },
        "variables": {
            "font": _font(vs.font),
            "label_font": _font(vs.label.font),
            "value_font": _font(vs.value.font),
            "placeholder_color": vs.placeholder.font.color,
            "gap": float(vs.gap),
            "control_gap": float(vs.control_gap),
            "container_height": float(vs.container_height),
            "input": {
                "height": float(vs.input.height),
                "background": vs.input.background,
                "padding": _padding(vs.input.padding),
                "radius": float(vs.input.border.radius),
                "focus_color": vs.input.focus_color,
                "widths": {"text": float(vs.input.widths.text), "number": float(vs.input.widths.number), "range": float(vs.input.widths.range), "checkbox": float(vs.input.widths.checkbox), "daterange": float(vs.input.widths.daterange)},
            },
        },
        "tooltip": {
            "background": tt.background,
            "line_height": float(tt.line_height),
            "max_width": float(tt.max_width),
            "gap": float(tt.gap),
            "font": _font(tt.font),
            "padding": _padding(tt.padding),
            "label": _font(tt.label.font),
            "value": _font(tt.value.font),
            "border": _border(tt.border),
            "shadow": bool(tt.shadow.visible),
            "swatch": {"size": float(tt.swatch.size), "radius": float(tt.swatch.radius)},
            "active_marker": tt.active_marker,
            "hover_emphasis": bool(style.chart_defaults.hover_emphasis.visible),
            "max_rows": 8,  # chart_interactivity.js MAX_XUNIFIED_ROWS
            "abandon": 20,  # XUNIFIED_ABANDON_THRESHOLD
        },
    }


def font_faces(markup: str) -> dict[str, Any]:
    """The ``@font-face`` block dct embeds in an offline export, for the faces this
    manifest names (its font stacks and rendered SVG), as data: URIs."""
    from dbt_charts.core.fonts import render_embedded_font_face_css
    from dbt_charts.core.render.font_selection import board_font_faces

    faces = board_font_faces(markup.replace('\\"', '"'), frozenset())
    return {"css": render_embedded_font_face_css(faces), "families": sorted({f.family for f in faces})}
