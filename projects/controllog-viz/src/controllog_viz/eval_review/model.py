"""Data model and extraction for the evaluation review.

Loads ``evaluation_result`` payloads into ErrorCard/ReportData, and holds the small
shared text helpers (escaping, result formatting, model-name shortening) used by both
the trace renderer and the page assembler.
"""
from __future__ import annotations

import html as _html_module
import json
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

import duckdb


LEVEL_ORDER = {
    "error": 0,
    "hit_limit": 1,
    "incorrect": 2,
    "partial": 3,
    "correct": 4,
    "judge_correct": 4,
}

QUESTION_PREVIEW_LENGTH = 100
MAX_RESULT_ROWS = 20


# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------


@dataclass
class ErrorCard:
    """All data for one card in the report."""

    question_id: str
    db_id: str
    question_text: str
    evidence: str | None
    model: str
    config_type: str
    database: str
    predicted_sql: str | None
    gold_sql: str | None
    gold_result: Any
    predicted_result: Any
    is_correct: bool
    correctness_level: str
    match_source: str | None
    partial_reason: str | None
    hit_iteration_limit: bool
    score: float
    tool_calls: int
    sql_errors: int
    query_count: int
    total_sql_time_ms: float
    duration_ms: float
    cost_usd: float | None
    input_tokens: int
    output_tokens: int
    raw_response: dict | None = None
    error_category: str | None = None
    error_description: str | None = None
    answer_source: str | None = None


@dataclass
class ReportData:
    """Container for all report data."""

    cards: list[ErrorCard]
    title: str
    generated_at: str
    total: int = 0
    correct_count: int = 0
    error_count: int = 0
    hit_limit_count: int = 0
    incorrect_count: int = 0
    partial_count: int = 0


# ---------------------------------------------------------------------------
# Data loading — from the controllog-viz reader (events view), scoped to a run
# ---------------------------------------------------------------------------


def _to_float(value, default: float = 0.0) -> float:
    """Coerce a payload value to float, falling back to ``default`` for malformed input.

    cost_usd / duration_ms are formatted with ``:.4f`` / ``:.0f`` in the card header, so a
    non-numeric value (e.g. a string in a malformed event) would otherwise raise and break
    the whole review render.
    """
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _to_float_or_none(value) -> float | None:
    """Like :func:`_to_float` but preserves None (renders 'n/a') and maps junk to None."""
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def has_eval_results(con: duckdb.DuckDBPyConnection, run_id: str | None) -> bool:
    """True if the run has any ``evaluation_result`` events (→ use the rich review)."""
    n = con.execute(
        "SELECT COUNT(*) FROM events WHERE kind = 'evaluation_result' "
        "AND run_id IS NOT DISTINCT FROM ?",
        [run_id],
    ).fetchone()[0]
    return n > 0


def build_report_data(con: duckdb.DuckDBPyConnection, run_id: str | None, title: str) -> ReportData:
    """Build ReportData from the run's ``evaluation_result`` events."""
    rows = con.execute(
        "SELECT CAST(payload_json AS VARCHAR) FROM events "
        "WHERE kind = 'evaluation_result' AND run_id IS NOT DISTINCT FROM ? "
        "ORDER BY event_time",
        [run_id],
    ).fetchall()

    cards: list[ErrorCard] = []
    for (payload_raw,) in rows:
        payload = json.loads(payload_raw) if isinstance(payload_raw, str) else payload_raw
        cards.append(
            ErrorCard(
                question_id=str(payload.get("question_id", "")),
                db_id=payload.get("db_id", ""),
                question_text=payload.get("question_text", ""),
                evidence=payload.get("evidence"),
                model=payload.get("model", ""),
                config_type=payload.get("config_type", ""),
                database=payload.get("database", ""),
                predicted_sql=payload.get("predicted_sql"),
                gold_sql=payload.get("gold_sql"),
                gold_result=payload.get("gold_result"),
                predicted_result=payload.get("predicted_result"),
                is_correct=payload.get("is_correct", False),
                correctness_level=payload.get("correctness_level", "incorrect"),
                match_source=payload.get("match_source"),
                partial_reason=payload.get("partial_reason"),
                hit_iteration_limit=payload.get("hit_iteration_limit", False),
                score=1.0 if payload.get("is_correct", False) else 0.0,
                tool_calls=payload.get("tool_calls", 0),
                sql_errors=payload.get("sql_errors", 0),
                query_count=payload.get("query_count", 0),
                total_sql_time_ms=_to_float(payload.get("total_sql_time_ms", 0.0)),
                duration_ms=_to_float(payload.get("duration_ms", 0.0)),
                cost_usd=_to_float_or_none(payload.get("cost_usd")),
                input_tokens=payload.get("input_tokens", 0),
                output_tokens=payload.get("output_tokens", 0),
                raw_response=payload.get("raw_response"),
                error_category=payload.get("error_category"),
                error_description=payload.get("error_description"),
                answer_source=payload.get("answer_source"),
            )
        )

    cards.sort(key=_card_sort_key)
    return _build_report_data(cards, title)


def _card_sort_key(card: ErrorCard) -> tuple:
    """Errors first, then hit_limit, incorrect, partial, correct; then question_id."""
    return (LEVEL_ORDER.get(card.correctness_level, 3), card.question_id)


def _build_report_data(cards: list[ErrorCard], title: str) -> ReportData:
    total = len(cards)
    correct = sum(1 for c in cards if c.correctness_level in ("correct", "judge_correct"))
    error = sum(1 for c in cards if c.correctness_level == "error")
    hit_limit = sum(1 for c in cards if c.correctness_level == "hit_limit")
    incorrect = sum(1 for c in cards if c.correctness_level == "incorrect")
    partial = sum(1 for c in cards if c.correctness_level == "partial")
    return ReportData(
        cards=cards,
        title=title,
        generated_at=datetime.now(UTC).isoformat(),
        total=total,
        correct_count=correct,
        error_count=error,
        hit_limit_count=hit_limit,
        incorrect_count=incorrect,
        partial_count=partial,
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _escape(text: str | None) -> str:
    if text is None:
        return ""
    return _html_module.escape(str(text))


def _format_result(result: Any) -> str:
    """Format an evaluation result for display, truncating at MAX_RESULT_ROWS."""
    if result is None:
        return "No result"
    if isinstance(result, str):
        return _escape(result)
    if isinstance(result, (list, tuple)):
        if len(result) == 0:
            return "Empty result set"
        display = list(result[:MAX_RESULT_ROWS])
        text = json.dumps(display, indent=2, default=str)
        if len(result) > MAX_RESULT_ROWS:
            text += f"\n... ({len(result) - MAX_RESULT_ROWS} more rows)"
        return _escape(text)
    if isinstance(result, dict):
        return _escape(json.dumps(result, indent=2, default=str))
    return _escape(str(result))


def _model_short_name(model: str) -> str:
    return model.split("/")[-1] if "/" in model else model

