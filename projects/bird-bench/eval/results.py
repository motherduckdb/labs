"""
Results aggregation and reporting for BIRD-Bench evaluation.

Aggregates results across models, configs, and phases to produce
comparison tables and summary statistics.
"""

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from eval.config import ConfigType, DATABASE_CONFIGS, RESULTS_DIR


@dataclass
class ComparisonRow:
    """A row in the comparison table."""
    model: str
    config: str
    config_type: ConfigType
    train_accuracy: float
    train_correct: int
    train_total: int
    test_accuracy: float
    test_correct: int
    test_total: int

    @property
    def train_pct(self) -> str:
        return f"{self.train_accuracy * 100:.2f}%"

    @property
    def test_pct(self) -> str:
        return f"{self.test_accuracy * 100:.2f}%"


@dataclass
class LiftAnalysis:
    """Analysis of accuracy lift from baseline."""
    model: str
    baseline_test_acc: float
    comments_test_acc: float
    full_test_acc: float
    comments_lift: float  # Absolute lift from baseline
    full_lift: float  # Absolute lift from baseline
    history_lift: float  # Lift from comments to full

    @property
    def comments_lift_pct(self) -> str:
        return f"{self.comments_lift * 100:+.2f}pp"

    @property
    def full_lift_pct(self) -> str:
        return f"{self.full_lift * 100:+.2f}pp"

    @property
    def history_lift_pct(self) -> str:
        return f"{self.history_lift * 100:+.2f}pp"


def load_eval_run(filepath: Path) -> dict:
    """Load evaluation run from JSON file."""
    with open(filepath) as f:
        return json.load(f)


def get_latest_eval_run() -> Path | None:
    """Get the most recent evaluation run file."""
    if not RESULTS_DIR.exists():
        return None

    files = list(RESULTS_DIR.glob("eval_run_*.json"))
    if not files:
        return None

    return max(files, key=lambda p: p.stat().st_mtime)


def build_comparison_table(eval_run: dict) -> list[ComparisonRow]:
    """
    Build comparison table from evaluation run.

    Args:
        eval_run: Loaded evaluation run dictionary

    Returns:
        List of ComparisonRow objects
    """
    # Index results by (model, config_type, phase)
    results_index = {}

    for result in eval_run.get("train_results", []):
        key = (result["model"], result["config_type"], "train")
        results_index[key] = result

    for result in eval_run.get("test_results", []):
        key = (result["model"], result["config_type"], "test")
        results_index[key] = result

    # Build comparison rows
    rows = []
    models = set()
    config_types = set()

    for key in results_index:
        models.add(key[0])
        config_types.add(key[1])

    for model in sorted(models):
        for config_type_str in sorted(config_types):
            config_type = ConfigType(config_type_str)
            config = DATABASE_CONFIGS[config_type]

            train_key = (model, config_type_str, "train")
            test_key = (model, config_type_str, "test")

            train_result = results_index.get(train_key, {})
            test_result = results_index.get(test_key, {})

            train_stats = train_result.get("stats", {})
            test_stats = test_result.get("stats", {})

            row = ComparisonRow(
                model=model,
                config=config.display_name,
                config_type=config_type,
                train_accuracy=train_stats.get("accuracy", 0),
                train_correct=train_stats.get("correct", 0) + train_stats.get("acceptable", 0),
                train_total=train_stats.get("total", 0),
                test_accuracy=test_stats.get("accuracy", 0),
                test_correct=test_stats.get("correct", 0) + test_stats.get("acceptable", 0),
                test_total=test_stats.get("total", 0),
            )
            rows.append(row)

    return rows


def calculate_lift(comparison_table: list[ComparisonRow]) -> list[LiftAnalysis]:
    """
    Calculate accuracy lift from baseline for each model.

    Args:
        comparison_table: Comparison table rows

    Returns:
        List of LiftAnalysis objects
    """
    # Group by model
    by_model = {}
    for row in comparison_table:
        if row.model not in by_model:
            by_model[row.model] = {}
        by_model[row.model][row.config_type] = row

    # Calculate lift for each model
    lifts = []
    for model, configs in sorted(by_model.items()):
        baseline = configs.get(ConfigType.BASELINE)
        comments = configs.get(ConfigType.COMMENTS)
        full = configs.get(ConfigType.FULL)

        if not all([baseline, comments, full]):
            continue

        lift = LiftAnalysis(
            model=model,
            baseline_test_acc=baseline.test_accuracy,
            comments_test_acc=comments.test_accuracy,
            full_test_acc=full.test_accuracy,
            comments_lift=comments.test_accuracy - baseline.test_accuracy,
            full_lift=full.test_accuracy - baseline.test_accuracy,
            history_lift=full.test_accuracy - comments.test_accuracy,
        )
        lifts.append(lift)

    return lifts


def print_comparison_table(rows: list[ComparisonRow]) -> None:
    """Print comparison table in formatted output."""
    print("\n" + "=" * 90)
    print("EVALUATION RESULTS COMPARISON")
    print("=" * 90)

    # Header
    print(f"{'Model':<20} {'Config':<25} {'Train Acc':>12} {'Test Acc':>12}")
    print("-" * 90)

    current_model = None
    for row in rows:
        # Add separator between models
        if current_model and current_model != row.model:
            print("-" * 90)
        current_model = row.model

        train_str = f"{row.train_pct} ({row.train_correct}/{row.train_total})"
        test_str = f"{row.test_pct} ({row.test_correct}/{row.test_total})"

        print(f"{row.model:<20} {row.config:<25} {train_str:>12} {test_str:>12}")

    print("=" * 90)


def print_lift_analysis(lifts: list[LiftAnalysis]) -> None:
    """Print lift analysis in formatted output."""
    print("\n" + "=" * 80)
    print("ACCURACY LIFT ANALYSIS (Test Set)")
    print("=" * 80)

    # Header
    print(f"{'Model':<20} {'Baseline':>12} {'Comments':>12} {'Full':>12} {'Cmts Lift':>12} {'Hist Lift':>12}")
    print("-" * 80)

    for lift in lifts:
        print(
            f"{lift.model:<20} "
            f"{lift.baseline_test_acc*100:>11.2f}% "
            f"{lift.comments_test_acc*100:>11.2f}% "
            f"{lift.full_test_acc*100:>11.2f}% "
            f"{lift.comments_lift_pct:>12} "
            f"{lift.history_lift_pct:>12}"
        )

    print("=" * 80)
    print("\nLegend:")
    print("  Cmts Lift = Comments vs Baseline (impact of metadata comments)")
    print("  Hist Lift = Full vs Comments (impact of query history)")


def export_to_csv(rows: list[ComparisonRow], output_path: Path) -> None:
    """Export comparison table to CSV."""
    import csv

    with open(output_path, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow([
            "Model", "Config", "ConfigType",
            "TrainAccuracy", "TrainCorrect", "TrainTotal",
            "TestAccuracy", "TestCorrect", "TestTotal",
        ])

        for row in rows:
            writer.writerow([
                row.model, row.config, row.config_type.value,
                row.train_accuracy, row.train_correct, row.train_total,
                row.test_accuracy, row.test_correct, row.test_total,
            ])

    print(f"Exported to: {output_path}")


def export_lift_to_csv(lifts: list[LiftAnalysis], output_path: Path) -> None:
    """Export lift analysis to CSV."""
    import csv

    with open(output_path, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow([
            "Model",
            "BaselineTestAcc", "CommentsTestAcc", "FullTestAcc",
            "CommentsLift", "FullLift", "HistoryLift",
        ])

        for lift in lifts:
            writer.writerow([
                lift.model,
                lift.baseline_test_acc, lift.comments_test_acc, lift.full_test_acc,
                lift.comments_lift, lift.full_lift, lift.history_lift,
            ])

    print(f"Exported lift analysis to: {output_path}")


def generate_report(eval_run_path: Path | None = None) -> dict:
    """
    Generate a complete report from an evaluation run.

    Args:
        eval_run_path: Path to eval run JSON (uses latest if not specified)

    Returns:
        Report dictionary with all aggregations
    """
    # Load eval run
    if eval_run_path is None:
        eval_run_path = get_latest_eval_run()
        if eval_run_path is None:
            raise FileNotFoundError("No evaluation runs found")

    print(f"Loading: {eval_run_path}")
    eval_run = load_eval_run(eval_run_path)

    # Build comparison table
    comparison_table = build_comparison_table(eval_run)

    # Calculate lift
    lifts = calculate_lift(comparison_table)

    # Print reports
    print_comparison_table(comparison_table)
    print_lift_analysis(lifts)

    # Export to CSV
    csv_dir = eval_run_path.parent
    export_to_csv(comparison_table, csv_dir / "comparison_table.csv")
    export_lift_to_csv(lifts, csv_dir / "lift_analysis.csv")

    return {
        "comparison_table": [
            {
                "model": r.model,
                "config": r.config,
                "train_accuracy": r.train_accuracy,
                "test_accuracy": r.test_accuracy,
            }
            for r in comparison_table
        ],
        "lift_analysis": [
            {
                "model": l.model,
                "comments_lift": l.comments_lift,
                "history_lift": l.history_lift,
                "full_lift": l.full_lift,
            }
            for l in lifts
        ],
    }


if __name__ == "__main__":
    import sys
    from dotenv import load_dotenv

    load_dotenv()

    # Parse arguments
    eval_run_path = None
    if len(sys.argv) > 1 and not sys.argv[1].startswith("--"):
        eval_run_path = Path(sys.argv[1])

    generate_report(eval_run_path)
