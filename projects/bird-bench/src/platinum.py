"""
Platinum answers management for BIRD-Bench.

Platinum answers are verified correct answers that may differ from gold.
They provide fallback matching during evaluation.
"""

import json
from pathlib import Path

from eval.config import DATA_DIR


PLATINUM_FILE = DATA_DIR / "platinum_answers.json"
REVIEWED_FILE = DATA_DIR / "platinum_reviewed.json"


def load_reviewed() -> set[int]:
    """
    Load reviewed question IDs (both accepted and rejected).

    Returns:
        Set of question_ids that have been reviewed
    """
    if not REVIEWED_FILE.exists():
        return set()

    with open(REVIEWED_FILE) as f:
        reviewed = json.load(f)

    return set(reviewed)


def save_reviewed(reviewed: set[int]) -> None:
    """
    Save reviewed question IDs to file.

    Args:
        reviewed: Set of question_ids that have been reviewed
    """
    REVIEWED_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(REVIEWED_FILE, "w") as f:
        json.dump(sorted(reviewed), f, indent=2)


def load_platinum() -> dict[int, dict]:
    """
    Load platinum answers indexed by question_id.

    Returns:
        Dict mapping question_id -> platinum entry
    """
    if not PLATINUM_FILE.exists():
        return {}

    with open(PLATINUM_FILE) as f:
        entries = json.load(f)

    return {entry["question_id"]: entry for entry in entries}


def import_platinum(file_path: Path) -> tuple[int, int]:
    """
    Import accepted platinum entries and track rejected from export file.

    Merges new entries into platinum_answers.json.
    Tracks all reviewed question_ids in platinum_reviewed.json.
    Skips entries that already exist (by question_id).

    Args:
        file_path: Path to exported JSON file

    Returns:
        Tuple of (accepted_count, rejected_count)
    """
    # Load existing platinum entries
    if PLATINUM_FILE.exists():
        with open(PLATINUM_FILE) as f:
            existing = json.load(f)
    else:
        existing = []

    existing_ids = {e["question_id"] for e in existing}

    # Load existing reviewed set
    reviewed = load_reviewed()

    # Load export file
    with open(file_path) as f:
        export_data = json.load(f)

    # Handle both old format (list) and new format (dict with accepted/rejected)
    if isinstance(export_data, list):
        # Old format: just a list of accepted entries
        accepted_entries = export_data
        rejected_ids = []
    else:
        # New format: dict with accepted and rejected
        accepted_entries = export_data.get("accepted", [])
        rejected_ids = export_data.get("rejected", [])

    # Process accepted entries
    added = 0
    for entry in accepted_entries:
        qid = entry["question_id"]
        reviewed.add(qid)

        if qid in existing_ids:
            print(f"  Skipping Q{qid} (already in platinum)")
            continue

        existing.append({
            "question_id": qid,
            "db_id": entry["db_id"],
            "platinum_sql": entry["platinum_sql"],
            "platinum_result": entry["platinum_result"],
            "reason": entry.get("reason", "Added from truth-seeker review"),
        })
        existing_ids.add(qid)
        added += 1

    # Process rejected entries
    rejected_count = 0
    for qid in rejected_ids:
        if qid not in reviewed:
            reviewed.add(qid)
            rejected_count += 1

    # Sort by question_id and write platinum answers
    existing.sort(key=lambda x: x["question_id"])

    PLATINUM_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(PLATINUM_FILE, "w") as f:
        json.dump(existing, f, indent=2)

    # Save reviewed list
    save_reviewed(reviewed)

    return added, rejected_count
