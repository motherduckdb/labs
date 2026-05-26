"""
Audit gold SQL queries: Compare SQLite results vs DuckDB results.

This script:
1. Runs each gold SQL against the original SQLite database (ground truth)
2. Translates gold SQL to DuckDB using SQLGlot
3. Runs translated SQL against MotherDuck
4. Compares results and identifies mismatches
5. Outputs audit report for manual curation
"""

import json
import sqlite3
import os
import sys
from pathlib import Path
from dataclasses import dataclass, asdict
from typing import Any

from dotenv import load_dotenv

load_dotenv()

from src.sql_utils import sqlite_to_duckdb
from src.mcp_client import MotherDuckMCPClient
from src.constants import (
    SQLITE_DB_DIR,
    FULL_DATASET_FILE as QUESTIONS_FILE,
    SAMPLE_DATASET_FILE as SAMPLE_FILE,
    DATA_DIR,
)
from src.sql_executor import execute_sql

OUTPUT_FILE = DATA_DIR / "gold_sql_audit.json"


@dataclass
class AuditResult:
    question_id: int
    db_id: str
    question: str
    gold_sql: str
    gold_sql_duckdb: str | None
    sqlite_result: Any
    sqlite_error: str | None
    duckdb_result: Any
    duckdb_error: str | None
    results_match: bool
    mismatch_type: str | None  # "sqlite_error", "duckdb_error", "value_mismatch", "row_count_mismatch"
    notes: str | None


def get_sqlite_connection(db_id: str) -> sqlite3.Connection:
    """Get SQLite connection for a database."""
    db_path = SQLITE_DB_DIR / db_id / f"{db_id}.sqlite"
    if not db_path.exists():
        raise FileNotFoundError(f"SQLite database not found: {db_path}")
    return sqlite3.connect(str(db_path))


def execute_sqlite(sql: str, db_id: str) -> tuple[list | None, str | None]:
    """Execute SQL against SQLite and return (results, error)."""
    try:
        conn = get_sqlite_connection(db_id)
        cursor = conn.cursor()
        cursor.execute(sql)
        rows = cursor.fetchall()
        conn.close()
        # Convert to list of tuples
        return [tuple(row) for row in rows], None
    except Exception as e:
        return None, str(e)


from src.comparison import compare_results_simple as compare_results


def execute_duckdb(sql: str, db_id: str, mcp_client: MotherDuckMCPClient) -> tuple[list | None, str | None]:
    """Execute SQL against DuckDB/MotherDuck and return (results, error)."""
    return execute_sql(
        sql=sql,
        schema=db_id,
        mcp_client=mcp_client,
        translate_from_sqlite=True,
    )


def audit_question(question: dict, mcp_client: MotherDuckMCPClient) -> AuditResult:
    """Audit a single question's gold SQL."""
    qid = question["question_id"]
    db_id = question["db_id"]
    gold_sql = question["SQL"]

    # Execute against SQLite (ground truth)
    sqlite_result, sqlite_error = execute_sqlite(gold_sql, db_id)

    # Execute against DuckDB
    duckdb_result, duckdb_error = execute_duckdb(gold_sql, db_id, mcp_client)

    # Get translated SQL for reference
    try:
        gold_sql_duckdb = sqlite_to_duckdb(gold_sql, schema=db_id)
    except Exception as e:
        gold_sql_duckdb = None

    # Determine match status
    if sqlite_error:
        results_match = False
        mismatch_type = "sqlite_error"
    elif duckdb_error:
        results_match = False
        mismatch_type = "duckdb_error"
    else:
        results_match, mismatch_type = compare_results(sqlite_result, duckdb_result)

    # Generate notes
    notes = None
    if mismatch_type == "duckdb_error" and duckdb_error:
        if "GROUP BY" in duckdb_error:
            notes = "NEEDS FIX: Add column to GROUP BY or use ANY_VALUE()"
        elif "Cannot mix values" in duckdb_error:
            notes = "NEEDS FIX: Add CAST() for type mismatch"
        elif "No function matches" in duckdb_error:
            notes = "NEEDS FIX: Function/operator type mismatch"
    elif mismatch_type == "value_mismatch":
        notes = "NEEDS INVESTIGATION: Values differ between SQLite and DuckDB"
    elif mismatch_type == "row_count_mismatch":
        notes = f"NEEDS INVESTIGATION: Row count differs (SQLite: {len(sqlite_result) if sqlite_result else 0}, DuckDB: {len(duckdb_result) if duckdb_result else 0})"

    return AuditResult(
        question_id=qid,
        db_id=db_id,
        question=question["question"],
        gold_sql=gold_sql,
        gold_sql_duckdb=gold_sql_duckdb,
        sqlite_result=sqlite_result[:5] if sqlite_result else None,  # Truncate for readability
        sqlite_error=sqlite_error,
        duckdb_result=duckdb_result[:5] if duckdb_result else None,  # Truncate for readability
        duckdb_error=duckdb_error,
        results_match=results_match,
        mismatch_type=mismatch_type,
        notes=notes,
    )


def run_audit(questions: list[dict], output_path: Path) -> dict:
    """Run audit on all questions and save results."""
    # Initialize MCP client
    token = os.environ.get("MOTHERDUCK_TOKEN")
    if not token:
        raise ValueError("MOTHERDUCK_TOKEN not set")

    mcp_client = MotherDuckMCPClient(token)
    mcp_client.initialize()

    results = []
    stats = {
        "total": len(questions),
        "match": 0,
        "sqlite_error": 0,
        "duckdb_error": 0,
        "value_mismatch": 0,
        "row_count_mismatch": 0,
    }

    print(f"Auditing {len(questions)} questions...")
    print()

    for i, q in enumerate(questions):
        print(f"[{i+1}/{len(questions)}] Q{q['question_id']} ({q['db_id']})...", end=" ")

        result = audit_question(q, mcp_client)
        results.append(asdict(result))

        if result.results_match:
            stats["match"] += 1
            print("MATCH")
        else:
            stats[result.mismatch_type] += 1
            print(f"MISMATCH ({result.mismatch_type})")

    mcp_client.close()

    # Summary
    print()
    print("=" * 60)
    print("AUDIT SUMMARY")
    print("=" * 60)
    print(f"Total questions: {stats['total']}")
    print(f"Matching:        {stats['match']} ({stats['match']/stats['total']*100:.1f}%)")
    print(f"SQLite errors:   {stats['sqlite_error']}")
    print(f"DuckDB errors:   {stats['duckdb_error']}")
    print(f"Value mismatch:  {stats['value_mismatch']}")
    print(f"Row count diff:  {stats['row_count_mismatch']}")

    # Save results
    output = {
        "stats": stats,
        "results": results,
    }

    with open(output_path, "w") as f:
        json.dump(output, f, indent=2, default=str)

    print()
    print(f"Saved audit results to: {output_path}")

    return output


def main():
    """Main entry point."""
    # Determine which questions file to use
    if len(sys.argv) > 1 and sys.argv[1] == "--sample":
        questions_file = SAMPLE_FILE
    elif len(sys.argv) > 1 and sys.argv[1].isdigit():
        # Limit to N questions
        limit = int(sys.argv[1])
        questions_file = QUESTIONS_FILE if QUESTIONS_FILE.exists() else SAMPLE_FILE
    else:
        questions_file = QUESTIONS_FILE if QUESTIONS_FILE.exists() else SAMPLE_FILE

    if not questions_file.exists():
        print(f"Questions file not found: {questions_file}")
        print("Run data_prep.py first to download questions.")
        sys.exit(1)

    with open(questions_file) as f:
        questions = json.load(f)

    # Apply limit if specified
    if len(sys.argv) > 1 and sys.argv[1].isdigit():
        questions = questions[:int(sys.argv[1])]

    print(f"Using questions file: {questions_file}")
    print(f"Questions to audit: {len(questions)}")
    print()

    run_audit(questions, OUTPUT_FILE)


if __name__ == "__main__":
    main()
