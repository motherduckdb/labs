"""DABstep scorer — verbatim port of agentic-sql's `src/benchmarks/dabstep.py`.

Every rule, exception, and edge case from the upstream scorer is preserved:
- `format_sql_result_as_answer` — SQL rows → answer string (with bracket-KV,
  list separator, decimal precision, colon-KV detection).
- `normalize_to_gold_format` — coerce predicted format to gold's structure
  without changing values (brackets, decimals, separator, KV spacing, case).
- `_fallback_scorer` — case-insensitive match, bracket/quote normalization,
  N/A equivalence, float tolerance, order-insensitive lists, prefix match.
- The official `dabstep_benchmark.evaluation.scorer.question_scorer` is used
  when installed; the fallback runs otherwise.

Streamlining vs upstream: collapses the BenchmarkAdapter abstraction into a
single `score()` function. No partial-credit machinery — DABstep doesn't
emit partials.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from enum import Enum
from typing import Any


@dataclass
class ExecutionError:
    """Typed error for SQL execution failures."""

    exception_type: str
    message: str

    def __str__(self) -> str:
        return f"ERROR: {self.message}"


ExecutionResult = list[tuple] | ExecutionError


class Correctness(Enum):
    CORRECT = "correct"
    INCORRECT = "incorrect"
    ERROR = "error"
    HIT_LIMIT = "hit_limit"


@dataclass
class ScoreResult:
    is_correct: bool
    correctness: Correctness
    score: float  # 0.0 or 1.0
    match_source: str  # "dabstep_scorer" | "fallback" | "none"
    reason: str | None  # "no_sql_produced" | "sql_execution_error" | "empty_prediction" | None
    gold_answer: str | None
    predicted_answer: str | None


# ---------------------------------------------------------------------------
# Format detection
# ---------------------------------------------------------------------------


def _detect_list_separator(guidelines: str | None) -> str:
    """If guidelines show ``eg: A, B, C`` use ``", "``; else ``","``."""
    if guidelines and re.search(r"eg:\s*\w+,\s+\w+", guidelines):
        return ", "
    return ","


def _detect_colon_kv_format(guidelines: str | None) -> bool:
    """``{card_scheme}:{fee}`` → join two columns with a colon."""
    if not guidelines:
        return False
    return bool(re.search(r"\{\w+\}:\{\w+\}", guidelines))


def _detect_bracket_format(guidelines: str | None) -> bool:
    """``[grouping_i: amount_i, ]`` → wrap answer in square brackets."""
    if not guidelines:
        return False
    return bool(re.search(r"\[.*\w+_i\s*:\s*\w+_i", guidelines))


def _normalize_brackets_quotes(s: str) -> str:
    """``['C']`` → ``C``;  ``['A', 'B']`` → ``A, B``."""
    s = s.strip()
    if s.startswith("[") and s.endswith("]"):
        inner = s[1:-1].strip()
        parts = [p.strip().strip("'\"") for p in inner.split(",")]
        s = ", ".join(parts)
    return s


_NA_VARIANTS = frozenset({
    "", "not applicable", "n/a", "none", "na", "null", "-",
})


# ---------------------------------------------------------------------------
# Fallback scorer (used when official dabstep_benchmark isn't installed)
# ---------------------------------------------------------------------------


def _fallback_scorer(predicted: str, gold: str) -> bool:
    """Mirror of upstream `_fallback_scorer`. See module docstring."""
    pred_stripped = predicted.strip().strip('"')
    gold_stripped = gold.strip().strip('"')

    # 1. Direct case-insensitive match
    if pred_stripped.lower() == gold_stripped.lower():
        return True

    # 2. Normalize brackets/quotes and compare
    pred_norm = _normalize_brackets_quotes(pred_stripped)
    gold_norm = _normalize_brackets_quotes(gold_stripped)
    if pred_norm.lower() == gold_norm.lower():
        return True

    # 3. Empty / "Not Applicable" equivalence
    if pred_norm.lower() in _NA_VARIANTS and gold_norm.lower() in _NA_VARIANTS:
        return True

    # 4. Float comparison for purely numeric answers
    try:
        gold_num = float(gold_norm)
        pred_num = float(pred_norm)
        if gold_num == 0:
            return abs(pred_num) < 1e-9
        if abs(gold_num - pred_num) / max(abs(gold_num), 1e-15) < 1e-9:
            return True
        # HF scorer accepts both signs for delta/difference answers
        return abs(abs(gold_num) - abs(pred_num)) / max(abs(gold_num), 1e-15) < 1e-9
    except ValueError:
        pass

    # 5. Order-insensitive list comparison for comma-separated values
    if "," in gold_norm and "," in pred_norm:
        gold_items = sorted(x.strip().lower() for x in gold_norm.split(","))
        pred_items = sorted(x.strip().lower() for x in pred_norm.split(","))
        if gold_items == pred_items:
            return True

    # 6. Prefix match (non-numeric singletons only)
    def _is_non_numeric_single(s: str) -> bool:
        if "," in s:
            return False
        try:
            float(s)
            return False
        except ValueError:
            return True

    if gold_norm and pred_norm:
        g_low = gold_norm.lower()
        p_low = pred_norm.lower()
        if (
            _is_non_numeric_single(gold_norm)
            and p_low.startswith(g_low)
            and len(p_low) > len(g_low)
            and p_low[len(g_low)] in (":", ",", ";")
        ):
            return True
        if (
            _is_non_numeric_single(pred_norm)
            and g_low.startswith(p_low)
            and len(g_low) > len(p_low)
            and g_low[len(p_low)] in (":", ",", ";")
        ):
            return True

    return False


# ---------------------------------------------------------------------------
# Format normalization (predicted → gold's structure, never values)
# ---------------------------------------------------------------------------


def normalize_to_gold_format(predicted: str, gold: str) -> str:
    """Coerce predicted answer's FORMAT to match gold's structure.

    Rules in order:
      1. Bracket wrapping
      2. Decimal precision
      3. Separator (comma vs comma-space)
      4. KV format (colon spacing)
      5. Case matching (yes/no, country codes, single words)

    Bails out unchanged on empty / N/A / mismatched element or numeric counts.
    """
    if not predicted or not gold:
        return predicted
    if predicted.strip().lower() in ("not applicable", "") or gold.strip().lower() in (
        "not applicable",
        "",
    ):
        return predicted

    gold_has_brackets = gold.startswith("[") and gold.endswith("]")
    pred_has_brackets = predicted.startswith("[") and predicted.endswith("]")

    gold_inner = gold[1:-1] if gold_has_brackets else gold
    pred_inner = predicted[1:-1] if pred_has_brackets else predicted

    gold_parts = [p.strip() for p in gold_inner.split(",")]
    pred_parts = [p.strip() for p in pred_inner.split(",")]

    if len(gold_parts) != len(pred_parts):
        return predicted

    def _count_numerics(parts: list[str]) -> int:
        count = 0
        for part in parts:
            val = part.split(":")[-1].strip() if ":" in part else part
            try:
                float(val)
                count += 1
            except ValueError:
                pass
        return count

    if _count_numerics(gold_parts) != _count_numerics(pred_parts):
        return predicted

    # Rule 4: KV spacing detection
    gold_kv_spaced = any(re.match(r".+:\s+.+", p) for p in gold_parts)
    gold_kv_nospace = any(re.match(r".+:\S", p) for p in gold_parts)
    gold_has_kv = gold_kv_spaced or gold_kv_nospace

    # Rule 2: Decimal precision per element
    normalized_parts: list[str] = []
    for gp, pp in zip(gold_parts, pred_parts, strict=True):
        g_key, g_val = (gp.split(":", 1) if ":" in gp and gold_has_kv else (None, gp))
        p_key, p_val = (pp.split(":", 1) if ":" in pp and gold_has_kv else (None, pp))

        if g_key is not None:
            g_val = g_val.strip()
            p_val = p_val.strip() if p_val else p_val
            p_key = p_key.strip() if p_key else p_key

        try:
            pred_num = float(p_val.strip() if p_val else "")
            gold_val_str = g_val.strip() if g_val else ""
            if "." in gold_val_str:
                decimals = len(gold_val_str.split(".")[-1])
                p_val = f"{pred_num:.{decimals}f}"
            elif gold_val_str:
                try:
                    float(gold_val_str)
                    p_val = f"{pred_num:.0f}" if "." not in gold_val_str else p_val
                except ValueError:
                    pass
        except (ValueError, AttributeError):
            pass

        if g_key is not None and p_key is not None:
            if gold_kv_spaced:
                normalized_parts.append(f"{p_key}: {p_val}")
            else:
                normalized_parts.append(f"{p_key}:{p_val}")
        else:
            normalized_parts.append(p_val if p_val else pp)

    # Rule 3: Separator
    if len(gold_parts) > 1:
        gold_uses_comma_space = ", " in gold_inner
        separator = ", " if gold_uses_comma_space else ","
    else:
        separator = ", "

    result = separator.join(normalized_parts)

    # Rule 1: Bracket wrapping
    if gold_has_brackets:
        result = f"[{result}]"

    # Rule 5: Case matching
    result = _apply_case_matching(
        result, gold, gold_parts, gold_inner, gold_has_kv, gold_has_brackets, separator
    )

    return result


def _apply_case_matching(
    result: str,
    gold: str,
    gold_parts: list[str],
    gold_inner: str,
    gold_has_kv: bool,
    gold_has_brackets: bool,
    separator: str,
) -> str:
    def _wrap(value: str) -> str:
        return f"[{value}]" if gold_has_brackets else value

    def _is_case_matchable(gold_s: str, result_s: str) -> bool:
        if result_s.lower() != gold_s.lower():
            return False
        if len(gold_s) == 2 and gold_s.isupper():
            return True
        return " " not in gold_s and gold_s.isalpha()

    if len(gold_parts) == 1 and not gold_has_kv:
        gold_stripped = gold[1:-1].strip() if gold_has_brackets else gold.strip()
        result_stripped = result[1:-1].strip() if gold_has_brackets else result.strip()

        yes_no_keys = {"yes", "no", "true", "false"}
        if result_stripped.lower() in yes_no_keys and gold_stripped.lower() in yes_no_keys:
            return _wrap(gold_stripped)

        if _is_case_matchable(gold_stripped, result_stripped):
            return _wrap(gold_stripped)

    elif len(gold_parts) > 1:
        final_parts = result[1:-1].split(separator) if gold_has_brackets else result.split(separator)
        gold_ref_parts = gold_inner.split(",")
        updated = False
        new_parts = []
        for fp, grp in zip(final_parts, gold_ref_parts, strict=True):
            fp_s = fp.strip()
            grp_s = grp.strip()
            if _is_case_matchable(grp_s, fp_s):
                new_parts.append(grp_s)
                updated = True
            else:
                new_parts.append(fp_s)
        if updated:
            result = separator.join(new_parts)
            if gold_has_brackets:
                result = f"[{result}]"

    return result


# ---------------------------------------------------------------------------
# SQL result → answer string
# ---------------------------------------------------------------------------


def format_sql_result_as_answer(
    result: list | None, guidelines: str | None = None
) -> str:
    """Format SQL rows as a DABstep answer string."""
    if not result:
        return "Not Applicable"

    separator = _detect_list_separator(guidelines)

    # Single value
    if len(result) == 1 and len(result[0]) == 1:
        value = result[0][0]
        formatted = _format_value(value, guidelines)

        # STRING_AGG(col, ', ') → "IT, ES, FR" but guidelines want comma-no-space.
        # Skip for bracket-KV where comma-space is intentional.
        if (
            isinstance(value, str)
            and ", " in formatted
            and separator == ","
            and not _detect_bracket_format(guidelines)
        ):
            formatted = formatted.replace(", ", ",")

        # {key}:{value} guidelines but model emitted "TransactPlus,483.11"
        if (
            isinstance(value, str)
            and _detect_colon_kv_format(guidelines)
            and re.match(r"^[^,]+,[^,]+$", formatted)
            and ":" not in formatted
        ):
            formatted = formatted.replace(",", ":", 1)

        return formatted

    # Pre-concatenated KV strings in a single column when bracket-KV is expected
    if _detect_bracket_format(guidelines) and all(len(row) == 1 for row in result):
        kv_pattern = re.compile(r"^(.+?):\s*(.+)$")
        parsed_pairs: list[str] | None = []
        for row in result:
            m = kv_pattern.match(str(row[0]))
            if m:
                key, val_str = m.group(1).strip(), m.group(2).strip()
                try:
                    val = float(val_str)
                    formatted_val = _format_value(val, guidelines)
                except ValueError:
                    formatted_val = val_str
                parsed_pairs.append(f"{key}: {formatted_val}")
            else:
                parsed_pairs = None
                break
        if parsed_pairs is not None:
            return f"[{', '.join(parsed_pairs)}]"

    # Two-column rows + bracket guideline → [k: v, k: v]
    if len(result[0]) == 2 and _detect_bracket_format(guidelines):
        pairs = [
            f"{_format_value(row[0], guidelines)}: {_format_value(row[1], guidelines)}"
            for row in result
        ]
        return f"[{', '.join(pairs)}]"

    # Single multi-column row
    if len(result) == 1:
        values = [_format_value(v, guidelines) for v in result[0]]
        if len(result[0]) == 2 and _detect_colon_kv_format(guidelines):
            return ":".join(values)
        return separator.join(values)

    # Many rows × 1 column → list
    if all(len(row) == 1 for row in result):
        values = [_format_value(row[0], guidelines) for row in result]
        return separator.join(values)

    # Many rows × 2 cols, no brackets
    if len(result[0]) == 2:
        kv_sep = ":" if _detect_colon_kv_format(guidelines) else ": "
        pairs = [
            f"{_format_value(row[0], guidelines)}{kv_sep}{_format_value(row[1], guidelines)}"
            for row in result
        ]
        return ", ".join(pairs)

    # 3+ columns
    rows_formatted = []
    for row in result:
        row_values = [_format_value(v, guidelines) for v in row]
        rows_formatted.append(separator.join(row_values))
    return separator.join(rows_formatted)


def _format_value(value: Any, guidelines: str | None = None) -> str:
    """Format a single value according to guidelines."""
    if value is None:
        return "Not Applicable"

    if isinstance(value, bool):
        return "yes" if value else "no"

    if isinstance(value, str):
        try:
            value = float(value)
        except (ValueError, OverflowError):
            return value

    if isinstance(value, (int, float)):
        if guidelines:
            match = re.search(r"rounded to (\d+) decimal", guidelines.lower())
            if match:
                decimals = int(match.group(1))
                return f"{value:.{decimals}f}"

        if isinstance(value, float):
            return str(value)
        return str(value)

    return str(value)


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------


def score(
    execution_result: ExecutionResult,
    gold_answer: str,
    guidelines: str | None,
    predicted_sql: str | None,
    hit_limit: bool = False,
) -> ScoreResult:
    """Score a model's run on a single DABstep question.

    Args:
        execution_result: rows from the model's final SQL, or ExecutionError.
        gold_answer: the question's gold answer string.
        guidelines: the question's format guidelines (may be None).
        predicted_sql: the model's final SQL (None if it never produced one).
        hit_limit: True if the agent hit its tool-iteration limit.

    Returns:
        ScoreResult with the binary correctness, category, and predicted answer.
    """
    if hit_limit:
        return ScoreResult(
            is_correct=False,
            correctness=Correctness.HIT_LIMIT,
            score=0.0,
            match_source="none",
            reason="hit_limit",
            gold_answer=gold_answer,
            predicted_answer=None,
        )

    # Execution error path: fallback answer is "Not Applicable"
    if isinstance(execution_result, ExecutionError):
        fallback_answer = "Not Applicable"
        if _run_official_or_fallback(fallback_answer, gold_answer.strip()):
            return ScoreResult(
                is_correct=True,
                correctness=Correctness.CORRECT,
                score=1.0,
                match_source="dabstep_scorer",
                reason="no_sql_produced",
                gold_answer=gold_answer,
                predicted_answer=fallback_answer,
            )
        return ScoreResult(
            is_correct=False,
            correctness=Correctness.INCORRECT,
            score=0.0,
            match_source="none",
            reason="sql_execution_error" if predicted_sql else "no_sql_produced",
            gold_answer=gold_answer,
            predicted_answer=fallback_answer,
        )

    # Format SQL result, then normalize to gold's format
    predicted_answer = format_sql_result_as_answer(execution_result, guidelines)
    if predicted_answer and gold_answer:
        predicted_answer = normalize_to_gold_format(
            predicted_answer.strip(), gold_answer.strip()
        )

    if predicted_answer is None or predicted_answer.strip() == "":
        return ScoreResult(
            is_correct=False,
            correctness=Correctness.INCORRECT,
            score=0.0,
            match_source="none",
            reason="empty_prediction",
            gold_answer=gold_answer,
            predicted_answer=predicted_answer,
        )

    is_correct = _run_official_or_fallback(predicted_answer.strip(), gold_answer.strip())

    return ScoreResult(
        is_correct=is_correct,
        correctness=Correctness.CORRECT if is_correct else Correctness.INCORRECT,
        score=1.0 if is_correct else 0.0,
        match_source="dabstep_scorer" if is_correct else "none",
        reason=None,
        gold_answer=gold_answer,
        predicted_answer=predicted_answer,
    )


def _run_official_or_fallback(predicted: str, gold: str) -> bool:
    """Use the official DABstep scorer when installed, fallback otherwise."""
    try:
        from dabstep_benchmark.evaluation.scorer import question_scorer  # type: ignore

        return bool(question_scorer(predicted, gold))
    except ImportError:
        return _fallback_scorer(predicted, gold)
