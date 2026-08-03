"""Criteria-driven scorer for the Agentic Company benchmark.

The DABstep scorer intentionally has permissive compatibility behavior (for
example, sign-insensitive numeric deltas and order-insensitive comma lists).
Those rules conflict with the explicit ``answer_criteria`` shipped by the
Agentic Company questions, so this module is a separate profile-specific seam.
"""

from __future__ import annotations

import re
import unicodedata
from decimal import Decimal, InvalidOperation
from difflib import SequenceMatcher
from typing import Any

from src.score import Correctness, ExecutionError, ExecutionResult, ScoreResult

_NA_VARIANTS = frozenset({"not applicable", "n/a", "na", "none", "null", "-"})
_SUPPORTED_TYPES = frozenset(
    {"number", "string", "label:number", "label:label:number", "list[string]"}
)


def _decimal(value: Any) -> Decimal | None:
    try:
        number = Decimal(str(value).strip())
    except (InvalidOperation, ValueError, TypeError):
        return None
    return number if number.is_finite() else None


def _format_number(value: Any, decimals: int | None) -> str:
    number = _decimal(value)
    if number is None:
        return str(value)
    if decimals is None:
        return format(number, "f")
    if decimals == 0 and number != number.to_integral_value():
        # Integer criteria describe counts/units, not permission to round a
        # fractional wrong aggregate into the correct whole number.
        return format(number, "f")
    return f"{number:.{decimals}f}"


def _format_compound(values: list[Any], decimals: int | None, delimiter: str) -> str:
    if not values:
        return ""
    labels = [str(value) for value in values[:-1]]
    return delimiter.join([*labels, _format_number(values[-1], decimals)])


def format_answer(
    result: list[tuple] | list[list] | None,
    criteria: dict[str, Any],
) -> str:
    """Format SQL rows according to an Agentic Company answer contract."""
    answer_type = str(criteria.get("type") or "")
    if answer_type not in _SUPPORTED_TYPES:
        raise ValueError(f"Unsupported Agentic Company answer type: {answer_type!r}")
    if not result:
        if answer_type == "list[string]":
            return str(criteria.get("empty_answer", ""))
        return "Not Applicable"

    delimiter = str(criteria.get("delimiter") or ":")
    decimals = criteria.get("decimals")
    decimals = int(decimals) if decimals is not None else None

    if answer_type == "number":
        if len(result) != 1 or len(result[0]) != 1:
            return _flatten_unexpected(result)
        return _format_number(result[0][0], decimals)

    if answer_type == "string":
        if len(result) != 1 or len(result[0]) != 1:
            return _flatten_unexpected(result)
        return str(result[0][0])

    if answer_type in {"label:number", "label:label:number"}:
        component_count = 2 if answer_type == "label:number" else 3
        if len(result) != 1:
            return _flatten_unexpected(result)
        row = list(result[0])
        if len(row) == component_count:
            return _format_compound(row, decimals, delimiter)
        if len(row) == 1:
            parts = str(row[0]).split(delimiter)
            if len(parts) == component_count:
                return _format_compound(parts, decimals, delimiter)
        return _flatten_unexpected(result)

    # list[string]: preserve row order. Multi-column rows become colon-delimited
    # compound elements, which supports AC-014 without requiring SQL-side string
    # concatenation.
    if len(result) == 1 and len(result[0]) == 1:
        return str(result[0][0])
    element_type = criteria.get("element_type", "string")
    elements = []
    for row in result:
        if len(row) == 1:
            elements.append(str(row[0]))
        elif element_type == "label:number" and len(row) == 2:
            elements.append(_format_compound(list(row), decimals, ":"))
        else:
            elements.append(":".join(str(value) for value in row))
    return f"{delimiter} ".join(elements)


def _flatten_unexpected(result: list[tuple] | list[list]) -> str:
    return ",".join(str(value) for row in result for value in row)


def _normalize_label(value: str) -> str:
    value = unicodedata.normalize("NFKC", value).casefold().strip()
    value = value.replace("_", " ")
    value = re.sub(r"[^\w]+", " ", value, flags=re.UNICODE)
    return " ".join(value.split())


def _labels_match(predicted: str, gold: str, *, fuzzy: bool = False) -> bool:
    pred_norm = _normalize_label(predicted)
    gold_norm = _normalize_label(gold)
    if pred_norm == gold_norm:
        return True
    return bool(
        fuzzy
        and pred_norm
        and gold_norm
        and SequenceMatcher(None, pred_norm, gold_norm).ratio() > 0.95
    )


def _numbers_match(predicted: str, gold: str, tolerance: Any) -> bool:
    pred_number = _decimal(predicted)
    gold_number = _decimal(gold)
    tol_number = _decimal(tolerance)
    if pred_number is None or gold_number is None or tol_number is None or tol_number < 0:
        return False
    return abs(pred_number - gold_number) <= tol_number


def _compound_match(
    predicted: str,
    gold: str,
    *,
    label_count: int,
    delimiter: str,
    tolerance: Any,
) -> bool:
    pred_parts = [part.strip() for part in predicted.split(delimiter)]
    gold_parts = [part.strip() for part in gold.split(delimiter)]
    expected_count = label_count + 1
    if len(pred_parts) != expected_count or len(gold_parts) != expected_count:
        return False
    if not all(_labels_match(pred_parts[index], gold_parts[index]) for index in range(label_count)):
        return False
    return _numbers_match(pred_parts[-1], gold_parts[-1], tolerance)


def _list_element_match(predicted: str, gold: str, criteria: dict[str, Any]) -> bool:
    if criteria.get("element_type", "string") != "label:number":
        return _labels_match(predicted, gold, fuzzy=True)

    pred_head, pred_sep, pred_tail = predicted.strip().rpartition(":")
    gold_head, gold_sep, gold_tail = gold.strip().rpartition(":")
    if pred_sep and gold_sep:
        return _labels_match(pred_head, gold_head) and _numbers_match(
            pred_tail,
            gold_tail,
            criteria.get("tolerance", 0),
        )
    return False


def answers_match(predicted: str, gold: str, criteria: dict[str, Any]) -> bool:
    """Compare two answer strings using the declared criteria."""
    pred = predicted.strip().strip('"').strip("'")
    expected = gold.strip().strip('"').strip("'")
    pred_na = pred.casefold() in _NA_VARIANTS
    gold_na = expected.casefold() in _NA_VARIANTS
    if pred_na or gold_na:
        return pred_na and gold_na

    answer_type = str(criteria.get("type") or "")
    delimiter = str(criteria.get("delimiter") or ":")
    tolerance = criteria.get("tolerance", 0)

    if answer_type == "number":
        return _numbers_match(pred, expected, tolerance)
    if answer_type == "string":
        return _labels_match(pred, expected, fuzzy=True)
    if answer_type == "label:number":
        return _compound_match(
            pred,
            expected,
            label_count=1,
            delimiter=delimiter,
            tolerance=tolerance,
        )
    if answer_type == "label:label:number":
        return _compound_match(
            pred,
            expected,
            label_count=2,
            delimiter=delimiter,
            tolerance=tolerance,
        )
    if answer_type == "list[string]":
        if pred == "" or expected == "":
            return pred == expected
        pred_items = [item.strip() for item in pred.split(delimiter)]
        gold_items = [item.strip() for item in expected.split(delimiter)]
        if len(pred_items) != len(gold_items):
            return False
        if criteria.get("order_sensitive", False):
            return all(
                _list_element_match(pred_item, gold_item, criteria)
                for pred_item, gold_item in zip(pred_items, gold_items, strict=True)
            )
        unmatched = list(gold_items)
        for pred_item in pred_items:
            match_index = next(
                (
                    index
                    for index, gold_item in enumerate(unmatched)
                    if _list_element_match(pred_item, gold_item, criteria)
                ),
                None,
            )
            if match_index is None:
                return False
            unmatched.pop(match_index)
        return not unmatched
    raise ValueError(f"Unsupported Agentic Company answer type: {answer_type!r}")


def score(
    execution_result: ExecutionResult,
    gold_answer: str,
    criteria: dict[str, Any],
    predicted_sql: str | None,
    hit_limit: bool = False,
) -> ScoreResult:
    """Score one Agentic Company run without DABstep's permissive fallbacks."""
    if hit_limit and isinstance(execution_result, ExecutionError):
        return ScoreResult(
            False,
            Correctness.HIT_LIMIT,
            0.0,
            "none",
            "hit_limit",
            gold_answer,
            None,
        )
    if isinstance(execution_result, ExecutionError):
        return ScoreResult(
            False,
            Correctness.ERROR,
            0.0,
            "none",
            "sql_execution_error" if predicted_sql else "no_sql_produced",
            gold_answer,
            None,
        )

    predicted_answer = format_answer(execution_result, criteria)
    is_correct = answers_match(predicted_answer, gold_answer, criteria)
    return ScoreResult(
        is_correct,
        Correctness.CORRECT if is_correct else Correctness.INCORRECT,
        1.0 if is_correct else 0.0,
        "agentic_criteria" if is_correct else "none",
        None,
        gold_answer,
        predicted_answer,
    )
