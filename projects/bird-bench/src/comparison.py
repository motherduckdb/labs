"""
Result comparison utilities for BIRD-Bench evaluation.

Provides functions for comparing predicted SQL results against gold results
with support for partial matches, floating point tolerance, and various
normalization strategies.
"""

from enum import Enum

from src.constants import (
    FLOAT_DISPLAY_PRECISION,
    FLOAT_RELATIVE_TOLERANCE,
    CLOSE_VALUE_TOLERANCE,
)


class CorrectnessLevel(Enum):
    """Level of correctness for query results."""
    CORRECT = "correct"           # Exact match
    PARTIAL = "partial"           # Partial match (subset of rows/columns, close values)
    INCORRECT = "incorrect"       # No match
    ERROR = "error"               # Query failed to execute
    HIT_LIMIT = "hit_limit"       # Hit tool call iteration limit (10 calls)
    JUDGE_CORRECT = "judge_correct"  # LLM judge approved as correct


def normalize_value(val):
    """
    Normalize a value for comparison.

    Handles:
    - None values
    - Boolean normalization (True/False, "true"/"false", "yes"/"no" → 1/0)
    - Integer/float equivalence (118.0 → 118)
    - String whitespace trimming
    - Numeric string conversion (including scientific notation)
    - Case-insensitive strings
    """
    if val is None:
        return None

    # Boolean normalization
    if isinstance(val, bool):
        return 1 if val else 0

    # Integer/float equivalence: 118.0 → 118
    if isinstance(val, float):
        if val.is_integer():
            return int(val)
        return val  # Don't round here - let adaptive precision handle it

    if isinstance(val, str):
        val = val.strip()

        # Boolean strings (true/false, yes/no)
        if val.lower() in ('true', 'yes'):
            return 1
        if val.lower() in ('false', 'no'):
            return 0

        # Try numeric conversion (including scientific notation)
        try:
            if '.' in val or 'e' in val.lower():
                f = float(val)
                if f.is_integer():
                    return int(f)
                return f  # Don't round - let adaptive precision handle it
            return int(val)
        except ValueError:
            return val.lower()

    return val


def normalize_row(row) -> tuple:
    """Normalize a row (tuple/list) for comparison."""
    return tuple(normalize_value(v) for v in row)


def normalize_results(results: list) -> set[tuple]:
    """
    Normalize results to a set of tuples for comparison.

    Args:
        results: List of rows (tuples or lists)

    Returns:
        Set of normalized tuples
    """
    if not results:
        return set()
    return set(normalize_row(row) for row in results)


def _get_decimal_places(val) -> int | None:
    """
    Get number of decimal places in a numeric value.

    Uses the original value (before normalization) to determine precision.
    """
    if isinstance(val, int):
        return 0
    if isinstance(val, float):
        # Avoid scientific notation, get actual decimal representation
        s = f"{val:.10f}".rstrip('0')
        if '.' in s:
            decimal_part = s.split('.')[1]
            return len(decimal_part) if decimal_part else 0
        return 0
    if isinstance(val, str):
        try:
            float(val)  # Verify it's numeric
            if '.' in val:
                # Handle trailing zeros: "24.60" has 2 decimal places
                decimal_part = val.split('.')[1]
                return len(decimal_part.rstrip('0')) or 0
            return 0
        except ValueError:
            return None
    return None


def values_equal_adaptive(gold_val, pred_val) -> bool:
    """
    Compare values using gold's precision for rounding, with tolerance fallback.

    If gold has 2 decimal places, round predicted to 2 places before comparing.
    This handles cases like gold=24.67 matching predicted=24.6666667.

    If rounding-based comparison fails, falls back to relative tolerance (0.01%)
    to handle floating-point precision differences.
    """
    # Normalize types first
    g = normalize_value(gold_val)
    p = normalize_value(pred_val)

    if g is None and p is None:
        return True
    if g is None or p is None:
        return False

    # Both numeric - use gold's precision first, then fall back to tolerance
    if isinstance(g, (int, float)) and isinstance(p, (int, float)):
        gold_precision = _get_decimal_places(gold_val)  # Use original, not normalized
        if gold_precision is not None and gold_precision >= 0:
            g_rounded = round(float(g), gold_precision)
            p_rounded = round(float(p), gold_precision)
            if g_rounded == p_rounded:
                return True
        # Always fall back to relative tolerance if rounding didn't match
        return values_equal(g, p)

    # String comparison - already lowercased by normalize_value
    if isinstance(g, str) and isinstance(p, str):
        return g == p

    return g == p


def rows_equal_adaptive(gold_row, pred_row) -> bool:
    """Compare rows using adaptive precision."""
    if len(gold_row) != len(pred_row):
        return False
    return all(values_equal_adaptive(gv, pv) for gv, pv in zip(gold_row, pred_row))


def values_equal(v1, v2, rel_tol: float = FLOAT_RELATIVE_TOLERANCE) -> bool:
    """
    Compare two values with type normalization and floating point tolerance.

    Args:
        v1, v2: Values to compare
        rel_tol: Relative tolerance for float comparison
    """
    v1 = normalize_value(v1)
    v2 = normalize_value(v2)

    if v1 is None and v2 is None:
        return True
    if v1 is None or v2 is None:
        return False
    if isinstance(v1, (int, float)) and isinstance(v2, (int, float)):
        if v1 == 0 and v2 == 0:
            return True
        if v1 == 0 or v2 == 0:
            return abs(v1 - v2) < rel_tol
        return abs(v1 - v2) / max(abs(v1), abs(v2)) < rel_tol
    # String comparison - case insensitive
    if isinstance(v1, str) and isinstance(v2, str):
        return v1.lower() == v2.lower()
    return v1 == v2


def rows_equal(r1, r2) -> bool:
    """Compare two rows with tolerance."""
    if len(r1) != len(r2):
        return False
    return all(values_equal(v1, v2) for v1, v2 in zip(r1, r2))


def results_match(gold: list, predicted: list) -> bool:
    """
    Simple boolean comparison of gold vs predicted results.

    Use this for optimization/simple checks where you only need
    a bool result. For detailed comparison with partial match
    detection, use compare_results() instead.

    Args:
        gold: Gold/expected results
        predicted: Predicted results

    Returns:
        True if results match exactly (order-independent)
    """
    if not gold or not predicted:
        return False
    if isinstance(gold, str) and "ERROR" in gold:
        return False
    if isinstance(predicted, str) and "ERROR" in predicted:
        return False

    try:
        gold_set = normalize_results(gold)
        pred_set = normalize_results(predicted)
        return gold_set == pred_set
    except Exception:
        return gold == predicted


def _row_values_match_subset(gold_row, pred_row) -> bool:
    """Check if all values in gold_row appear in pred_row."""
    return all(any(values_equal(gv, pv) for pv in pred_row) for gv in gold_row)


def _is_exact_match(gold: list, predicted: list) -> bool:
    """
    Check if gold and predicted results match exactly.

    Handles different row ordering by matching each gold row
    to a predicted row without replacement. Uses adaptive precision.
    """
    if len(gold) != len(predicted):
        return False
    if len(gold[0]) != len(predicted[0]):
        return False

    used_pred = [False] * len(predicted)
    for g_row in gold:
        found = False
        for i, p_row in enumerate(predicted):
            if not used_pred[i] and rows_equal_adaptive(g_row, p_row):
                used_pred[i] = True
                found = True
                break
        if not found:
            return False
    return True


def _check_missing_columns(gold: list, predicted: list) -> str | None:
    """
    Check if predicted has fewer columns but values are correct.

    Returns reason string if partial match, None otherwise.
    """
    gold_cols = len(gold[0])
    pred_cols = len(predicted[0])

    if pred_cols >= gold_cols or len(gold) != len(predicted):
        return None

    for g_row, p_row in zip(sorted(gold), sorted(predicted)):
        if not all(any(values_equal(pv, gv) for gv in g_row) for pv in p_row):
            return None

    return f"missing_columns:{gold_cols - pred_cols}"


def _check_extra_columns(gold: list, predicted: list) -> str | None:
    """
    Check if predicted has more columns but includes all gold values.

    Returns reason string if partial match, None otherwise.
    """
    gold_cols = len(gold[0])
    pred_cols = len(predicted[0])

    if pred_cols <= gold_cols or len(gold) != len(predicted):
        return None

    for g_row, p_row in zip(sorted(gold), sorted(predicted)):
        if not _row_values_match_subset(g_row, p_row):
            return None

    return f"extra_columns:{pred_cols - gold_cols}"


def _check_implicit_distinct(gold: list, predicted: list) -> str | None:
    """
    Check if predicted matches deduplicated gold results.

    This handles the case where gold SQL doesn't use DISTINCT but
    predicted SQL does (or the question implied unique values).

    Returns reason string if partial match, None otherwise.
    """
    gold_cols = len(gold[0])
    pred_cols = len(predicted[0])

    # Must have same columns
    if gold_cols != pred_cols:
        return None

    # Predicted must have fewer rows
    if len(predicted) >= len(gold):
        return None

    # Deduplicate gold and compare using adaptive precision
    gold_unique = set()
    for row in gold:
        # Use normalized row for set comparison
        gold_unique.add(normalize_row(row))

    # Check if gold actually has duplicates
    if len(gold_unique) == len(gold):
        return None  # No duplicates in gold, not an implicit DISTINCT case

    pred_set = set(normalize_row(row) for row in predicted)

    # Check if predicted matches deduplicated gold exactly
    if gold_unique == pred_set:
        duplicates_removed = len(gold) - len(gold_unique)
        return f"implicit_distinct:{duplicates_removed}_duplicates_removed"

    return None


def _check_extra_duplicates(gold: list, predicted: list) -> str | None:
    """
    Check if predicted has extra duplicate rows but unique values match gold.

    This handles the case where predicted returns more rows than gold,
    but when deduplicated, matches gold exactly. Common when model
    doesn't use DISTINCT but gold does.

    Returns reason string if partial match, None otherwise.
    """
    gold_cols = len(gold[0])
    pred_cols = len(predicted[0])

    # Must have same columns
    if gold_cols != pred_cols:
        return None

    # Predicted must have more rows than gold
    if len(predicted) <= len(gold):
        return None

    # Check unique values
    gold_unique = set(normalize_row(row) for row in gold)
    pred_unique = set(normalize_row(row) for row in predicted)

    # Predicted must have duplicates
    if len(pred_unique) == len(predicted):
        return None  # No duplicates in predicted

    # Check if unique predicted matches gold exactly
    if gold_unique == pred_unique:
        extra_duplicates = len(predicted) - len(pred_unique)
        return f"extra_duplicates:{extra_duplicates}_duplicates_in_predicted"

    return None


def _check_aggregated_equivalent(gold: list, predicted: list) -> str | None:
    """
    Check if predicted is single-row aggregation of multi-row gold.

    This handles cases where gold returns multiple identical rows
    and predicted returns a single aggregated row.

    Example:
        Gold: [("YES",), ("YES",), ("YES",)]
        Predicted: [("YES",)]
        Result: PARTIAL with reason "aggregated_equivalent:3_to_1"

    Returns reason string if partial match, None otherwise.
    """
    # Predicted must be single row
    if len(predicted) != 1:
        return None

    # Gold must have multiple rows
    if len(gold) <= 1:
        return None

    # Same column count
    if len(gold[0]) != len(predicted[0]):
        return None

    # Check if all gold rows are identical to predicted row
    pred_normalized = normalize_row(predicted[0])
    all_match = all(
        normalize_row(g_row) == pred_normalized
        for g_row in gold
    )

    if all_match:
        return f"aggregated_equivalent:{len(gold)}_to_1"

    return None


def _check_missing_rows(gold: list, predicted: list) -> str | None:
    """
    Check if predicted has fewer rows (all predicted rows match gold).

    Returns reason string if detected (this is INCORRECT, not partial).
    Uses adaptive precision for row comparison.
    """
    gold_cols = len(gold[0])
    pred_cols = len(predicted[0])

    if gold_cols != pred_cols or len(predicted) >= len(gold):
        return None

    matches = sum(
        1 for p_row in predicted
        if any(rows_equal_adaptive(p_row, g_row) for g_row in gold)
    )

    if matches == len(predicted) and matches > 0:
        return f"missing_rows:{len(gold) - len(predicted)}"

    return None


def _check_extra_rows(gold: list, predicted: list) -> str | None:
    """
    Check if predicted includes all gold rows plus extra.

    Returns reason string if partial match, None otherwise.
    Uses adaptive precision for row comparison.
    """
    gold_cols = len(gold[0])
    pred_cols = len(predicted[0])

    if gold_cols != pred_cols or len(predicted) <= len(gold):
        return None

    matches = sum(
        1 for g_row in gold
        if any(rows_equal_adaptive(g_row, p_row) for p_row in predicted)
    )

    if matches == len(gold):
        return f"extra_rows:{len(predicted) - len(gold)}"

    return None


def _check_close_values(gold: list, predicted: list) -> str | None:
    """
    Check if single-row results have values within 5% tolerance.

    Returns reason string if partial match, None otherwise.
    """
    if len(gold) != 1 or len(predicted) != 1:
        return None

    g_row, p_row = gold[0], predicted[0]
    if len(g_row) != len(p_row):
        return None

    close_count = 0
    for gv, pv in zip(g_row, p_row):
        if isinstance(gv, (int, float)) and isinstance(pv, (int, float)):
            if gv != 0 and abs(gv - pv) / abs(gv) < CLOSE_VALUE_TOLERANCE:
                close_count += 1

    if close_count == len(g_row):
        return "values_close_not_exact"

    return None


def compare_results(gold: list, predicted: list) -> tuple[CorrectnessLevel, str | None]:
    """
    Compare gold and predicted results with partial match detection.

    Returns:
        (CorrectnessLevel, reason) tuple where reason explains partial matches

    Handles:
    - Different row ordering
    - Floating point precision (relative tolerance)
    - Partial matches:
        - Missing columns (predicted has fewer)
        - Extra columns (predicted has more)
        - Extra rows (predicted includes all gold plus more)
        - Values close but not exact
    """
    # Handle error cases
    if isinstance(gold, str) and "ERROR" in gold:
        return CorrectnessLevel.ERROR, "gold_query_error"
    if isinstance(predicted, str) and "ERROR" in predicted:
        return CorrectnessLevel.ERROR, "predicted_query_error"
    if not gold and not predicted:
        return CorrectnessLevel.CORRECT, None
    if not gold or not predicted:
        return CorrectnessLevel.INCORRECT, "empty_result"

    try:
        # Check exact match first
        if _is_exact_match(gold, predicted):
            return CorrectnessLevel.CORRECT, None

        # Check partial match conditions
        if reason := _check_missing_columns(gold, predicted):
            return CorrectnessLevel.PARTIAL, reason

        if reason := _check_extra_columns(gold, predicted):
            return CorrectnessLevel.PARTIAL, reason

        # Check if predicted is single-row aggregation of multi-row identical gold
        # (must come before implicit_distinct since it's a more specific case)
        if reason := _check_aggregated_equivalent(gold, predicted):
            return CorrectnessLevel.PARTIAL, reason

        # Check if predicted is deduplicated gold (implicit DISTINCT)
        if reason := _check_implicit_distinct(gold, predicted):
            return CorrectnessLevel.PARTIAL, reason

        # Check if predicted has extra duplicates but unique values match gold
        if reason := _check_extra_duplicates(gold, predicted):
            return CorrectnessLevel.PARTIAL, reason

        # Missing rows is INCORRECT (query fundamentally wrong)
        if reason := _check_missing_rows(gold, predicted):
            return CorrectnessLevel.INCORRECT, reason

        if reason := _check_extra_rows(gold, predicted):
            return CorrectnessLevel.PARTIAL, reason

        if reason := _check_close_values(gold, predicted):
            return CorrectnessLevel.PARTIAL, reason

        return CorrectnessLevel.INCORRECT, None

    except Exception as e:
        if gold == predicted:
            return CorrectnessLevel.CORRECT, None
        return CorrectnessLevel.INCORRECT, f"comparison_error:{str(e)[:50]}"


def compare_results_simple(result1: list, result2: list) -> tuple[bool, str | None]:
    """
    Simple comparison returning (match, mismatch_type).

    Used for audit/validation where partial match details aren't needed.

    Args:
        result1, result2: Results to compare

    Returns:
        (match: bool, mismatch_type: str | None)
    """
    if result1 is None or result2 is None:
        return False, "error"

    if len(result1) != len(result2):
        return False, "row_count_mismatch"

    set1 = normalize_results(result1)
    set2 = normalize_results(result2)

    if set1 == set2:
        return True, None

    return False, "value_mismatch"


def _parse_platinum_result(platinum_result: str | list) -> list:
    """
    Parse platinum_result from stored format to normalized row format.

    Platinum results may be stored as:
    - A proper list of rows: [['col1', 'col2'], ['val1', 'val2']]
    - A flat list: [203.8] or ['value1', 'value2']
    - A string of Python list literals: "['Yosemite High']\n['Novato High']..."
    - A string with "sampled X of Y" suffix that needs trimming

    Returns:
        List of rows in format [[val1, val2, ...], [val1, val2, ...], ...]
        suitable for comparison with model results
    """
    import ast

    def normalize_to_rows(data: list) -> list:
        """Ensure data is in row format [[val], [val], ...]."""
        if not data:
            return []
        # Check if it's already row format (list of lists)
        if data and isinstance(data[0], list):
            return data
        # It's a flat list - treat each element as a single-column row
        # But first check if it's a single-value result like [203.8]
        # In that case, wrap it as [[203.8]]
        return [[item] for item in data]

    # Already a list - normalize to row format
    if isinstance(platinum_result, list):
        return normalize_to_rows(platinum_result)

    # Not a string - unexpected type
    if not isinstance(platinum_result, str):
        return []

    # Strip sampling note if present (e.g., "... (sampled 20 of 341 total rows)")
    result_str = platinum_result
    if "\n... (sampled" in result_str:
        result_str = result_str.split("\n... (sampled")[0]

    # Try parsing as a single Python literal first (handles simple cases like "[203.8]")
    try:
        parsed = ast.literal_eval(result_str)
        if isinstance(parsed, list):
            return normalize_to_rows(parsed)
    except (ValueError, SyntaxError):
        pass

    # Parse newline-separated list of Python row literals
    # Format: "['val1']\n['val2']\n..."
    rows = []
    for line in result_str.strip().split("\n"):
        line = line.strip()
        if not line:
            continue
        try:
            row = ast.literal_eval(line)
            # Ensure each row is a list (single values become single-element lists)
            if isinstance(row, list):
                rows.append(row)
            else:
                rows.append([row])
        except (ValueError, SyntaxError):
            # If we can't parse the line, skip it
            continue

    return rows


def compare_with_platinum_fallback(
    gold_result: list,
    predicted_result: list,
    question_id: int,
    platinum_answers: dict[int, dict],
) -> tuple[CorrectnessLevel, str | None, str]:
    """
    Compare results with platinum fallback.

    If predicted doesn't match gold, check if it matches platinum.

    Args:
        gold_result: Expected gold result
        predicted_result: Model's predicted result
        question_id: Question ID for platinum lookup
        platinum_answers: Dict mapping question_id -> platinum entry

    Returns:
        (level, reason, match_source) where match_source is "gold", "platinum", or "none"
    """
    # Try gold first
    level, reason = compare_results(gold_result, predicted_result)
    if level == CorrectnessLevel.CORRECT:
        return level, reason, "gold"

    # Try platinum fallback
    if question_id in platinum_answers:
        platinum_entry = platinum_answers[question_id]
        platinum_result_raw = platinum_entry.get("platinum_result")

        if platinum_result_raw is not None:
            # Parse string-formatted platinum results to list
            platinum_result = _parse_platinum_result(platinum_result_raw)
            if platinum_result:
                plat_level, plat_reason = compare_results(platinum_result, predicted_result)
                if plat_level == CorrectnessLevel.CORRECT:
                    return CorrectnessLevel.CORRECT, "platinum_match", "platinum"

    # Return original comparison result
    return level, reason, "none"
