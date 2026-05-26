"""
Data preparation for BIRD-Bench evaluation.

Downloads the BIRD Mini-Dev dataset from HuggingFace and extracts challenging questions.
"""

import json
from pathlib import Path

from datasets import load_dataset


def prepare_challenging_questions(
    output_path: str = "data/bird_challenging_100.json",
    limit: int | None = None
) -> list[dict]:
    """
    Download BIRD Mini-Dev dataset and extract challenging questions.

    Args:
        output_path: Path to save the extracted questions
        limit: Optional limit on number of questions (for testing)

    Returns:
        List of challenging question dictionaries
    """
    print("Loading BIRD Mini-Dev dataset from HuggingFace...")
    dataset = load_dataset("birdsql/bird_mini_dev")

    # Get the mini_dev_sqlite split
    mini_dev = dataset["mini_dev_sqlite"]

    print(f"Total questions in dataset: {len(mini_dev)}")

    # Filter for challenging questions
    challenging = [
        dict(row) for row in mini_dev
        if row.get("difficulty") == "challenging"
    ]

    print(f"Found {len(challenging)} challenging questions")

    # Apply limit if specified
    if limit:
        challenging = challenging[:limit]
        print(f"Limited to {len(challenging)} questions")

    # Create output directory
    output_file = Path(output_path)
    output_file.parent.mkdir(parents=True, exist_ok=True)

    # Save to JSON
    with open(output_file, "w") as f:
        json.dump(challenging, f, indent=2)

    print(f"Saved to {output_path}")

    # Print summary by database
    db_counts = {}
    for q in challenging:
        db_id = q.get("db_id", "unknown")
        db_counts[db_id] = db_counts.get(db_id, 0) + 1

    print("\nQuestions by database:")
    for db_id, count in sorted(db_counts.items()):
        print(f"  {db_id}: {count}")

    return challenging


def prepare_sample_questions(
    output_path: str = "data/bird_sample_10.json",
    count: int = 10
) -> list[dict]:
    """
    Prepare a small sample of questions for testing.

    Tries to get a diverse sample across different databases.
    """
    print(f"Preparing sample of {count} questions for testing...")

    dataset = load_dataset("birdsql/bird_mini_dev")
    mini_dev = dataset["mini_dev_sqlite"]

    challenging = [
        dict(row) for row in mini_dev
        if row.get("difficulty") == "challenging"
    ]

    # Group by database
    by_db = {}
    for q in challenging:
        db_id = q.get("db_id", "unknown")
        if db_id not in by_db:
            by_db[db_id] = []
        by_db[db_id].append(q)

    # Take round-robin from each database
    sample = []
    db_list = list(by_db.keys())
    idx = 0
    while len(sample) < count and idx < len(challenging):
        db_id = db_list[idx % len(db_list)]
        if by_db[db_id]:
            sample.append(by_db[db_id].pop(0))
        idx += 1

    # Save
    output_file = Path(output_path)
    output_file.parent.mkdir(parents=True, exist_ok=True)

    with open(output_file, "w") as f:
        json.dump(sample, f, indent=2)

    print(f"Saved {len(sample)} sample questions to {output_path}")

    # Print sample info
    print("\nSample questions:")
    for i, q in enumerate(sample):
        print(f"  {i+1}. [{q['db_id']}] Q{q['question_id']}: {q['question'][:60]}...")

    return sample


if __name__ == "__main__":
    import sys

    if len(sys.argv) > 1 and sys.argv[1] == "--sample":
        count = int(sys.argv[2]) if len(sys.argv) > 2 else 10
        prepare_sample_questions(count=count)
    else:
        prepare_challenging_questions()
