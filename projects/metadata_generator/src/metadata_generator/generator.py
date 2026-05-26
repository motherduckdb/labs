"""
LLM-based Metadata Generator

Generates natural language descriptions of database columns using profile statistics.
Uses OpenRouter to access various LLM models.
"""

import json
import logging
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path

from metadata_generator.config import MAX_QUERY_SAMPLES, DEFAULT_MAX_WORKERS, MAX_WORKERS_LIMIT
from metadata_generator.llm_client import create_openrouter_client, get_model
from metadata_generator.persistence import save_json, load_json
from metadata_generator.progress import ProgressCallback, ProgressReporter

logger = logging.getLogger(__name__)

from metadata_generator.models import (
    SchemaProfile,
    ColumnProfile,
    ColumnDescription,
    TableDescription,
    SchemaDescription,
)


@dataclass
class JoinPatternContext:
    """Join pattern context for a table from query history."""

    left_table: str
    left_column: str
    right_table: str
    right_column: str
    occurrence_count: int


@dataclass
class FieldUsageContext:
    """Field usage statistics for a column from query history."""

    table_name: str
    column_name: str
    select_count: int
    where_count: int
    join_count: int
    group_by_count: int
    order_by_count: int
    importance_score: float


@dataclass
class PredicateContext:
    """Predicate pattern context for a column from query history."""

    table_name: str
    column_name: str
    operator: str
    value_pattern: str
    occurrence_count: int
    example_values: list[str]


# Cache for loaded history JSON to avoid repeated file reads
_HISTORY_CACHE_MAX_SIZE = 64
_history_cache: dict[str, "QueryHistoryResult | None"] = {}


def _load_history_from_json(schema: str, history_dir: str = "output/history", database: str | None = None) -> "QueryHistoryResult | None":
    """
    Load query history result from JSON file.

    Args:
        schema: Schema name
        history_dir: Directory containing history JSON files
        database: MotherDuck database name

    Returns:
        QueryHistoryResult or None if file doesn't exist
    """
    # Import here to avoid circular dependency
    from metadata_generator.history import QueryHistoryResult

    cache_key = f"{history_dir}/{database}/{schema}"
    if cache_key in _history_cache:
        return _history_cache[cache_key]

    if database:
        json_path = Path(history_dir) / f"{database}_{schema}_history.json"
    else:
        json_path = Path(history_dir) / f"{schema}_history.json"
    result = load_json(QueryHistoryResult, json_path)
    if len(_history_cache) >= _HISTORY_CACHE_MAX_SIZE:
        _history_cache.clear()
    _history_cache[cache_key] = result

    if result:
        logger.info(f"Loaded history from JSON: {json_path}")
    return result


def load_predicate_patterns(
    schema: str, token: str | None = None, history_dir: str = "output/history", database: str | None = None
) -> dict[tuple[str, str], list[PredicateContext]]:
    """
    Load predicate patterns from metadata schema, falling back to JSON file.

    Args:
        schema: Schema name to filter by
        token: MotherDuck token (falls back to env var)
        history_dir: Directory containing history JSON files for fallback
        database: MotherDuck database name

    Returns:
        Dict mapping (table_name, column_name) to list of PredicateContext
    """
    import os
    import duckdb

    token = token or os.environ.get("MOTHERDUCK_TOKEN")
    if not token:
        logger.warning("No MOTHERDUCK_TOKEN, skipping predicate patterns")
        return {}

    try:
        conn = duckdb.connect(f"md:?motherduck_token={token}")
        result = conn.execute("""
            SELECT table_name, column_name, operator, value_pattern,
                   occurrence_count, example_values
            FROM metadata.predicate_patterns
            WHERE schema_name = ?
            ORDER BY occurrence_count DESC
        """, [schema]).fetchall()
        conn.close()

        patterns: dict[tuple[str, str], list[PredicateContext]] = {}
        for row in result:
            key = (row[0], row[1])
            ctx = PredicateContext(
                table_name=row[0],
                column_name=row[1],
                operator=row[2],
                value_pattern=row[3],
                occurrence_count=row[4],
                example_values=row[5] if row[5] else [],
            )
            if key not in patterns:
                patterns[key] = []
            patterns[key].append(ctx)

        logger.info(f"Loaded predicate patterns for {len(patterns)} columns from database")
        return patterns

    except Exception as e:
        logger.debug(f"Database load failed, trying JSON fallback: {e}")

        # Fallback to JSON file
        history = _load_history_from_json(schema, history_dir, database)
        if history and history.predicates:
            patterns: dict[tuple[str, str], list[PredicateContext]] = {}
            for pred in history.predicates:
                key = (pred.table, pred.column)
                ctx = PredicateContext(
                    table_name=pred.table,
                    column_name=pred.column,
                    operator=pred.operator,
                    value_pattern=pred.value_pattern,
                    occurrence_count=pred.occurrence_count,
                    example_values=pred.example_values or [],
                )
                if key not in patterns:
                    patterns[key] = []
                patterns[key].append(ctx)
            logger.info(f"Loaded predicate patterns for {len(patterns)} columns from JSON")
            return patterns

        return {}


def load_join_patterns(
    schema: str, token: str | None = None, history_dir: str = "output/history", database: str | None = None
) -> dict[str, list[JoinPatternContext]]:
    """
    Load join patterns from metadata schema, falling back to JSON file.

    Args:
        schema: Schema name to filter by
        token: MotherDuck token (falls back to env var)
        history_dir: Directory containing history JSON files for fallback
        database: MotherDuck database name

    Returns:
        Dict mapping table_name to list of JoinPatternContext involving that table
    """
    import os
    import duckdb

    token = token or os.environ.get("MOTHERDUCK_TOKEN")
    if not token:
        logger.warning("No MOTHERDUCK_TOKEN, skipping join patterns")
        return {}

    try:
        conn = duckdb.connect(f"md:?motherduck_token={token}")
        result = conn.execute("""
            SELECT left_table, left_column, right_table, right_column, occurrence_count
            FROM metadata.join_patterns
            WHERE schema_name = ?
            ORDER BY occurrence_count DESC
        """, [schema]).fetchall()
        conn.close()

        patterns: dict[str, list[JoinPatternContext]] = {}
        for row in result:
            ctx = JoinPatternContext(
                left_table=row[0],
                left_column=row[1],
                right_table=row[2],
                right_column=row[3],
                occurrence_count=row[4],
            )
            # Add to both tables involved in the join
            for table in [row[0], row[2]]:
                if table not in patterns:
                    patterns[table] = []
                patterns[table].append(ctx)

        logger.info(f"Loaded join patterns for {len(patterns)} tables from database")
        return patterns

    except Exception as e:
        logger.debug(f"Database load failed, trying JSON fallback: {e}")

        # Fallback to JSON file
        history = _load_history_from_json(schema, history_dir, database)
        if history and history.joins:
            patterns: dict[str, list[JoinPatternContext]] = {}
            for join in history.joins:
                ctx = JoinPatternContext(
                    left_table=join.left_table,
                    left_column=join.left_column,
                    right_table=join.right_table,
                    right_column=join.right_column,
                    occurrence_count=join.count,
                )
                # Add to both tables involved in the join
                for table in [join.left_table, join.right_table]:
                    if table not in patterns:
                        patterns[table] = []
                    patterns[table].append(ctx)
            logger.info(f"Loaded join patterns for {len(patterns)} tables from JSON")
            return patterns

        return {}


def load_field_usage(
    schema: str, token: str | None = None, history_dir: str = "output/history", database: str | None = None
) -> dict[tuple[str, str], FieldUsageContext]:
    """
    Load field usage statistics from metadata schema, falling back to JSON file.

    Args:
        schema: Schema name to filter by
        token: MotherDuck token (falls back to env var)
        history_dir: Directory containing history JSON files for fallback
        database: MotherDuck database name

    Returns:
        Dict mapping (table_name, column_name) to FieldUsageContext
    """
    import os
    import duckdb

    token = token or os.environ.get("MOTHERDUCK_TOKEN")
    if not token:
        logger.warning("No MOTHERDUCK_TOKEN, skipping field usage")
        return {}

    try:
        conn = duckdb.connect(f"md:?motherduck_token={token}")
        result = conn.execute("""
            SELECT table_name, column_name, select_count, where_count, join_count,
                   group_by_count, order_by_count, importance_score
            FROM metadata.field_usage
            WHERE schema_name = ?
            ORDER BY importance_score DESC
        """, [schema]).fetchall()
        conn.close()

        usage: dict[tuple[str, str], FieldUsageContext] = {}
        for row in result:
            key = (row[0], row[1])
            usage[key] = FieldUsageContext(
                table_name=row[0],
                column_name=row[1],
                select_count=row[2],
                where_count=row[3],
                join_count=row[4],
                group_by_count=row[5],
                order_by_count=row[6],
                importance_score=row[7],
            )

        logger.info(f"Loaded field usage for {len(usage)} columns from database")
        return usage

    except Exception as e:
        logger.debug(f"Database load failed, trying JSON fallback: {e}")

        # Fallback to JSON file
        history = _load_history_from_json(schema, history_dir, database)
        if history and history.field_usage:
            usage: dict[tuple[str, str], FieldUsageContext] = {}
            for field in history.field_usage:
                key = (field.table, field.column)
                usage[key] = FieldUsageContext(
                    table_name=field.table,
                    column_name=field.column,
                    select_count=field.select_count,
                    where_count=field.where_count,
                    join_count=field.join_count,
                    group_by_count=field.group_by_count,
                    order_by_count=field.order_by_count,
                    importance_score=field.importance_score,
                )
            logger.info(f"Loaded field usage for {len(usage)} columns from JSON")
            return usage

        return {}


@dataclass
class DerivedMetricContext:
    """Derived metric from query history."""

    expression: str
    alias_names: list[str]
    occurrence_count: int
    tables_involved: list[str]


@dataclass
class DerivedColumnContext:
    """Derived column definition from query history.

    Maps column aliases to their source expressions,
    enabling field resolution understanding.
    """

    alias: str  # The computed column name (e.g., "revenue", "order_count")
    expression: str  # The source expression
    tables_involved: list[str]
    occurrence_count: int
    contexts: list[str]  # Where it appears: "SELECT", "CTE"


def load_derived_columns(
    schema: str, history_dir: str = "output/history", database: str | None = None
) -> dict[str, list[DerivedColumnContext]]:
    """
    Load derived column definitions from history JSON file.

    Derived columns map aliases like "revenue" to expressions like
    "SUM(unit_price * quantity * (1 - discount))".

    Args:
        schema: Schema name
        history_dir: Directory containing history JSON files
        database: MotherDuck database name

    Returns:
        Dict mapping table_name to list of DerivedColumnContext
    """
    history = _load_history_from_json(schema, history_dir, database)
    if not history or not history.derived_columns:
        return {}

    # Group by tables involved
    columns: dict[str, list[DerivedColumnContext]] = {}
    for dc in history.derived_columns:
        ctx = DerivedColumnContext(
            alias=dc.alias,
            expression=dc.expression,
            tables_involved=dc.tables_involved or [],
            occurrence_count=dc.occurrence_count,
            contexts=dc.common_contexts or [],
        )
        # Add to each table involved
        for table in dc.tables_involved or []:
            if table not in columns:
                columns[table] = []
            columns[table].append(ctx)

    logger.info(f"Loaded derived columns for {len(columns)} tables from JSON")
    return columns


def load_derived_metrics(
    schema: str, token: str | None = None, history_dir: str = "output/history", database: str | None = None
) -> dict[str, list[DerivedMetricContext]]:
    """
    Load derived metrics from metadata schema, falling back to JSON file.

    Args:
        schema: Schema name to filter by
        token: MotherDuck token (falls back to env var)
        history_dir: Directory containing history JSON files for fallback
        database: MotherDuck database name

    Returns:
        Dict mapping table_name to list of DerivedMetricContext
    """
    import os
    import duckdb

    token = token or os.environ.get("MOTHERDUCK_TOKEN")
    if not token:
        logger.warning("No MOTHERDUCK_TOKEN, skipping derived metrics")
        return {}

    try:
        conn = duckdb.connect(f"md:?motherduck_token={token}")
        result = conn.execute("""
            SELECT expression, alias_names, occurrence_count, tables_involved
            FROM metadata.derived_metrics
            WHERE schema_name = ?
            ORDER BY occurrence_count DESC
        """, [schema]).fetchall()
        conn.close()

        # Group metrics by table (use first table if multiple)
        metrics: dict[str, list[DerivedMetricContext]] = {}
        for row in result:
            tables = row[3] if row[3] else []
            # Skip metrics with no table context or generic ones like COUNT(*)
            if not tables:
                continue

            ctx = DerivedMetricContext(
                expression=row[0],
                alias_names=row[1] if row[1] else [],
                occurrence_count=row[2],
                tables_involved=tables,
            )

            # Add to each table involved
            for table in tables:
                if table not in metrics:
                    metrics[table] = []
                metrics[table].append(ctx)

        logger.info(f"Loaded derived metrics for {len(metrics)} tables from database")
        return metrics

    except Exception as e:
        logger.debug(f"Database load failed, trying JSON fallback: {e}")

        # Fallback to JSON file
        history = _load_history_from_json(schema, history_dir, database)
        if history and history.derived_metrics:
            metrics: dict[str, list[DerivedMetricContext]] = {}
            for metric in history.derived_metrics:
                ctx = DerivedMetricContext(
                    expression=metric.expression,
                    alias_names=metric.alias_names or [],
                    occurrence_count=metric.occurrence_count,
                    tables_involved=metric.tables_involved or [],
                )
                # Add to each table involved
                for table in metric.tables_involved or []:
                    if table not in metrics:
                        metrics[table] = []
                    metrics[table].append(ctx)
            logger.info(f"Loaded derived metrics for {len(metrics)} tables from JSON")
            return metrics

        return {}


@dataclass
class QueryUseCaseContext:
    """Translated query sample representing a use case."""

    query_text: str
    natural_language: str
    tables_involved: list[str]


def load_query_samples(
    schema: str, token: str | None = None, history_dir: str = "output/history", database: str | None = None
) -> list[str]:
    """
    Load query samples from metadata schema, falling back to JSON file.

    Args:
        schema: Schema name to filter by
        token: MotherDuck token (falls back to env var)
        history_dir: Directory containing history JSON files for fallback
        database: MotherDuck database name

    Returns:
        List of query text strings
    """
    import os
    import duckdb

    token = token or os.environ.get("MOTHERDUCK_TOKEN")
    if not token:
        logger.warning("No MOTHERDUCK_TOKEN, skipping query samples")
        return []

    try:
        conn = duckdb.connect(f"md:?motherduck_token={token}")
        result = conn.execute("""
            SELECT query_text
            FROM metadata.query_samples
            WHERE schema_name = ?
            ORDER BY sample_index
        """, [schema]).fetchall()
        conn.close()

        samples = [row[0] for row in result]
        logger.info(f"Loaded {len(samples)} query samples from database")
        return samples

    except Exception as e:
        logger.debug(f"Database load failed, trying JSON fallback: {e}")

        # Fallback to JSON file
        history = _load_history_from_json(schema, history_dir, database)
        if history and history.query_samples:
            logger.info(f"Loaded {len(history.query_samples)} query samples from JSON")
            return history.query_samples

        return []


def generate_use_cases(
    query_samples: list[str],
    model: str | None = None,
    max_samples: int = MAX_QUERY_SAMPLES,
    schema: str | None = None,
    output_dir: str = "output/use_cases",
    database: str | None = None,
    max_workers: int = DEFAULT_MAX_WORKERS,
) -> dict[str, list[QueryUseCaseContext]]:
    """
    Translate query samples to natural language use cases.

    Args:
        query_samples: List of SQL query strings
        model: LLM model to use for translation
        max_samples: Maximum samples to translate
        schema: Schema name for saving output (optional)
        output_dir: Directory to save use cases JSON
        database: MotherDuck database name
        max_workers: Maximum parallel workers for LLM calls

    Returns:
        Dict mapping table_name to list of use cases involving that table
    """
    from metadata_generator.translator import SQLToTextGenerator, extract_tables_from_sql

    if not query_samples:
        return {}

    # Limit samples and workers
    samples_to_translate = query_samples[:max_samples]
    max_workers = min(max_workers, MAX_WORKERS_LIMIT, len(samples_to_translate))

    generator = SQLToTextGenerator(model=model)
    use_cases: dict[str, list[QueryUseCaseContext]] = {}
    all_translations: list[dict] = []  # For persistence

    def translate_single(sql: str) -> tuple[str, str, list[str]] | None:
        """Translate a single query. Returns (sql, natural_language, tables) or None on error."""
        try:
            translation = generator.translate_query(sql)
            tables = extract_tables_from_sql(sql)
            return (sql, translation.natural_language, tables)
        except Exception as e:
            logger.warning(f"Failed to translate query: {e}")
            return None

    # Execute translations in parallel
    logger.info(f"Translating {len(samples_to_translate)} queries with {max_workers} workers")
    executor = ThreadPoolExecutor(max_workers=max_workers)
    try:
        futures = {executor.submit(translate_single, sql): sql for sql in samples_to_translate}

        for future in as_completed(futures):
            result = future.result()
            if result is None:
                continue

            sql, natural_language, tables = result

            ctx = QueryUseCaseContext(
                query_text=sql,
                natural_language=natural_language,
                tables_involved=tables,
            )

            # Store for persistence
            all_translations.append({
                "query": sql,
                "natural_language": natural_language,
                "tables": tables,
            })

            # Add to each table involved
            for table in tables:
                if table not in use_cases:
                    use_cases[table] = []
                use_cases[table].append(ctx)
    except KeyboardInterrupt:
        logger.info("Interrupted, cancelling pending translations...")
        executor.shutdown(wait=False, cancel_futures=True)
        raise
    finally:
        executor.shutdown(wait=True)

    # Save translations if schema provided
    if schema and all_translations:
        output_path = Path(output_dir)
        output_path.mkdir(parents=True, exist_ok=True)
        if database:
            output_file = output_path / f"{database}_{schema}_use_cases.json"
        else:
            output_file = output_path / f"{schema}_use_cases.json"
        with open(output_file, "w") as f:
            json.dump({
                "schema": schema,
                "database": database,
                "use_cases": all_translations,
            }, f, indent=2)
        logger.info(f"Saved use cases to {output_file}")

    logger.info(f"Generated use cases for {len(use_cases)} tables")
    return use_cases


class MetadataGenerator:
    """
    Generates natural language column descriptions using an LLM.

    Uses profile statistics to create semantic descriptions that help
    models understand database contents.
    """

    def __init__(
        self,
        api_key: str | None = None,
        model: str | None = None,
    ):
        """
        Initialize the generator.

        Args:
            api_key: OpenRouter API key. Falls back to OPENROUTER_API_KEY env var.
            model: Model to use for generation. Defaults to Gemini Flash.
        """
        self.client = create_openrouter_client(api_key)
        self.model = get_model(model)

    def _build_column_prompt(
        self,
        col: ColumnProfile,
        table_name: str,
        predicates: list[PredicateContext] | None = None,
        field_usage: FieldUsageContext | None = None,
        join_patterns: list[JoinPatternContext] | None = None,
        derived_columns: list[DerivedColumnContext] | None = None,
    ) -> str:
        """Build prompt for generating a column description."""
        lines = [
            f"Column: {col.name}",
            f"Table: {table_name}",
            f"Type: {col.dtype}",
        ]

        if col.approx_unique is not None:
            lines.append(f"Distinct values: {col.approx_unique}")

        if col.null_percentage > 0:
            lines.append(f"NULL percentage: {col.null_percentage:.1f}%")

        if col.is_categorical and col.sample_values:
            lines.append(f"Sample values: {', '.join(col.sample_values[:5])}")
        elif col.min_value is not None and col.max_value is not None:
            lines.append(f"Value range: {col.min_value} to {col.max_value}")

        if col.avg is not None:
            lines.append(f"Average: {col.avg:.2f}")

        # Add shape info for string columns
        if col.detected_pattern:
            lines.append(f"Detected pattern: {col.detected_pattern}")
        if col.avg_length is not None:
            lines.append(f"Avg length: {col.avg_length:.1f} chars")
        if col.char_composition:
            comp = col.char_composition
            lines.append(f"Character mix: {comp['alpha']*100:.0f}% alpha, {comp['numeric']*100:.0f}% numeric, {comp['special']*100:.0f}% special")

        # Add field usage from query history
        if field_usage:
            lines.append("")
            lines.append("Query usage from history:")
            lines.append(f"  - Importance score: {field_usage.importance_score:.0f}")
            usage_parts = []
            if field_usage.select_count > 0:
                usage_parts.append(f"SELECT: {field_usage.select_count}x")
            if field_usage.where_count > 0:
                usage_parts.append(f"WHERE: {field_usage.where_count}x")
            if field_usage.join_count > 0:
                usage_parts.append(f"JOIN: {field_usage.join_count}x")
            if field_usage.group_by_count > 0:
                usage_parts.append(f"GROUP BY: {field_usage.group_by_count}x")
            if field_usage.order_by_count > 0:
                usage_parts.append(f"ORDER BY: {field_usage.order_by_count}x")
            if usage_parts:
                lines.append(f"  - {', '.join(usage_parts)}")

        # Add predicate patterns from query history
        if predicates:
            lines.append("")
            lines.append("Common filter patterns from query history:")
            for pred in predicates[:5]:  # Limit to top 5
                example_str = ""
                if pred.example_values and pred.operator == "=":
                    # Show actual values for equality filters (indicates categorical)
                    examples = [str(v) for v in pred.example_values[:3]]
                    example_str = f" (e.g., {', '.join(examples)})"
                lines.append(f"  - {pred.operator} {pred.value_pattern} ({pred.occurrence_count}x){example_str}")

        # Add join patterns from query history
        if join_patterns:
            lines.append("")
            lines.append("Join relationships from query history:")
            for jp in join_patterns[:5]:  # Limit to top 5
                # Show the other side of the join
                if jp.left_table == table_name and jp.left_column == col.name:
                    lines.append(f"  - Joins to {jp.right_table}.{jp.right_column} ({jp.occurrence_count}x)")
                elif jp.right_table == table_name and jp.right_column == col.name:
                    lines.append(f"  - Joins to {jp.left_table}.{jp.left_column} ({jp.occurrence_count}x)")

        # Add derived column context - show common aliases for expressions using this column
        if derived_columns:
            # Filter to derived columns whose expression references this column
            col_lower = col.name.lower()
            relevant = [
                dc for dc in derived_columns
                if col_lower in dc.expression.lower()
            ]
            if relevant:
                lines.append("")
                lines.append("Common computed aliases from query history:")
                for dc in relevant[:5]:  # Limit to top 5
                    lines.append(f"  - '{dc.alias}' = {dc.expression[:60]}{'...' if len(dc.expression) > 60 else ''} ({dc.occurrence_count}x)")

        return "\n".join(lines)

    def _generate_column_description(
        self,
        col: ColumnProfile,
        table_name: str,
        predicates: list[PredicateContext] | None = None,
        field_usage: FieldUsageContext | None = None,
        join_patterns: list[JoinPatternContext] | None = None,
        derived_columns: list[DerivedColumnContext] | None = None,
    ) -> ColumnDescription:
        """Generate description for a single column."""
        col_info = self._build_column_prompt(col, table_name, predicates, field_usage, join_patterns, derived_columns)

        # Build prompt with hints from query history
        history_hints = []

        # Add hint for join patterns - be specific about what this column joins to
        if join_patterns:
            join_targets = []
            for jp in join_patterns[:3]:
                if jp.left_table == table_name and jp.left_column == col.name:
                    join_targets.append(f"{jp.right_table}.{jp.right_column}")
                elif jp.right_table == table_name and jp.right_column == col.name:
                    join_targets.append(f"{jp.left_table}.{jp.left_column}")
            if join_targets:
                history_hints.append(f"This column joins to: {', '.join(join_targets)}. Mention the join relationship in the description.")

        # Add hint for high-usage columns
        if field_usage:
            if field_usage.join_count > 0 and not join_patterns:
                history_hints.append("This column is frequently used in JOINs, suggesting it's a key/foreign key.")
            elif field_usage.importance_score >= 100:
                history_hints.append("This column has high query importance, indicating it's central to analysis.")

        if predicates:
            # Check for patterns that suggest semantic type
            has_equality = any(p.operator == "=" for p in predicates)
            has_date_funcs = any("DATE" in p.value_pattern.upper() or "TODAY" in p.value_pattern.upper() for p in predicates)
            has_comparisons = any(p.operator in (">", "<", ">=", "<=", "BETWEEN") for p in predicates)

            if has_equality and not has_comparisons:
                history_hints.append("This column is commonly filtered with exact matches, suggesting categorical values.")
            elif has_date_funcs:
                history_hints.append("This column is commonly filtered with date functions, confirming it stores dates.")
            elif has_comparisons:
                history_hints.append("This column is commonly filtered with range comparisons, suggesting numeric/measure values.")

        predicate_hint = ""
        if history_hints:
            predicate_hint = "\nNote: " + " ".join(history_hints)

        prompt = f"""Column statistics:
{col_info}
{predicate_hint}
Write a description maximizing both conciseness and precision. Sentence fragments are ok. Never start with "This column" or "Stores".

Good: "Unique order identifier" or "Customer's billing country"
Bad: "This column stores the unique identifier for each order"

Also classify the semantic type as one of: "identifier", "categorical", "measure", "date", "text", "flag", "foreign_key"

Respond in JSON format:
{{"description": "...", "semantic_type": "..."}}"""

        try:
            response = self.client.chat.completions.create(
                model=self.model,
                messages=[
                    {
                        "role": "system",
                        "content": "You are a database documentation expert. These descriptions are for another LLM to read, not humans. Maximize conciseness and precision together. Sentence fragments are ok. Never start with 'This column' or 'Stores'. Never hedge.",
                    },
                    {"role": "user", "content": prompt},
                ],
                max_tokens=200,
                temperature=0.0,
            )

            content = response.choices[0].message.content
            # Parse JSON from response (handle markdown code blocks)
            if "```json" in content:
                content = content.split("```json")[1].split("```")[0]
            elif "```" in content:
                content = content.split("```")[1].split("```")[0]

            data = json.loads(content.strip())

            return ColumnDescription(
                column_name=col.name,
                table_name=table_name,
                description=data.get("description", ""),
                semantic_type=data.get("semantic_type"),
            )
        except Exception as e:
            logger.warning(f"Failed to generate LLM description for {table_name}.{col.name}: {e}")
            # Fallback to basic description
            return ColumnDescription(
                column_name=col.name,
                table_name=table_name,
                description=f"{col.dtype} column with {col.approx_unique or 'unknown'} distinct values",
                semantic_type="unknown",
            )

    def _generate_table_description(
        self,
        table_name: str,
        columns: list[str],
        row_count: int,
        derived_metrics: list[DerivedMetricContext] | None = None,
        use_cases: list[QueryUseCaseContext] | None = None,
        join_patterns: list[JoinPatternContext] | None = None,
    ) -> str:
        """Generate a brief table description with optional join patterns, common calculations and use cases."""
        # Build join patterns section if available
        joins_section = ""
        if join_patterns:
            joins_lines = ["\nCommon joins from query history:"]
            for jp in join_patterns[:5]:  # Top 5 joins
                joins_lines.append(
                    f"  - {jp.left_table}.{jp.left_column} = {jp.right_table}.{jp.right_column} ({jp.occurrence_count}x)"
                )
            joins_section = "\n".join(joins_lines)

        # Build metrics section if available
        metrics_section = ""
        if derived_metrics:
            metrics_lines = ["\nCommon calculations from query history:"]
            for metric in derived_metrics[:5]:  # Top 5 metrics
                aliases = metric.alias_names[:3] if metric.alias_names else []
                alias_str = f" (aliased as: {', '.join(aliases)})" if aliases else ""
                metrics_lines.append(f"  - {metric.expression}{alias_str} ({metric.occurrence_count}x)")
            metrics_section = "\n".join(metrics_lines)

        # Build use cases section if available
        use_cases_section = ""
        if use_cases:
            use_cases_lines = ["\nCommon use cases from query history:"]
            for uc in use_cases[:3]:  # Top 3 use cases
                use_cases_lines.append(f"  - {uc.natural_language}")
            use_cases_section = "\n".join(use_cases_lines)

        prompt = f"""Table: {table_name}
Columns: {', '.join(columns)}
Row count: {row_count:,}
{joins_section}
{metrics_section}
{use_cases_section}

Write a description maximizing both conciseness and precision. Sentence fragments are ok. Never start with "This table".

Good: "Product catalog with pricing, inventory, and supplier links."
Bad: "This table stores comprehensive information about products..."

If joins/metrics/use cases are provided, note key relationships or analyses.

Respond with just the description, no JSON."""

        try:
            response = self.client.chat.completions.create(
                model=self.model,
                messages=[
                    {
                        "role": "system",
                        "content": "You are a database documentation expert. These descriptions are for another LLM to read, not humans. Maximize conciseness and precision together. Sentence fragments are ok. Never start with 'This table'. Never hedge.",
                    },
                    {"role": "user", "content": prompt},
                ],
                max_tokens=200,
                temperature=0.0,
            )
            return response.choices[0].message.content.strip()
        except Exception as e:
            logger.warning(f"Failed to generate LLM description for table {table_name}: {e}")
            return f"Table with {row_count:,} rows"

    def generate_descriptions(
        self,
        profile: SchemaProfile,
        verbose: bool = True,
        on_progress: ProgressCallback | None = None,
        predicate_patterns: dict[tuple[str, str], list[PredicateContext]] | None = None,
        derived_metrics: dict[str, list[DerivedMetricContext]] | None = None,
        use_cases: dict[str, list[QueryUseCaseContext]] | None = None,
        join_patterns: dict[str, list[JoinPatternContext]] | None = None,
        field_usage: dict[tuple[str, str], FieldUsageContext] | None = None,
        derived_columns: dict[str, list[DerivedColumnContext]] | None = None,
        max_workers: int = DEFAULT_MAX_WORKERS,
    ) -> SchemaDescription:
        """
        Generate descriptions for all tables and columns in a schema.

        Uses a queue-based approach where all work items (table descriptions +
        column descriptions) are submitted to a shared worker pool for maximum
        parallelism regardless of table size.

        Args:
            profile: Schema profile with statistics
            verbose: Print progress (show generated descriptions)
            on_progress: Optional callback for progress reporting
            predicate_patterns: Optional dict mapping (table, column) to predicates from query history
            derived_metrics: Optional dict mapping table_name to derived metrics from query history
            use_cases: Optional dict mapping table_name to translated query use cases
            join_patterns: Optional dict mapping table_name to join patterns from query history
            field_usage: Optional dict mapping (table, column) to field usage stats from query history
            derived_columns: Optional dict mapping table_name to derived column definitions from query history
            max_workers: Maximum parallel workers for LLM calls

        Returns:
            SchemaDescription with LLM-generated descriptions
        """
        progress = ProgressReporter(on_progress, enabled=on_progress is not None)

        # Clamp max_workers
        max_workers = min(max_workers, MAX_WORKERS_LIMIT)

        if predicate_patterns:
            progress(f"Using predicate patterns for {len(predicate_patterns)} columns from query history")
        if derived_metrics:
            progress(f"Using derived metrics for {len(derived_metrics)} tables from query history")
        if use_cases:
            progress(f"Using query use cases for {len(use_cases)} tables from query history")
        if join_patterns:
            progress(f"Using join patterns for {len(join_patterns)} tables from query history")
        if field_usage:
            progress(f"Using field usage for {len(field_usage)} columns from query history")
        if derived_columns:
            progress(f"Using derived column definitions for {len(derived_columns)} tables from query history")

        # Count total work items
        total_tables = len(profile.tables)
        total_columns = sum(len(t.columns) for t in profile.tables)
        total_tasks = total_tables + total_columns

        progress(f"Queueing {total_tasks} LLM calls ({total_tables} tables + {total_columns} columns) with {max_workers} workers")

        # Prepare all work items upfront
        # Table tasks: ("table", table_name, col_names, row_count, metrics, use_cases, joins)
        # Column tasks: ("column", table_name, col, predicates, field_usage, joins, derived_cols)

        # Results storage
        table_descs: dict[str, str] = {}  # table_name -> description
        column_descs: dict[str, list[ColumnDescription]] = {t.name: [None] * len(t.columns) for t in profile.tables}
        column_indices: dict[str, dict[str, int]] = {}  # table_name -> {col_name -> index}

        for table in profile.tables:
            column_indices[table.name] = {col.name: i for i, col in enumerate(table.columns)}

        executor = ThreadPoolExecutor(max_workers=max_workers)
        try:
            futures = {}

            # Submit all table description tasks
            for table in profile.tables:
                table_metrics = derived_metrics.get(table.name) if derived_metrics else None
                table_use_cases = use_cases.get(table.name) if use_cases else None
                table_joins = join_patterns.get(table.name) if join_patterns else None
                col_names = [c.name for c in table.columns]

                future = executor.submit(
                    self._generate_table_description,
                    table.name, col_names, table.row_count, table_metrics, table_use_cases, table_joins
                )
                futures[future] = ("table", table.name)

            # Submit all column description tasks
            for table in profile.tables:
                table_joins = join_patterns.get(table.name) if join_patterns else None
                table_derived_cols = derived_columns.get(table.name) if derived_columns else None

                for col in table.columns:
                    col_predicates = predicate_patterns.get((table.name, col.name)) if predicate_patterns else None
                    col_field_usage = field_usage.get((table.name, col.name)) if field_usage else None

                    # Filter join patterns to those involving this column
                    col_join_patterns = None
                    if table_joins:
                        col_join_patterns = [
                            jp for jp in table_joins
                            if (jp.left_table == table.name and jp.left_column == col.name) or
                               (jp.right_table == table.name and jp.right_column == col.name)
                        ]
                        if not col_join_patterns:
                            col_join_patterns = None

                    future = executor.submit(
                        self._generate_column_description,
                        col, table.name, col_predicates, col_field_usage, col_join_patterns, table_derived_cols
                    )
                    futures[future] = ("column", table.name, col.name, col_predicates, col_field_usage, col_join_patterns, table_derived_cols)

            # Process results as they complete
            completed = 0
            tables_done = 0
            columns_done = 0

            for future in as_completed(futures):
                task_info = futures[future]
                completed += 1

                if task_info[0] == "table":
                    table_name = task_info[1]
                    table_descs[table_name] = future.result()
                    tables_done += 1
                    if verbose:
                        desc = table_descs[table_name]
                        desc_preview = desc[:60] + "..." if len(desc) > 60 else desc
                        progress(f"[{completed}/{total_tasks}] Table {table_name}: \"{desc_preview}\"")
                    else:
                        progress(f"[{completed}/{total_tasks}] Table: {table_name}")

                else:  # column
                    _, table_name, col_name, col_predicates, col_field_usage, col_join_patterns, table_derived_cols = task_info
                    col_desc = future.result()
                    idx = column_indices[table_name][col_name]
                    column_descs[table_name][idx] = col_desc
                    columns_done += 1

                    # Show context indicators
                    context_indicators = []
                    if col_predicates:
                        context_indicators.append("+pred")
                    if col_field_usage:
                        context_indicators.append("+usage")
                    if col_join_patterns:
                        context_indicators.append("+joins")
                    if table_derived_cols:
                        col_lower = col_name.lower()
                        if any(col_lower in dc.expression.lower() for dc in table_derived_cols):
                            context_indicators.append("+derived")
                    indicator_str = " " + "".join(context_indicators) if context_indicators else ""

                    semantic = f" [{col_desc.semantic_type}]" if verbose and col_desc.semantic_type else ""
                    progress(f"[{completed}/{total_tasks}] {table_name}.{col_name}{semantic}{indicator_str}")
        except KeyboardInterrupt:
            progress("Interrupted, cancelling pending tasks...")
            executor.shutdown(wait=False, cancel_futures=True)
            raise
        finally:
            executor.shutdown(wait=True)

        progress(f"Completed: {tables_done} tables, {columns_done} columns")

        # Assemble results in original table order
        tables = []
        for table in profile.tables:
            tables.append(
                TableDescription(
                    table_name=table.name,
                    description=table_descs[table.name],
                    columns=column_descs[table.name],
                )
            )

        return SchemaDescription(db_id=profile.db_id, tables=tables, database=profile.database)

    def save_descriptions(
        self, desc: SchemaDescription, output_dir: str = "output/descriptions"
    ) -> Path:
        """Save descriptions to JSON file."""
        if desc.database:
            filename = f"{desc.database}_{desc.db_id}_descriptions.json"
        else:
            filename = f"{desc.db_id}_descriptions.json"
        return save_json(desc, output_dir, filename)

    @staticmethod
    def load_descriptions(
        schema: str, descriptions_dir: str = "output/descriptions", database: str | None = None
    ) -> SchemaDescription | None:
        """Load cached descriptions from JSON file."""
        if database:
            filename = f"{database}_{schema}_descriptions.json"
        else:
            filename = f"{schema}_descriptions.json"
        return load_json(SchemaDescription, Path(descriptions_dir) / filename)


def format_descriptions_for_prompt(
    desc: SchemaDescription, tables_filter: list[str] | None = None
) -> str:
    """
    Format descriptions for inclusion in prompts.

    Args:
        desc: Schema descriptions
        tables_filter: Optional list of table names to include

    Returns:
        Formatted string with descriptions
    """
    lines = [f"SEMANTIC DESCRIPTIONS FOR {desc.db_id}:"]
    lines.append("=" * 50)

    for table in desc.tables:
        if tables_filter and table.table_name not in tables_filter:
            continue

        lines.append(f"\nTable: {table.table_name}")
        lines.append(f"  Purpose: {table.description}")
        lines.append("  Columns:")

        for col in table.columns:
            semantic = f" [{col.semantic_type}]" if col.semantic_type else ""
            lines.append(f"    - {col.column_name}{semantic}: {col.description}")

    return "\n".join(lines)
