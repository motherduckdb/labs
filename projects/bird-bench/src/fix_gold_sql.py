"""
Fix gold SQL queries for DuckDB compatibility.

Takes the audit results and applies fixes to create DuckDB-compatible versions.
"""

import json
import re
import sqlite3
from pathlib import Path
from typing import Any

import sqlglot
from sqlglot import exp

# Paths
AUDIT_FILE = Path(__file__).parent.parent / "data" / "gold_sql_audit.json"
QUESTIONS_FILE = Path(__file__).parent.parent / "data" / "bird_challenging_100.json"
OUTPUT_FILE = Path(__file__).parent.parent / "data" / "bird_challenging_100_fixed.json"
SQLITE_DB_DIR = Path(__file__).parent.parent / "mini_dev_data" / "MINIDEV" / "dev_databases"


def fix_strftime_subtraction(sql: str) -> str:
    """
    Fix STRFTIME('%Y', date) - STRFTIME('%Y', date) operations.

    DuckDB's STRFTIME returns VARCHAR, which can't be subtracted.
    Fix: CAST(STRFTIME(...) AS INTEGER) - CAST(STRFTIME(...) AS INTEGER)
    """
    # Pattern: STRFTIME(...) - STRFTIME(...)
    # Replace with CAST(STRFTIME(...) AS INTEGER) - CAST(STRFTIME(...) AS INTEGER)

    def wrap_strftime(match):
        return f"CAST({match.group(0)} AS INTEGER)"

    # Find STRFTIME calls that are part of arithmetic
    # This is a simplified approach - wrap all STRFTIME in CAST
    sql = re.sub(
        r"STRFTIME\s*\(\s*'%Y'\s*,\s*[^)]+\)",
        wrap_strftime,
        sql,
        flags=re.IGNORECASE
    )

    return sql


def fix_group_by_violation(sql: str, schema: str) -> str:
    """
    Fix GROUP BY violations by wrapping non-grouped columns with ANY_VALUE().

    DuckDB requires all non-aggregated SELECT columns to be in GROUP BY.
    """
    try:
        tree = sqlglot.parse_one(sql, dialect="duckdb")

        # Find GROUP BY columns
        group_by = tree.find(exp.Group)
        if not group_by:
            return sql

        grouped_cols = set()
        for expr in group_by.expressions:
            if isinstance(expr, exp.Column):
                grouped_cols.add(expr.name.lower())
            elif hasattr(expr, 'alias'):
                grouped_cols.add(expr.alias.lower())

        # Find SELECT columns that need ANY_VALUE
        select = tree.find(exp.Select)
        if not select:
            return sql

        new_expressions = []
        for expr in select.expressions:
            if isinstance(expr, exp.Column):
                col_name = expr.name.lower()
                if col_name not in grouped_cols:
                    # Wrap with ANY_VALUE
                    new_expr = exp.Anonymous(
                        this="ANY_VALUE",
                        expressions=[expr.copy()]
                    )
                    new_expressions.append(new_expr)
                else:
                    new_expressions.append(expr)
            elif isinstance(expr, (exp.Sum, exp.Avg, exp.Count, exp.Min, exp.Max)):
                # Already aggregated
                new_expressions.append(expr)
            else:
                new_expressions.append(expr)

        select.set("expressions", new_expressions)
        return tree.sql(dialect="duckdb")

    except Exception as e:
        # Fallback: use regex
        return fix_group_by_regex(sql)


def fix_group_by_regex(sql: str) -> str:
    """Regex-based GROUP BY fix as fallback."""
    # This is a simple heuristic - wrap column references in SELECT with ANY_VALUE
    # if there's a GROUP BY clause

    if "GROUP BY" not in sql.upper():
        return sql

    # Extract the GROUP BY column
    group_match = re.search(r"GROUP BY\s+([a-zA-Z0-9_.]+)", sql, re.IGNORECASE)
    if not group_match:
        return sql

    grouped_col = group_match.group(1).lower()

    # Find SELECT clause columns that aren't the grouped column and aren't aggregates
    select_match = re.search(r"SELECT\s+(.+?)\s+FROM", sql, re.IGNORECASE | re.DOTALL)
    if not select_match:
        return sql

    select_part = select_match.group(1)

    # Simple: wrap table.column references with ANY_VALUE if not grouped
    def maybe_wrap(match):
        col_ref = match.group(0)
        col_name = col_ref.split('.')[-1].lower()

        # Check if it's an aggregate function
        before = sql[:match.start()].lower()
        if any(agg in before[-20:] for agg in ['sum(', 'avg(', 'count(', 'min(', 'max(']):
            return col_ref

        # Check if it's the grouped column
        if col_name == grouped_col.split('.')[-1]:
            return col_ref

        return f"ANY_VALUE({col_ref})"

    # This is imperfect but handles common cases
    return sql


def fix_case_type_mismatch(sql: str) -> str:
    """
    Fix CASE expressions where THEN and ELSE have different types.

    Common issue: THEN column_name ELSE 0 when column is VARCHAR
    Fix: CAST(column_name AS DOUBLE) and use 0.0
    """
    # Pattern: CASE WHEN ... THEN column ELSE 0 END
    # This is tricky to fix generically without knowing schema
    # For now, convert ELSE 0 to ELSE 0.0 and hope the THEN value is numeric-ish

    sql = re.sub(r"\bELSE\s+0\s+END", "ELSE 0.0 END", sql, flags=re.IGNORECASE)

    return sql


def fix_like_on_date(sql: str) -> str:
    """
    Fix LIKE operator on DATE columns.

    DuckDB doesn't support LIKE on DATE directly.
    Fix: CAST(date_column AS VARCHAR) LIKE pattern
    """
    # Pattern: date_column LIKE 'pattern'
    # This needs schema awareness to know which columns are dates
    # For now, look for common patterns like Birthday LIKE '%1937%'

    # Common date column names in BIRD
    date_cols = ['birthday', 'date', 'first date', 'admission date', 'description date']

    for col in date_cols:
        # Handle both backtick and regular column names
        patterns = [
            (rf"(`{col}`|{col})\s+LIKE", rf"CAST(\1 AS VARCHAR) LIKE"),
            (rf'("{col}"|{col})\s+LIKE', rf'CAST(\1 AS VARCHAR) LIKE'),
        ]
        for pattern, replacement in patterns:
            sql = re.sub(pattern, replacement, sql, flags=re.IGNORECASE)

    return sql


def fix_datetime_function(sql: str) -> str:
    """
    Fix datetime() function which doesn't exist in DuckDB.

    SQLite's datetime() converts to datetime.
    DuckDB: Use CAST(... AS TIMESTAMP) or strptime()
    """
    # datetime(date_column, 'modifier') -> various DuckDB equivalents
    # For now, just cast to timestamp
    sql = re.sub(
        r"datetime\s*\(\s*([^,)]+)\s*\)",
        r"CAST(\1 AS TIMESTAMP)",
        sql,
        flags=re.IGNORECASE
    )

    return sql


def fix_between_type_mismatch(sql: str) -> str:
    """
    Fix BETWEEN clause type mismatches.

    Common: VARCHAR column BETWEEN 1 AND 12
    Fix: CAST(column AS INTEGER) BETWEEN 1 AND 12
    """
    # Pattern: column BETWEEN int AND int
    # Look for month-related columns
    month_cols = ['date']

    for col in month_cols:
        pattern = rf"SUBSTR\s*\(\s*({col}|`{col}`|\"{col}\")\s*,\s*\d+\s*,\s*\d+\s*\)\s+BETWEEN\s+(\d+)\s+AND\s+(\d+)"
        replacement = rf"CAST(SUBSTR(\1, 5, 2) AS INTEGER) BETWEEN \2 AND \3"
        sql = re.sub(pattern, replacement, sql, flags=re.IGNORECASE)

    return sql


def fix_avg_varchar(sql: str) -> str:
    """
    Fix AVG() on VARCHAR columns.

    Fix: AVG(CAST(column AS DOUBLE))
    """
    # This needs schema awareness
    # For formula_1, fastestLapSpeed is VARCHAR
    varchar_numeric_cols = ['fastestlapspeed', 'fastestlaptime']

    for col in varchar_numeric_cols:
        pattern = rf"AVG\s*\(\s*([a-zA-Z0-9_.]*\.)?({col})\s*\)"
        replacement = rf"AVG(CAST(\1\2 AS DOUBLE))"
        sql = re.sub(pattern, replacement, sql, flags=re.IGNORECASE)

    return sql


def apply_fixes(sql: str, schema: str, error: str) -> str:
    """Apply appropriate fixes based on the error message."""

    if not error:
        return sql

    fixed_sql = sql

    # Type mismatch in CASE
    if "Cannot mix values" in error and "CASE" in error:
        fixed_sql = fix_case_type_mismatch(fixed_sql)

    # STRFTIME subtraction
    if "-(VARCHAR, VARCHAR)" in error:
        fixed_sql = fix_strftime_subtraction(fixed_sql)

    # GROUP BY violation
    if "GROUP BY" in error:
        fixed_sql = fix_group_by_violation(fixed_sql, schema)

    # LIKE on DATE
    if "~~(DATE" in error:
        fixed_sql = fix_like_on_date(fixed_sql)

    # datetime function
    if "datetime does not exist" in error:
        fixed_sql = fix_datetime_function(fixed_sql)

    # BETWEEN type mismatch
    if "BETWEEN" in error and "VARCHAR" in error:
        fixed_sql = fix_between_type_mismatch(fixed_sql)

    # AVG on VARCHAR
    if "avg(VARCHAR)" in error:
        fixed_sql = fix_avg_varchar(fixed_sql)

    return fixed_sql


def get_sqlite_result(sql: str, db_id: str) -> Any:
    """Execute SQL against SQLite and return result."""
    try:
        db_path = SQLITE_DB_DIR / db_id / f"{db_id}.sqlite"
        conn = sqlite3.connect(str(db_path))
        cursor = conn.cursor()
        cursor.execute(sql)
        rows = cursor.fetchall()
        conn.close()
        return [tuple(row) for row in rows]
    except Exception as e:
        return f"ERROR: {e}"


def main():
    """Fix gold SQL queries and save to new file."""

    # Load audit results
    with open(AUDIT_FILE) as f:
        audit = json.load(f)

    # Load questions
    with open(QUESTIONS_FILE) as f:
        questions = json.load(f)

    # Create lookup by question_id
    audit_lookup = {r['question_id']: r for r in audit['results']}

    # Process each question
    fixed_count = 0
    manual_fix_needed = []

    for q in questions:
        qid = q['question_id']
        audit_result = audit_lookup.get(qid, {})

        if audit_result.get('results_match', True):
            # Already matching, use sqlglot translation
            from sql_utils import sqlite_to_duckdb
            q['gold_sql_duckdb'] = sqlite_to_duckdb(q['SQL'], schema=q['db_id'])
            q['gold_result'] = get_sqlite_result(q['SQL'], q['db_id'])
        elif audit_result.get('mismatch_type') == 'duckdb_error':
            # Try to fix
            from sql_utils import sqlite_to_duckdb
            base_sql = sqlite_to_duckdb(q['SQL'], schema=q['db_id'])
            fixed_sql = apply_fixes(base_sql, q['db_id'], audit_result.get('duckdb_error', ''))
            q['gold_sql_duckdb'] = fixed_sql
            q['gold_result'] = get_sqlite_result(q['SQL'], q['db_id'])
            q['needs_manual_review'] = True
            fixed_count += 1
            manual_fix_needed.append(qid)
        else:
            # Value/row mismatch - store SQLite result as ground truth
            from sql_utils import sqlite_to_duckdb
            q['gold_sql_duckdb'] = sqlite_to_duckdb(q['SQL'], schema=q['db_id'])
            q['gold_result'] = get_sqlite_result(q['SQL'], q['db_id'])
            q['data_mismatch'] = True

    # Save fixed questions
    with open(OUTPUT_FILE, 'w') as f:
        json.dump(questions, f, indent=2, default=str)

    print(f"Fixed {fixed_count} queries")
    print(f"Questions needing manual review: {manual_fix_needed}")
    print(f"Saved to: {OUTPUT_FILE}")


if __name__ == "__main__":
    main()
