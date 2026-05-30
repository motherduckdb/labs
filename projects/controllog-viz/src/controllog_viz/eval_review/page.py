"""Page assembly: stats bar, filters, question cards, and panels.

Composes the data model, the trace renderer, and the inline assets into the final
self-contained HTML document.
"""
from __future__ import annotations

import duckdb

from controllog_viz.eval_review.assets import CSS_STYLES, JS_SCRIPT
from controllog_viz.eval_review.model import (
    QUESTION_PREVIEW_LENGTH,
    ErrorCard,
    ReportData,
    build_report_data,
    _escape,
    _format_result,
    _model_short_name,
)
from controllog_viz.eval_review.trace import _render_cot_trace


def generate_eval_review(con: duckdb.DuckDBPyConnection, run_id: str | None) -> str:
    """Build ReportData from the run's evaluation_result events and render the report."""
    title = run_id if run_id is not None else "(no run_id)"
    report_data = build_report_data(con, run_id, title)
    return _generate_html(report_data)


def _generate_html(report_data: ReportData) -> str:
    """Generate a self-contained HTML evaluation review."""
    models: set[str] = set()
    configs: set[str] = set()
    categories: set[str] = set()
    for card in report_data.cards:
        models.add(_model_short_name(card.model))
        configs.add(card.config_type)
        if card.error_category:
            categories.add(card.error_category)

    model_options = "".join(
        f'<option value="{_escape(m)}">{_escape(m)}</option>' for m in sorted(models) if m
    )
    config_options = "".join(
        f'<option value="{_escape(c)}">{_escape(c)}</option>' for c in sorted(configs) if c
    )
    category_options = "".join(
        f'<option value="{_escape(c)}">{_escape(c)}</option>' for c in sorted(categories)
    )

    rd = report_data
    stats_html = (
        f'<div class="stats-bar">'
        f'<span class="stat-badge total">{rd.total} total</span>'
        f'<span class="stat-badge correct">{rd.correct_count} correct</span>'
        f'<span class="stat-badge error">{rd.error_count} errors</span>'
        f'<span class="stat-badge hit_limit">{rd.hit_limit_count} hit limit</span>'
        f'<span class="stat-badge incorrect">{rd.incorrect_count} incorrect</span>'
        f'<span class="stat-badge partial">{rd.partial_count} partial</span>'
        f"</div>"
    )

    cards_html = [_render_card(card) for card in report_data.cards]

    return f"""<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Evaluation Review - {_escape(report_data.title)}</title>
    <style>{CSS_STYLES}</style>
</head>
<body>
    <div class="header">
        <h1>EVALUATION REVIEW - {_escape(report_data.title)}</h1>
        {stats_html}
        <div class="filter-bar">
            <label>Status:</label>
            <select id="status-filter" onchange="applyFilters()">
                <option value="errors" selected>Errors Only</option>
                <option value="all">All</option>
                <option value="correct">Correct</option>
                <option value="incorrect">Incorrect</option>
                <option value="partial">Partial</option>
                <option value="error">Error</option>
                <option value="hit_limit">Hit Limit</option>
            </select>
            <label>Model:</label>
            <select id="model-filter" onchange="applyFilters()">
                <option value="">All</option>
                {model_options}
            </select>
            <label>Tier:</label>
            <select id="config-filter" onchange="applyFilters()">
                <option value="">All</option>
                {config_options}
            </select>
            <label>Category:</label>
            <select id="category-filter" onchange="applyFilters()">
                <option value="">All</option>
                {category_options}
            </select>
            <span id="filter-count" style="color: #888;"></span>
        </div>
        <div>
            <button onclick="expandAll()">Expand All</button>
            <button onclick="collapseAll()">Collapse All</button>
            <button onclick="exportComments()">Export Comments</button>
        </div>
    </div>

    <div class="container">
{"".join(cards_html)}
    </div>

    <script>{JS_SCRIPT}</script>
</body>
</html>"""


def _render_card(card: ErrorCard) -> str:
    model_short = _model_short_name(card.model)
    level = card.correctness_level
    level_display = _level_display(card)
    question_preview = (
        card.question_text[:QUESTION_PREVIEW_LENGTH]
        if card.question_text
        else "(no question)"
    )
    cost_str = f"${card.cost_usd:.4f}" if card.cost_usd is not None else "n/a"

    category_badge = ""
    if card.error_category:
        category_badge = (
            f'<span class="header-category">{_escape(card.error_category)}</span>'
        )

    panel1 = _render_question_panel(card)
    cot_html = _render_cot_trace(card.raw_response, card)
    panel2 = f'<div class="panel"><h3>Chain of Thought Trace</h3>{cot_html}</div>'
    panel3 = _render_sql_panel(card)

    comment_section = (
        f'<div class="comment-section">'
        f"<h3>Analysis Notes</h3>"
        f'<textarea data-qid="{_escape(card.question_id)}" '
        f'placeholder="Add notes about this result..."></textarea>'
        f"</div>"
    )

    return f"""
        <div class="question-card {_escape(level)}" data-qid="{_escape(card.question_id)}" data-model="{_escape(model_short)}" data-config="{_escape(card.config_type)}" data-status="{_escape(level)}" data-category="{_escape(card.error_category or '')}">
            <div class="card-header" onclick="toggleCard(this)">
                <div>
                    <span class="q-id">Q{_escape(card.question_id)}</span>
                    <span class="q-db">{_escape(card.db_id)}</span>
                    <span class="q-model">{_escape(model_short)}</span>
                    <span class="q-config">[{_escape(card.config_type)}]</span>
                </div>
                <div style="flex: 1; margin: 0 20px; color: #888; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                    {_escape(question_preview)}
                </div>
                <div>
                    <span class="metric"><span class="value">{cost_str}</span></span>
                    <span class="metric"><span class="value">{card.duration_ms:.0f}</span>ms</span>
                </div>
                <span class="q-level {_escape(level)}">{_escape(level_display)}</span>{category_badge}
            </div>
            <div class="card-body collapsed">
                {panel1}
                {panel2}
                {panel3}
                {comment_section}
            </div>
        </div>
"""


def _level_display(card: ErrorCard) -> str:
    level = card.correctness_level
    if level == "error":
        return "ERROR"
    if level == "hit_limit":
        return "HIT LIMIT"
    if level == "incorrect":
        return "INCORRECT"
    if level == "partial":
        return "PARTIAL"
    if level == "judge_correct":
        return "CORRECT (JUDGE)"
    if level == "correct":
        ms = card.match_source or ""
        if ms == "platinum":
            return "CORRECT (PLATINUM)"
        return "CORRECT"
    return level.upper()


def _render_question_panel(card: ErrorCard) -> str:
    parts = [
        '<div class="panel">',
        "<h3>Question &amp; Context</h3>",
        f'<div class="question-text">{_escape(card.question_text) or "Not available"}</div>',
    ]

    if card.evidence:
        parts.append(f'<div class="evidence">{_escape(card.evidence)}</div>')

    if card.error_category:
        parts.append('<div class="investigation-section">')
        parts.append("<h4>Error Investigation</h4>")
        parts.append(
            f'<span class="investigation-category">{_escape(card.error_category)}</span>'
        )
        if card.error_description:
            parts.append(
                f'<div class="investigation-description">{_escape(card.error_description)}</div>'
            )
        parts.append("</div>")

    if card.partial_reason:
        parts.append(
            f'<div class="partial-reason">Partial reason: {_escape(card.partial_reason)}</div>'
        )

    parts.append("</div>")
    return "\n".join(parts)


def _render_sql_panel(card: ErrorCard) -> str:
    parts = ['<div class="panel">']

    if card.gold_sql:
        parts.append("<h3>Predicted SQL</h3>")
        if card.predicted_sql:
            parts.append(f'<pre class="sql">{_escape(card.predicted_sql)}</pre>')
        else:
            parts.append('<pre class="error-msg">No SQL generated</pre>')
        parts.append('<h3 style="margin-top: 12px;">Gold SQL</h3>')
        parts.append(f'<pre class="sql">{_escape(card.gold_sql)}</pre>')
    else:
        if card.predicted_sql:
            parts.append(
                f'<details style="margin-bottom: 12px; border: 1px solid #ff8800;">'
                f'<summary style="padding: 6px 10px; cursor: pointer; color: #ff8800; '
                f'font-weight: bold; font-size: 10px; text-transform: uppercase; '
                f'background: #1a1a1a;">Predicted SQL</summary>'
                f'<pre class="sql" style="border-color: #ff8800;">{_escape(card.predicted_sql)}</pre>'
                f'</details>'
            )
        else:
            parts.append("<h3>Predicted SQL</h3>")
            parts.append('<pre class="error-msg">No SQL generated</pre>')

    parts.append('<h3 style="margin-top: 12px;">Results</h3>')

    gold_formatted = _format_result(card.gold_result)
    pred_formatted = _format_result(card.predicted_result)

    gold_is_string = isinstance(card.gold_result, str)
    pred_is_string = isinstance(card.predicted_result, str)

    if gold_is_string:
        gold_label = "GOLD ANSWER"
    else:
        gold_rows = len(card.gold_result) if isinstance(card.gold_result, (list, tuple)) else "?"
        gold_label = f"GOLD ({gold_rows} rows)"

    if pred_is_string:
        pred_label = "PREDICTED ANSWER"
    else:
        pred_rows = len(card.predicted_result) if isinstance(card.predicted_result, (list, tuple)) else "?"
        pred_label = f"PREDICTED ({pred_rows} rows)"

    if card.answer_source and card.answer_source != "official":
        gold_label = f"{gold_label} — {card.answer_source}"

    # gold_label may include answer_source straight from the payload — escape at the boundary
    parts.append('<div class="result-compare">')
    parts.append(
        f'<div class="result-box gold">'
        f'<div class="result-label">{_escape(gold_label)}</div>'
        f'<pre class="result">{gold_formatted}</pre>'
        f"</div>"
    )
    parts.append(
        f'<div class="result-box pred">'
        f'<div class="result-label">{_escape(pred_label)}</div>'
        f'<pre class="result">{pred_formatted}</pre>'
        f"</div>"
    )
    parts.append("</div>")

    if card.match_source:
        parts.append(
            f'<div style="margin-top: 8px; color: #888; font-size: 10px;">'
            f"Match source: {_escape(card.match_source)}</div>"
        )

    parts.append("</div>")
    return "\n".join(parts)

