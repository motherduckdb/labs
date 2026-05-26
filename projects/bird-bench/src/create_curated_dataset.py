"""
Create curated dataset with ground truth results from SQLite.

This script:
1. Runs each gold SQL against SQLite to get ground truth results
2. Marks which queries have DuckDB compatibility issues
3. Creates a new dataset file with gold_result field
"""

import json
import sqlite3
from pathlib import Path
from typing import Any

# Paths
AUDIT_FILE = Path(__file__).parent.parent / "data" / "gold_sql_audit.json"
QUESTIONS_FILE = Path(__file__).parent.parent / "data" / "bird_challenging_100.json"
OUTPUT_FILE = Path(__file__).parent.parent / "data" / "bird_challenging_100_curated.json"
SQLITE_DB_DIR = Path(__file__).parent.parent / "mini_dev_data" / "MINIDEV" / "dev_databases"


def get_sqlite_result(sql: str, db_id: str) -> tuple[Any, str | None]:
    """Execute SQL against SQLite and return (result, error)."""
    try:
        db_path = SQLITE_DB_DIR / db_id / f"{db_id}.sqlite"
        conn = sqlite3.connect(str(db_path))
        cursor = conn.cursor()
        cursor.execute(sql)
        rows = cursor.fetchall()
        conn.close()
        return [list(row) for row in rows], None
    except Exception as e:
        return None, str(e)


def main():
    """Create curated dataset."""

    # Load audit results
    with open(AUDIT_FILE) as f:
        audit = json.load(f)

    # Load questions
    with open(QUESTIONS_FILE) as f:
        questions = json.load(f)

    # Create lookup by question_id
    audit_lookup = {r['question_id']: r for r in audit['results']}

    # Process each question
    stats = {
        'total': len(questions),
        'with_gold_result': 0,
        'duckdb_compatible': 0,
        'needs_fix': 0,
        'data_mismatch': 0,
    }

    print(f"Processing {len(questions)} questions...", flush=True)

    for i, q in enumerate(questions):
        qid = q['question_id']
        print(f"[{i+1}/{len(questions)}] Q{qid}...", end=" ", flush=True)

        # Get SQLite result (ground truth)
        result, error = get_sqlite_result(q['SQL'], q['db_id'])

        if error:
            print(f"SQLite error: {error[:50]}", flush=True)
            q['gold_result'] = None
            q['gold_result_error'] = error
        else:
            q['gold_result'] = result
            stats['with_gold_result'] += 1
            print(f"OK ({len(result)} rows)", flush=True)

        # Check audit status
        audit_result = audit_lookup.get(qid, {})
        if audit_result.get('results_match', False):
            q['duckdb_status'] = 'compatible'
            stats['duckdb_compatible'] += 1
        elif audit_result.get('mismatch_type') == 'duckdb_error':
            q['duckdb_status'] = 'needs_fix'
            q['duckdb_error'] = audit_result.get('duckdb_error', '')[:200]
            stats['needs_fix'] += 1
        else:
            q['duckdb_status'] = 'data_mismatch'
            stats['data_mismatch'] += 1

    # Save curated dataset
    with open(OUTPUT_FILE, 'w') as f:
        json.dump(questions, f, indent=2, default=str)

    print()
    print("=" * 60)
    print("SUMMARY")
    print("=" * 60)
    print(f"Total questions:      {stats['total']}")
    print(f"With gold result:     {stats['with_gold_result']}")
    print(f"DuckDB compatible:    {stats['duckdb_compatible']}")
    print(f"Needs SQL fix:        {stats['needs_fix']}")
    print(f"Data mismatch:        {stats['data_mismatch']}")
    print()
    print(f"Saved to: {OUTPUT_FILE}")


if __name__ == "__main__":
    main()
