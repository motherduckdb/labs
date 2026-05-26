"""Hydrate MotherDuck query history with gold SQL from train set."""

import sqlglot
from sqlglot import exp
from dataclasses import dataclass
from typing import Callable

from eval.database_setup import get_motherduck_connection


# Manual overrides for queries that can't be automatically translated.
# Maps question_id to replacement DuckDB SQL (already schema-qualified).
# These fix SQLite/DuckDB incompatibilities in gold SQL.
QUERY_OVERRIDES: dict[int, str] = {
    # Q1011: CTE with time parsing - lapTimes.time format is 'm:ss.sss' (e.g., '1:23.456')
    # Use split_part to handle the time format properly
    1011: """
WITH lap_times_in_seconds AS (
    SELECT driverId,
        CAST(split_part(time, ':', 1) AS DOUBLE) * 60 +
        CAST(split_part(split_part(time, ':', 2), '.', 1) AS DOUBLE) +
        CAST(split_part(time, '.', 2) AS DOUBLE) / 1000
        AS time_in_seconds
    FROM formula_1.lapTimes
    WHERE time IS NOT NULL AND time != ''
)
SELECT T2.forename, T2.surname, T1.driverId
FROM (SELECT driverId, MIN(time_in_seconds) AS min_time_in_seconds FROM lap_times_in_seconds GROUP BY driverId) AS T1
INNER JOIN formula_1.drivers AS T2 ON T1.driverId = T2.driverId
ORDER BY T1.min_time_in_seconds ASC LIMIT 20
""",

    # Q944: CTE with time parsing for race results
    944: """
WITH time_in_seconds AS (
    SELECT T1.positionOrder,
        CASE WHEN T1.positionOrder = 1
             THEN (CAST(SUBSTRING(T1.time, 1, 1) AS DOUBLE) * 3600) +
                  (CAST(SUBSTRING(T1.time, 3, 2) AS DOUBLE) * 60) +
                  CAST(SUBSTRING(T1.time, 6) AS DOUBLE)
             ELSE CAST(SUBSTRING(T1.time, 2) AS DOUBLE)
        END AS time_seconds
    FROM formula_1.results AS T1
    INNER JOIN formula_1.races AS T2 ON T1.raceId = T2.raceId
    WHERE T2.name = 'Australian Grand Prix' AND T1.time IS NOT NULL AND T2.year = 2008
),
champion_time AS (SELECT time_seconds FROM time_in_seconds WHERE positionOrder = 1),
last_driver_incremental AS (SELECT time_seconds FROM time_in_seconds WHERE positionOrder = (SELECT MAX(positionOrder) FROM time_in_seconds))
SELECT (CAST((SELECT time_seconds FROM last_driver_incremental) AS DOUBLE) * 100) /
       (SELECT time_seconds + (SELECT time_seconds FROM last_driver_incremental) FROM champion_time)
""",

    # Q518: CTE MaxBanned preserved properly
    518: """
WITH MaxBanned AS (
    SELECT format, COUNT(*) AS count_banned
    FROM card_games.legalities
    WHERE status = 'Banned'
    GROUP BY format
    ORDER BY COUNT(*) DESC
    LIMIT 1
)
SELECT T2.format, T1.name
FROM card_games.cards AS T1
INNER JOIN card_games.legalities AS T2 ON T2.uuid = T1.uuid
INNER JOIN MaxBanned MB ON MB.format = T2.format
WHERE T2.status = 'Banned'
""",

    # Q1032: Add league_id to inner subquery GROUP BY
    1032: """
SELECT t2.name, t1.max_count
FROM european_football_2.League AS t2
JOIN (
    SELECT league_id, MAX(cnt) AS max_count
    FROM (SELECT league_id, COUNT(id) AS cnt FROM european_football_2.Match GROUP BY league_id) AS subquery
    GROUP BY league_id
) AS t1 ON t1.league_id = t2.id
ORDER BY t1.max_count DESC
LIMIT 1
""",

    # Q963: Fix time parsing - lapTimes.time format is 'm:ss.sss'
    963: """
SELECT COUNT(T1.driverId)
FROM formula_1.drivers AS T1
INNER JOIN formula_1.lapTimes AS T2 ON T1.driverId = T2.driverId
WHERE T1.nationality = 'French'
  AND T2.time IS NOT NULL
  AND (CAST(split_part(T2.time, ':', 1) AS DOUBLE) * 60 +
       CAST(split_part(split_part(T2.time, ':', 2), '.', 1) AS DOUBLE) +
       CAST(split_part(T2.time, '.', 2) AS DOUBLE) / 1000) < 120
""",

    # Q988: duration format is 'ss.sss' (seconds with milliseconds), AVG needs numeric
    # pitStops.duration is already numeric in seconds (e.g., 23.456)
    988: """
SELECT T2.forename, T2.surname
FROM formula_1.pitStops AS T1
INNER JOIN formula_1.drivers AS T2 ON T1.driverId = T2.driverId
WHERE T2.nationality = 'German'
  AND CAST(STRFTIME(T2.dob, '%Y') AS INTEGER) BETWEEN 1980 AND 1985
GROUP BY T2.forename, T2.surname
ORDER BY AVG(T1.milliseconds)
LIMIT 3
""",

    # Q880: Cast fastestLapSpeed to DOUBLE for arithmetic
    880: """
SELECT (SUM(CASE WHEN T2.raceId = 853 THEN CAST(T2.fastestLapSpeed AS DOUBLE) ELSE 0 END) -
        SUM(CASE WHEN T2.raceId = 854 THEN CAST(T2.fastestLapSpeed AS DOUBLE) ELSE 0 END)) * 100 /
       SUM(CASE WHEN T2.raceId = 853 THEN CAST(T2.fastestLapSpeed AS DOUBLE) ELSE 0 END)
FROM formula_1.drivers AS T1
INNER JOIN formula_1.results AS T2 ON T2.driverId = T1.driverId
WHERE T1.forename = 'Paul' AND T1.surname = 'di Resta'
""",

    # Q1185: Cast Date to VARCHAR for LIKE pattern
    1185: """
SELECT CAST((SUM(CASE WHEN CAST(T2.Date AS VARCHAR) LIKE '1981-11-%' THEN T2."T-CHO" ELSE 0 END) -
             SUM(CASE WHEN CAST(T2.Date AS VARCHAR) LIKE '1981-12-%' THEN T2."T-CHO" ELSE 0 END)) AS DOUBLE) /
       SUM(CASE WHEN CAST(T2.Date AS VARCHAR) LIKE '1981-12-%' THEN T2."T-CHO" ELSE 0 END)
FROM thrombosis_prediction.Patient AS T1
INNER JOIN thrombosis_prediction.Laboratory AS T2 ON T1.ID = T2.ID
WHERE T1.Birthday = '1959-02-18'
""",

    # Q1192: Cast Date to VARCHAR for LIKE pattern
    1192: """
SELECT DISTINCT T1.ID
FROM thrombosis_prediction.Patient AS T1
INNER JOIN thrombosis_prediction.Laboratory AS T2 ON T1.ID = T2.ID
WHERE T1.Admission = '-' AND T2."T-BIL" < 2.0 AND CAST(T2.Date AS VARCHAR) LIKE '1991-10-%'
""",

    # Q1481: Replace IIF with CASE WHEN (DuckDB doesn't have IIF), cast Date for BETWEEN
    1481: """
SELECT CAST(SUM(CASE WHEN T1.Segment = 'SME' THEN T2.Consumption ELSE 0 END) AS DOUBLE) / COUNT(T1.CustomerID) -
       CAST(SUM(CASE WHEN T1.Segment = 'LAM' THEN T2.Consumption ELSE 0 END) AS DOUBLE) / COUNT(T1.CustomerID),
       CAST(SUM(CASE WHEN T1.Segment = 'LAM' THEN T2.Consumption ELSE 0 END) AS DOUBLE) / COUNT(T1.CustomerID) -
       CAST(SUM(CASE WHEN T1.Segment = 'KAM' THEN T2.Consumption ELSE 0 END) AS DOUBLE) / COUNT(T1.CustomerID),
       CAST(SUM(CASE WHEN T1.Segment = 'KAM' THEN T2.Consumption ELSE 0 END) AS DOUBLE) / COUNT(T1.CustomerID) -
       CAST(SUM(CASE WHEN T1.Segment = 'SME' THEN T2.Consumption ELSE 0 END) AS DOUBLE) / COUNT(T1.CustomerID)
FROM debit_card_specializing.customers AS T1
INNER JOIN debit_card_specializing.yearmonth AS T2 ON T1.CustomerID = T2.CustomerID
WHERE T1.Currency = 'CZK'
  AND T2.Consumption = (SELECT MIN(Consumption) FROM debit_card_specializing.yearmonth)
  AND CAST(T2.Date AS INTEGER) BETWEEN 201301 AND 201312
""",
}


@dataclass
class HydrationResult:
    """Result of hydrating a single query."""
    question_id: int
    db_id: str
    original_sql: str
    translated_sql: str | None
    success: bool
    error: str | None = None


@dataclass
class HydrationSummary:
    """Summary of hydration run."""
    total: int
    successful: int
    failed: int
    results: list[HydrationResult]

    @property
    def errors(self) -> list[HydrationResult]:
        return [r for r in self.results if not r.success]


def translate_sqlite_to_duckdb(sql: str, schema: str) -> str:
    """
    Translate SQLite SQL to DuckDB dialect with schema qualification.

    Args:
        sql: SQLite SQL query
        schema: Schema name to qualify table references (e.g., "debit_card_specializing")

    Returns:
        DuckDB-compatible SQL with schema-qualified tables
    """
    # Parse as SQLite
    parsed = sqlglot.parse_one(sql, dialect="sqlite")

    # Qualify all table references with schema
    for table in parsed.find_all(exp.Table):
        if not table.db:  # No schema qualifier present
            table.set("db", exp.to_identifier(schema))

    # Handle SQLite-specific functions that sqlglot might miss
    parsed = _patch_sqlite_functions(parsed)

    # Transpile to DuckDB
    return parsed.sql(dialect="duckdb")


def _patch_sqlite_functions(expression: exp.Expression) -> exp.Expression:
    """
    Patch SQLite-specific function syntax for DuckDB compatibility.

    Handles edge cases that sqlglot's dialect translation might miss.
    """
    # Numeric format patterns that should be cast to INTEGER for arithmetic
    numeric_formats = {"'%Y'", "'%m'", "'%d'", "'%H'", "'%M'", "'%S'", "'%j'", "'%W'"}

    def transform_node(node):
        # Handle TimeToStr (sqlglot's internal representation of strftime)
        # When format is numeric (like '%Y'), wrap in CAST to INTEGER for arithmetic
        if isinstance(node, exp.TimeToStr):
            # Get the format argument
            format_arg = node.args.get("format")
            if format_arg:
                format_str = format_arg.sql() if hasattr(format_arg, 'sql') else str(format_arg)
                if format_str in numeric_formats:
                    # Wrap in CAST(... AS INTEGER)
                    return exp.Cast(
                        this=node,
                        to=exp.DataType.build("INTEGER")
                    )

        # Handle Anonymous strftime (fallback for cases sqlglot doesn't convert)
        if isinstance(node, exp.Anonymous) and node.name.lower() == "strftime":
            args = list(node.expressions)
            if len(args) >= 2:
                format_arg = args[0]
                date_arg = args[1]

                # Swap format and date arguments for DuckDB
                node.set("expressions", [date_arg, format_arg] + args[2:])

                # Check if format is numeric
                format_str = format_arg.sql() if hasattr(format_arg, 'sql') else str(format_arg)
                if format_str in numeric_formats:
                    return exp.Cast(
                        this=node,
                        to=exp.DataType.build("INTEGER")
                    )

        return node

    return expression.transform(transform_node)


class GoldSQLHydrator:
    """Executes gold SQL queries against MotherDuck to populate query history."""

    def __init__(self, database: str):
        """
        Initialize hydrator.

        Args:
            database: Target MotherDuck database (e.g., "bird_bench_c")
        """
        self.database = database

    def hydrate(
        self,
        questions: list[dict],
        dry_run: bool = False,
        on_progress: Callable[[int, int, str], None] | None = None,
    ) -> HydrationSummary:
        """
        Execute gold SQL queries against MotherDuck.

        Args:
            questions: List of question dicts with 'question_id', 'db_id', 'SQL' keys
            dry_run: If True, translate only without executing
            on_progress: Optional callback(current, total, message)

        Returns:
            HydrationSummary with results
        """
        results: list[HydrationResult] = []

        if dry_run:
            # Dry run - just translate, don't connect
            for i, q in enumerate(questions):
                if on_progress:
                    on_progress(i + 1, len(questions), f"Translating {q['db_id']}")

                result = self._translate_question(q)
                results.append(result)

            return HydrationSummary(
                total=len(questions),
                successful=sum(1 for r in results if r.success),
                failed=sum(1 for r in results if not r.success),
                results=results,
            )

        # Real execution
        conn = get_motherduck_connection(self.database)

        try:
            for i, q in enumerate(questions):
                if on_progress:
                    on_progress(i + 1, len(questions), f"Hydrating {q['db_id']}")

                result = self._execute_question(q, conn)
                results.append(result)

        finally:
            conn.close()

        return HydrationSummary(
            total=len(questions),
            successful=sum(1 for r in results if r.success),
            failed=sum(1 for r in results if not r.success),
            results=results,
        )

    def _translate_question(self, question: dict) -> HydrationResult:
        """Translate a single question's gold SQL."""
        question_id = question["question_id"]

        # Check for manual override (pre-translated DuckDB SQL)
        if question_id in QUERY_OVERRIDES:
            return HydrationResult(
                question_id=question_id,
                db_id=question["db_id"],
                original_sql=question["SQL"],
                translated_sql=QUERY_OVERRIDES[question_id].strip(),
                success=True,
            )

        try:
            translated = translate_sqlite_to_duckdb(
                question["SQL"],
                schema=question["db_id"],
            )
            return HydrationResult(
                question_id=question_id,
                db_id=question["db_id"],
                original_sql=question["SQL"],
                translated_sql=translated,
                success=True,
            )
        except Exception as e:
            return HydrationResult(
                question_id=question_id,
                db_id=question["db_id"],
                original_sql=question["SQL"],
                translated_sql=None,
                success=False,
                error=str(e),
            )

    def _execute_question(self, question: dict, conn) -> HydrationResult:
        """Translate and execute a single question's gold SQL."""
        # First translate
        result = self._translate_question(question)
        if not result.success:
            return result

        # Then execute
        try:
            conn.execute(result.translated_sql)
            return result
        except Exception as e:
            return HydrationResult(
                question_id=question["question_id"],
                db_id=question["db_id"],
                original_sql=question["SQL"],
                translated_sql=result.translated_sql,
                success=False,
                error=f"Execution failed: {e}",
            )
