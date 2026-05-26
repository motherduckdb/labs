"""
Scoring logic for BIRD-Bench evaluation.

Applies specific scoring rules for partial correctness cases:
- Extra columns + correct data = 1 point (acceptable)
- Missing columns = 0 points (incorrect)
- Missing rows = 0 points (incorrect)
- Subset match = 0 points (incorrect)
"""

from dataclasses import dataclass
from enum import Enum

from src.comparison import CorrectnessLevel


# Partial match reason prefixes (from comparison.py)
PARTIAL_EXTRA_COLUMNS = "extra_columns"
PARTIAL_MISSING_COLUMNS = "missing_columns"
PARTIAL_EXTRA_ROWS = "extra_rows"
PARTIAL_MISSING_ROWS = "missing_rows"

# DISTINCT-related partials where unique values match (should get credit)
PARTIAL_EXTRA_DUPLICATES = "extra_duplicates"      # Predicted has dups, unique values match gold
PARTIAL_IMPLICIT_DISTINCT = "implicit_distinct"    # Predicted used DISTINCT, gold didn't
PARTIAL_AGGREGATED_EQUIVALENT = "aggregated_equivalent"  # Same values, different aggregation
PARTIAL_VALUES_CLOSE = "values_close_not_exact"


class ScoreCategory(Enum):
    """Scoring category for reporting."""
    CORRECT_GOLD = "correct_gold"            # Matched gold answer (1 point)
    CORRECT_PLATINUM = "correct_platinum"    # Matched platinum answer (1 point)
    CORRECT_JUDGE = "correct_judge"          # LLM judge approved (1 point)
    PARTIAL_ACCEPTED = "partial_accepted"    # Partial match with credit (1 point)
    PARTIAL_UNACCEPTED = "partial_unaccepted"  # Partial match without credit (0 points)
    INCORRECT = "incorrect"                  # No match (0 points)
    ERROR = "error"                          # Execution error (0 points)
    HIT_LIMIT = "hit_limit"                  # Hit tool call limit (0 points)


@dataclass
class ScoredResult:
    """Result with score and category."""
    correctness_level: CorrectnessLevel
    partial_reason: str | None
    match_source: str | None
    score: float
    category: ScoreCategory


def score_result(
    correctness_level: CorrectnessLevel,
    partial_reason: str | None = None,
    match_source: str | None = None,
) -> ScoredResult:
    """
    Score a result according to evaluation rules.

    Scoring Rules:
    - CORRECT (gold) → 1 point (CORRECT_GOLD)
    - CORRECT (platinum) → 1 point (CORRECT_PLATINUM)
    - JUDGE_CORRECT → 1 point (CORRECT_JUDGE)
    - PARTIAL with accepted reasons → 1 point (PARTIAL_ACCEPTED):
      - extra_columns: returned more columns than needed
      - extra_duplicates: has duplicates but unique values match
      - implicit_distinct: used DISTINCT when gold didn't
      - aggregated_equivalent: same values, different aggregation
    - PARTIAL with other reasons → 0 points (PARTIAL_UNACCEPTED)
    - INCORRECT → 0 points
    - ERROR → 0 points
    - HIT_LIMIT → 0 points

    Args:
        correctness_level: Result from compare_results()
        partial_reason: Reason string if partial match
        match_source: "gold", "platinum", or "none"

    Returns:
        ScoredResult with score and category
    """
    # Exact match - check source
    if correctness_level == CorrectnessLevel.CORRECT:
        if match_source == "platinum":
            return ScoredResult(
                correctness_level=correctness_level,
                partial_reason=None,
                match_source=match_source,
                score=1.0,
                category=ScoreCategory.CORRECT_PLATINUM,
            )
        else:
            return ScoredResult(
                correctness_level=correctness_level,
                partial_reason=None,
                match_source=match_source,
                score=1.0,
                category=ScoreCategory.CORRECT_GOLD,
            )

    # LLM judge approved
    if correctness_level == CorrectnessLevel.JUDGE_CORRECT:
        return ScoredResult(
            correctness_level=correctness_level,
            partial_reason=partial_reason,
            match_source="judge",
            score=1.0,
            category=ScoreCategory.CORRECT_JUDGE,
        )

    # Error
    if correctness_level == CorrectnessLevel.ERROR:
        return ScoredResult(
            correctness_level=correctness_level,
            partial_reason=partial_reason,
            match_source=match_source,
            score=0.0,
            category=ScoreCategory.ERROR,
        )

    # Hit iteration limit
    if correctness_level == CorrectnessLevel.HIT_LIMIT:
        return ScoredResult(
            correctness_level=correctness_level,
            partial_reason=partial_reason,
            match_source=match_source,
            score=0.0,
            category=ScoreCategory.HIT_LIMIT,
        )

    # Partial match - check reason
    if correctness_level == CorrectnessLevel.PARTIAL:
        # Accepted partial reasons (get 1 point):
        # - extra_columns: returned more columns than needed, but data is correct
        # - extra_duplicates: predicted has duplicates, but unique values match gold
        # - implicit_distinct: predicted used DISTINCT, gold didn't (unique values match)
        # - aggregated_equivalent: same values, different aggregation
        accepted_prefixes = (
            PARTIAL_EXTRA_COLUMNS,
            PARTIAL_EXTRA_DUPLICATES,
            PARTIAL_IMPLICIT_DISTINCT,
            PARTIAL_AGGREGATED_EQUIVALENT,
        )
        if partial_reason and any(partial_reason.startswith(p) for p in accepted_prefixes):
            return ScoredResult(
                correctness_level=correctness_level,
                partial_reason=partial_reason,
                match_source=match_source,
                score=1.0,
                category=ScoreCategory.PARTIAL_ACCEPTED,
            )

        # All other partial cases are unaccepted (0 points)
        return ScoredResult(
            correctness_level=correctness_level,
            partial_reason=partial_reason,
            match_source=match_source,
            score=0.0,
            category=ScoreCategory.PARTIAL_UNACCEPTED,
        )

    # Incorrect
    return ScoredResult(
        correctness_level=correctness_level,
        partial_reason=partial_reason,
        match_source=match_source,
        score=0.0,
        category=ScoreCategory.INCORRECT,
    )


def calculate_accuracy(results: list[ScoredResult]) -> float:
    """
    Calculate accuracy as sum of scores / total questions.

    Args:
        results: List of ScoredResult objects

    Returns:
        Accuracy as float between 0 and 1
    """
    if not results:
        return 0.0
    return sum(r.score for r in results) / len(results)


@dataclass
class AccuracyStats:
    """Detailed accuracy statistics."""
    total: int
    correct_gold: int
    correct_platinum: int
    correct_judge: int
    partial_accepted: int
    partial_unaccepted: int
    incorrect: int
    error: int
    hit_limit: int
    accuracy: float
    accuracy_pct: str

    @property
    def credited(self) -> int:
        """Questions receiving credit (score > 0)."""
        return self.correct_gold + self.correct_platinum + self.correct_judge + self.partial_accepted

    @property
    def correct(self) -> int:
        """Total correct (gold + platinum + judge)."""
        return self.correct_gold + self.correct_platinum + self.correct_judge


def calculate_accuracy_stats(results: list[ScoredResult]) -> AccuracyStats:
    """
    Calculate detailed accuracy statistics.

    Args:
        results: List of ScoredResult objects

    Returns:
        AccuracyStats with breakdown by category
    """
    if not results:
        return AccuracyStats(
            total=0, correct_gold=0, correct_platinum=0, correct_judge=0,
            partial_accepted=0, partial_unaccepted=0,
            incorrect=0, error=0, hit_limit=0,
            accuracy=0.0, accuracy_pct="0.00%"
        )

    correct_gold = sum(1 for r in results if r.category == ScoreCategory.CORRECT_GOLD)
    correct_platinum = sum(1 for r in results if r.category == ScoreCategory.CORRECT_PLATINUM)
    correct_judge = sum(1 for r in results if r.category == ScoreCategory.CORRECT_JUDGE)
    partial_accepted = sum(1 for r in results if r.category == ScoreCategory.PARTIAL_ACCEPTED)
    partial_unaccepted = sum(1 for r in results if r.category == ScoreCategory.PARTIAL_UNACCEPTED)
    incorrect = sum(1 for r in results if r.category == ScoreCategory.INCORRECT)
    error = sum(1 for r in results if r.category == ScoreCategory.ERROR)
    hit_limit = sum(1 for r in results if r.category == ScoreCategory.HIT_LIMIT)
    total = len(results)

    credited = correct_gold + correct_platinum + correct_judge + partial_accepted
    accuracy = credited / total if total > 0 else 0.0
    accuracy_pct = f"{accuracy * 100:.2f}%"

    return AccuracyStats(
        total=total,
        correct_gold=correct_gold,
        correct_platinum=correct_platinum,
        correct_judge=correct_judge,
        partial_accepted=partial_accepted,
        partial_unaccepted=partial_unaccepted,
        incorrect=incorrect,
        error=error,
        hit_limit=hit_limit,
        accuracy=accuracy,
        accuracy_pct=accuracy_pct,
    )


def print_accuracy_report(stats: AccuracyStats, label: str = "") -> None:
    """Print a formatted accuracy report."""
    title = f"Accuracy Report{f': {label}' if label else ''}"
    print(f"\n{title}")
    print("=" * 50)
    print(f"Total questions:       {stats.total:>6}")
    print(f"Correct (gold):        {stats.correct_gold:>6}")
    print(f"Correct (platinum):    {stats.correct_platinum:>6}")
    print(f"Correct (judge):       {stats.correct_judge:>6}")
    print(f"Partial (accepted):    {stats.partial_accepted:>6}")
    print(f"Partial (unaccepted):  {stats.partial_unaccepted:>6}")
    print(f"Incorrect:             {stats.incorrect:>6}")
    print(f"Error:                 {stats.error:>6}")
    print(f"Hit limit:             {stats.hit_limit:>6}")
    print("-" * 50)
    print(f"Credited:              {stats.credited:>6}")
    print(f"Accuracy:              {stats.accuracy_pct:>6}")


if __name__ == "__main__":
    # Test scoring logic
    from src.comparison import CorrectnessLevel

    test_cases = [
        (CorrectnessLevel.CORRECT, None, "gold", 1.0, ScoreCategory.CORRECT_GOLD),
        (CorrectnessLevel.CORRECT, None, "platinum", 1.0, ScoreCategory.CORRECT_PLATINUM),
        (CorrectnessLevel.JUDGE_CORRECT, None, None, 1.0, ScoreCategory.CORRECT_JUDGE),
        # Accepted partial reasons (1 point)
        (CorrectnessLevel.PARTIAL, "extra_columns:2", None, 1.0, ScoreCategory.PARTIAL_ACCEPTED),
        (CorrectnessLevel.PARTIAL, "extra_duplicates:4_duplicates_in_predicted", None, 1.0, ScoreCategory.PARTIAL_ACCEPTED),
        (CorrectnessLevel.PARTIAL, "implicit_distinct:3_duplicates_removed", None, 1.0, ScoreCategory.PARTIAL_ACCEPTED),
        (CorrectnessLevel.PARTIAL, "aggregated_equivalent:sum", None, 1.0, ScoreCategory.PARTIAL_ACCEPTED),
        # Unaccepted partial reasons (0 points)
        (CorrectnessLevel.PARTIAL, "missing_columns:1", None, 0.0, ScoreCategory.PARTIAL_UNACCEPTED),
        (CorrectnessLevel.PARTIAL, "extra_rows:5", None, 0.0, ScoreCategory.PARTIAL_UNACCEPTED),
        (CorrectnessLevel.PARTIAL, "values_close_not_exact", None, 0.0, ScoreCategory.PARTIAL_UNACCEPTED),
        (CorrectnessLevel.INCORRECT, None, None, 0.0, ScoreCategory.INCORRECT),
        (CorrectnessLevel.INCORRECT, "missing_rows:3", None, 0.0, ScoreCategory.INCORRECT),
        (CorrectnessLevel.ERROR, "execution_error", None, 0.0, ScoreCategory.ERROR),
        (CorrectnessLevel.HIT_LIMIT, None, None, 0.0, ScoreCategory.HIT_LIMIT),
    ]

    print("Testing scoring logic:")
    print("-" * 80)

    all_passed = True
    for level, reason, source, expected_score, expected_cat in test_cases:
        result = score_result(level, reason, source)
        passed = result.score == expected_score and result.category == expected_cat
        status = "✓" if passed else "✗"
        print(f"{status} {level.value:12} {str(reason):25} {str(source):10} → {result.score} ({result.category.value})")
        if not passed:
            all_passed = False
            print(f"   Expected: {expected_score} ({expected_cat.value})")

    print("-" * 80)
    print(f"All tests passed: {all_passed}")
