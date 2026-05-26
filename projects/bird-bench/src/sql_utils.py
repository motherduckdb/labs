"""
SQL utility functions for BIRD-Bench evaluation.

Uses SQLGlot for proper SQL dialect translation from SQLite to DuckDB.
"""

import sqlglot
from sqlglot import exp


def sqlite_to_duckdb(sql: str, schema: str | None = None) -> str:
    """
    Translate SQLite SQL to DuckDB-compatible SQL using SQLGlot.

    BIRD benchmark gold SQLs are written for SQLite, but we use DuckDB.
    SQLGlot handles dialect differences including:
    - IIF() → CASE WHEN
    - Backticks → double quotes
    - Type coercion differences
    - Function name differences

    Args:
        sql: SQLite SQL query
        schema: Optional schema name to qualify table references

    Returns:
        DuckDB-compatible SQL query
    """
    try:
        # Parse as SQLite, transpile to DuckDB
        translated = sqlglot.transpile(
            sql,
            read="sqlite",
            write="duckdb",
            pretty=False,
        )[0]

        # Add schema qualification if provided
        if schema:
            translated = qualify_tables(translated, schema)

        return translated

    except Exception as e:
        # Fallback to original SQL with basic fixes if SQLGlot fails
        return _fallback_translate(sql, schema)


def qualify_tables(sql: str, schema: str) -> str:
    """
    Add schema qualification to table references.

    Transforms: FROM table → FROM schema.table
    Skips CTE names to avoid breaking WITH clauses.
    """
    try:
        # Parse the SQL
        tree = sqlglot.parse_one(sql, dialect="duckdb")

        # Collect CTE names so we don't schema-qualify them
        cte_names = set()
        for cte in tree.find_all(exp.CTE):
            if cte.alias:
                cte_names.add(cte.alias.lower())

        # Find all table references and qualify them
        for table in tree.find_all(exp.Table):
            # Skip if already has a schema/database qualifier
            if table.db or table.catalog:
                continue
            # Skip CTE references
            if table.name.lower() in cte_names:
                continue
            # Add schema
            table.set("db", exp.Identifier(this=schema, quoted=False))

        return tree.sql(dialect="duckdb")

    except Exception:
        # Fallback to regex-based qualification
        return _regex_qualify_tables(sql, schema)


def _regex_qualify_tables(sql: str, schema: str) -> str:
    """Fallback regex-based table qualification."""
    import re

    def qualify_table(match):
        keyword = match.group(1)  # FROM or JOIN
        table = match.group(2)    # table name
        alias_part = match.group(3) or ""  # AS alias or just alias

        # Skip if already schema-qualified (contains a dot)
        if '.' in table:
            return match.group(0)

        return f"{keyword} {schema}.{table}{alias_part}"

    return re.sub(
        r'\b(FROM|JOIN)\s+([a-zA-Z_][a-zA-Z0-9_]*)(\s+(?:AS\s+)?[a-zA-Z_][a-zA-Z0-9_]*)?(?=\s|$|,|\))',
        qualify_table,
        sql,
        flags=re.IGNORECASE
    )


def _fallback_translate(sql: str, schema: str | None = None) -> str:
    """
    Fallback translation using regex when SQLGlot fails.

    This handles basic cases:
    - IIF() → CASE WHEN
    - Backticks → double quotes
    """
    import re

    # IIF(condition, true_val, false_val) → CASE WHEN condition THEN true_val ELSE false_val END
    def replace_iif(match):
        args = match.group(1)
        depth = 0
        parts = []
        current = ""
        for char in args:
            if char == '(':
                depth += 1
            elif char == ')':
                depth -= 1
            elif char == ',' and depth == 0:
                parts.append(current.strip())
                current = ""
                continue
            current += char
        parts.append(current.strip())

        if len(parts) == 3:
            return f"CASE WHEN {parts[0]} THEN {parts[1]} ELSE {parts[2]} END"
        return match.group(0)

    sql = re.sub(r'\bIIF\s*\(([^)]+(?:\([^)]*\)[^)]*)*)\)', replace_iif, sql, flags=re.IGNORECASE)

    # Convert backticks to double quotes
    sql = re.sub(r'`([^`]+)`', r'"\1"', sql)

    # Add schema qualification if provided
    if schema:
        sql = _regex_qualify_tables(sql, schema)

    return sql


if __name__ == "__main__":
    # Test cases
    test_queries = [
        # Q1168 - backticks and date subtraction
        (
            "thrombosis_prediction",
            """SELECT T1.Date, STRFTIME('%Y', T2.`First Date`) - STRFTIME('%Y', T2.Birthday),T2.Birthday FROM Laboratory AS T1 INNER JOIN Patient AS T2 ON T1.ID = T2.ID WHERE T2.Diagnosis = 'SJS' AND T2.Birthday IS NOT NULL ORDER BY T2.Birthday ASC LIMIT 1"""
        ),
        # Q1028 - GROUP BY issue
        (
            "european_football_2",
            """SELECT teamInfo.team_long_name FROM League AS leagueData INNER JOIN Match AS matchData ON leagueData.id = matchData.league_id INNER JOIN Team AS teamInfo ON matchData.away_team_api_id = teamInfo.team_api_id WHERE leagueData.name = 'Scotland Premier League' AND matchData.season = '2009/2010' AND matchData.away_team_goal - matchData.home_team_goal > 0 GROUP BY matchData.away_team_api_id ORDER BY COUNT(*) DESC LIMIT 1"""
        ),
        # Q880 - IIF with type mismatch
        (
            "formula_1",
            """SELECT (SUM(IIF(T2.raceId = 853, T2.fastestLapSpeed, 0)) - SUM(IIF(T2.raceId = 854, T2.fastestLapSpeed, 0))) * 100 / SUM(IIF(T2.raceId = 853, T2.fastestLapSpeed, 0)) FROM drivers AS T1 INNER JOIN results AS T2 ON T2.driverId = T1.driverId WHERE T1.forename = 'Paul' AND T1.surname = 'di Resta'"""
        ),
    ]

    for schema, sql in test_queries:
        print(f"Schema: {schema}")
        print(f"Original: {sql[:80]}...")
        translated = sqlite_to_duckdb(sql, schema=schema)
        print(f"Translated: {translated[:80]}...")
        print()
