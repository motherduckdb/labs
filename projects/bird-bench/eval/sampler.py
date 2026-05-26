"""
Stratified train/test split sampler for BIRD-Bench evaluation.

Creates reproducible splits stratified by database to ensure
representative distribution across all 11 BIRD databases.
"""

import json
import random
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path

from eval.config import (
    EVAL_DATA_DIR,
    TRAIN_SEED,
    TRAIN_RATIO,
    TOTAL_QUESTIONS,
)


@dataclass
class DatasetSplit:
    """Container for train/test split with metadata."""
    train: list[dict]
    test: list[dict]
    seed: int
    stratification_key: str

    @property
    def train_size(self) -> int:
        return len(self.train)

    @property
    def test_size(self) -> int:
        return len(self.test)

    def get_distribution(self, split: str = "train") -> dict[str, int]:
        """Get distribution by stratification key."""
        data = self.train if split == "train" else self.test
        dist = defaultdict(int)
        for item in data:
            key = item.get(self.stratification_key, "unknown")
            dist[key] += 1
        return dict(sorted(dist.items()))


def load_questions_from_huggingface() -> list[dict]:
    """
    Load questions from HuggingFace birdsql/bird_mini_dev dataset.

    Returns:
        List of question dicts from the SQLite split (500 questions)
    """
    try:
        from datasets import load_dataset
    except ImportError:
        raise ImportError(
            "datasets package required. Install with: uv add datasets"
        )

    dataset = load_dataset("birdsql/bird_mini_dev", split="mini_dev_sqlite")

    # Convert to list of dicts
    questions = []
    for item in dataset:
        questions.append({
            "question_id": item["question_id"],
            "db_id": item["db_id"],
            "question": item["question"],
            "evidence": item["evidence"],
            "SQL": item["SQL"],
            "difficulty": item["difficulty"],
        })

    return questions


def load_questions_from_file(filepath: Path) -> list[dict]:
    """
    Load questions from a local JSON file.

    Args:
        filepath: Path to JSON file containing questions

    Returns:
        List of question dicts
    """
    with open(filepath) as f:
        return json.load(f)


def stratified_split_by_database(
    questions: list[dict],
    train_ratio: float = TRAIN_RATIO,
    seed: int = TRAIN_SEED,
) -> DatasetSplit:
    """
    Split questions into train/test sets, stratified by database.

    Ensures proportional representation of each database in both splits.

    Args:
        questions: List of question dicts with 'db_id' field
        train_ratio: Fraction of questions for train set (default 0.3 = 150/500)
        seed: Random seed for reproducibility

    Returns:
        DatasetSplit containing train and test lists
    """
    random.seed(seed)

    # Group questions by database
    by_database = defaultdict(list)
    for q in questions:
        db_id = q.get("db_id", "unknown")
        by_database[db_id].append(q)

    train = []
    test = []

    # Sort database IDs for deterministic ordering
    db_ids = sorted(by_database.keys())

    for db_id in db_ids:
        db_questions = by_database[db_id]
        # Shuffle within each database for randomness
        random.shuffle(db_questions)

        # Calculate train count for this database (proportional)
        train_count = round(len(db_questions) * train_ratio)
        # Ensure at least 1 in train if database has questions
        train_count = max(1, train_count) if db_questions else 0
        # Don't exceed available questions
        train_count = min(train_count, len(db_questions) - 1) if len(db_questions) > 1 else train_count

        train.extend(db_questions[:train_count])
        test.extend(db_questions[train_count:])

    # Shuffle final lists (preserves seed-based reproducibility)
    random.shuffle(train)
    random.shuffle(test)

    return DatasetSplit(
        train=train,
        test=test,
        seed=seed,
        stratification_key="db_id",
    )


def save_split(split: DatasetSplit, output_dir: Path | None = None) -> tuple[Path, Path]:
    """
    Save train/test split to JSON files.

    Args:
        split: DatasetSplit to save
        output_dir: Directory for output files (default: data/eval/)

    Returns:
        Tuple of (train_path, test_path)
    """
    output_dir = output_dir or EVAL_DATA_DIR
    output_dir.mkdir(parents=True, exist_ok=True)

    train_path = output_dir / "train.json"
    test_path = output_dir / "test.json"

    # Include metadata in saved files
    train_data = {
        "metadata": {
            "seed": split.seed,
            "stratification_key": split.stratification_key,
            "split": "train",
            "count": split.train_size,
            "distribution": split.get_distribution("train"),
        },
        "questions": split.train,
    }

    test_data = {
        "metadata": {
            "seed": split.seed,
            "stratification_key": split.stratification_key,
            "split": "test",
            "count": split.test_size,
            "distribution": split.get_distribution("test"),
        },
        "questions": split.test,
    }

    with open(train_path, "w") as f:
        json.dump(train_data, f, indent=2)

    with open(test_path, "w") as f:
        json.dump(test_data, f, indent=2)

    return train_path, test_path


def load_split(input_dir: Path | None = None) -> DatasetSplit:
    """
    Load a previously saved train/test split.

    Args:
        input_dir: Directory containing train.json and test.json

    Returns:
        DatasetSplit object
    """
    input_dir = input_dir or EVAL_DATA_DIR

    train_path = input_dir / "train.json"
    test_path = input_dir / "test.json"

    with open(train_path) as f:
        train_data = json.load(f)

    with open(test_path) as f:
        test_data = json.load(f)

    return DatasetSplit(
        train=train_data["questions"],
        test=test_data["questions"],
        seed=train_data["metadata"]["seed"],
        stratification_key=train_data["metadata"]["stratification_key"],
    )


def create_split(
    source: str = "huggingface",
    train_ratio: float = TRAIN_RATIO,
    seed: int = TRAIN_SEED,
    save: bool = True,
    output_dir: Path | None = None,
) -> DatasetSplit:
    """
    Create a stratified train/test split from BIRD Mini-Dev dataset.

    Args:
        source: "huggingface" or path to local JSON file
        train_ratio: Fraction for train set (default 0.3)
        seed: Random seed for reproducibility
        save: Whether to save splits to files
        output_dir: Directory for output files

    Returns:
        DatasetSplit object
    """
    # Load questions
    if source == "huggingface":
        questions = load_questions_from_huggingface()
    else:
        questions = load_questions_from_file(Path(source))

    # Validate count
    if len(questions) != TOTAL_QUESTIONS:
        print(f"Warning: Expected {TOTAL_QUESTIONS} questions, got {len(questions)}")

    # Create stratified split
    split = stratified_split_by_database(questions, train_ratio, seed)

    # Save if requested
    if save:
        train_path, test_path = save_split(split, output_dir)
        print(f"Saved train split ({split.train_size} questions) to {train_path}")
        print(f"Saved test split ({split.test_size} questions) to {test_path}")

    return split


def print_split_summary(split: DatasetSplit) -> None:
    """Print a summary of the train/test split."""
    print(f"\n{'='*60}")
    print(f"Dataset Split Summary (seed={split.seed})")
    print(f"{'='*60}")
    print(f"Train: {split.train_size} questions")
    print(f"Test:  {split.test_size} questions")
    print(f"Total: {split.train_size + split.test_size} questions")
    print(f"\nDistribution by {split.stratification_key}:")
    print(f"{'Database':<30} {'Train':>8} {'Test':>8} {'Total':>8}")
    print("-" * 60)

    train_dist = split.get_distribution("train")
    test_dist = split.get_distribution("test")
    all_keys = sorted(set(train_dist.keys()) | set(test_dist.keys()))

    for key in all_keys:
        train_count = train_dist.get(key, 0)
        test_count = test_dist.get(key, 0)
        total = train_count + test_count
        print(f"{key:<30} {train_count:>8} {test_count:>8} {total:>8}")

    print("-" * 60)
    print(f"{'TOTAL':<30} {split.train_size:>8} {split.test_size:>8} {split.train_size + split.test_size:>8}")


if __name__ == "__main__":
    # CLI usage: uv run python -m eval.sampler
    import sys

    source = "huggingface"
    if len(sys.argv) > 1:
        source = sys.argv[1]

    split = create_split(source=source, save=True)
    print_split_summary(split)
