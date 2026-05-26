"""
Facts-only metadata generation.

Extracts compact, factual metadata from profiling stats and query history.
Designed to minimize token cost while providing actionable information for
text-to-SQL generation.

Fact notation (semicolon-separated):
- [val1,val2,...] - categorical values (shows count only when truncated)
- null:N% - null rate (only when >= 5%)
- range:[min,max] - value range for numeric/date columns
- pattern:TYPE - detected pattern (email, uuid, phone, url)
- fk->table.col - confirmed join target (from query history)
- fk?->table.col - speculative join target (from MinHash similarity)
- fk(1:N)->table.col - join with cardinality indicator
- filter:[op1,op2] - predicate operators from query history
- role:TYPE - semantic role (pk, fk, fact, dimension, timestamp)
- agg:[SUM,AVG] - common aggregations from history
- granularity:day - date/time granularity

Table-level notation:
- pk:column - primary key column
- joins:table1,table2 - tables this one joins to

Example: role:fact;[active,pending];fk(N:1)->orders.status_id;agg:[SUM,AVG]
"""

import re

from dataclasses import dataclass, field
from typing import Any

from metadata_generator.config import (
    FACT_TOKEN_BUDGET,
    FACT_ENUM_DISPLAY_VALUES,
    FACT_NULL_THRESHOLD,
    FACT_ORPHAN_DISPLAY_VALUES,
)
from metadata_generator.models import ColumnProfile, TableProfile, SchemaProfile, ColumnSimilarity
from metadata_generator.history import (
    QueryHistoryResult,
    JoinCondition,
    FieldUsage,
    PredicatePattern,
    DerivedMetric,
)


@dataclass
class ColumnFacts:
    """Structured representation of column facts before formatting."""

    table_name: str
    column_name: str
    dtype: str

    # Cardinality facts
    approx_unique: int | None = None
    is_categorical: bool = False
    sample_values: list[str] | None = None
    row_count: int = 0  # Table row count for cardinality calculations

    # Null rate
    null_percentage: float = 0.0

    # Range (for numeric/date columns)
    min_value: str | None = None
    max_value: str | None = None

    # Pattern detection
    detected_pattern: str | None = None

    # Query history derived facts
    join_targets: list[tuple[str, str, int]] = field(default_factory=list)  # (table, col, count)
    filter_patterns: list[tuple[str, int]] = field(default_factory=list)  # (operator, count)
    importance_score: float = 0.0

    # Speculative joins from MinHash similarity (when no history available)
    speculative_joins: list[tuple[str, str, float]] = field(default_factory=list)  # (table, col, similarity)

    # New semantic facts
    semantic_role: str | None = None  # pk, fk, fact, dimension, timestamp
    join_cardinality: str | None = None  # 1:N, N:1, 1:1, N:N
    common_aggregations: list[str] = field(default_factory=list)  # SUM, AVG, COUNT, etc.
    date_granularity: str | None = None  # day, hour, minute, second
    is_primary_key: bool = False

    # Orphaned values (values with no match on the other side of a join)
    orphan_values: list[str] = field(default_factory=list)
    orphan_count: int = 0
    orphan_target: str | None = None  # "table.column" of the join target

    # Usage patterns from query history
    used_in_where: bool = False
    used_in_groupby: bool = False
    used_in_orderby: bool = False

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return {
            "table_name": self.table_name,
            "column_name": self.column_name,
            "dtype": self.dtype,
            "approx_unique": self.approx_unique,
            "is_categorical": self.is_categorical,
            "sample_values": self.sample_values,
            "row_count": self.row_count,
            "null_percentage": self.null_percentage,
            "min_value": self.min_value,
            "max_value": self.max_value,
            "detected_pattern": self.detected_pattern,
            "join_targets": self.join_targets,
            "filter_patterns": self.filter_patterns,
            "importance_score": self.importance_score,
            "speculative_joins": self.speculative_joins,
            "semantic_role": self.semantic_role,
            "join_cardinality": self.join_cardinality,
            "common_aggregations": self.common_aggregations,
            "date_granularity": self.date_granularity,
            "is_primary_key": self.is_primary_key,
            "orphan_values": self.orphan_values,
            "orphan_count": self.orphan_count,
            "orphan_target": self.orphan_target,
            "used_in_where": self.used_in_where,
            "used_in_groupby": self.used_in_groupby,
            "used_in_orderby": self.used_in_orderby,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ColumnFacts":
        """Create from dictionary."""
        return cls(
            table_name=data["table_name"],
            column_name=data["column_name"],
            dtype=data["dtype"],
            approx_unique=data.get("approx_unique"),
            is_categorical=data.get("is_categorical", False),
            sample_values=data.get("sample_values"),
            row_count=data.get("row_count", 0),
            null_percentage=data.get("null_percentage", 0.0),
            min_value=data.get("min_value"),
            max_value=data.get("max_value"),
            detected_pattern=data.get("detected_pattern"),
            join_targets=data.get("join_targets", []),
            filter_patterns=data.get("filter_patterns", []),
            importance_score=data.get("importance_score", 0.0),
            speculative_joins=data.get("speculative_joins", []),
            semantic_role=data.get("semantic_role"),
            join_cardinality=data.get("join_cardinality"),
            common_aggregations=data.get("common_aggregations", []),
            date_granularity=data.get("date_granularity"),
            is_primary_key=data.get("is_primary_key", False),
            orphan_values=data.get("orphan_values", []),
            orphan_count=data.get("orphan_count", 0),
            orphan_target=data.get("orphan_target"),
            used_in_where=data.get("used_in_where", False),
            used_in_groupby=data.get("used_in_groupby", False),
            used_in_orderby=data.get("used_in_orderby", False),
        )


@dataclass
class TableFacts:
    """Facts for a single table."""

    table_name: str
    row_count: int
    columns: list[ColumnFacts] = field(default_factory=list)
    primary_key: str | None = None  # Primary key column name
    joins_to: list[str] = field(default_factory=list)  # Tables this one joins to
    is_view: bool = False  # Whether this is a VIEW (vs BASE TABLE)

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        result = {
            "table_name": self.table_name,
            "row_count": self.row_count,
            "columns": [c.to_dict() for c in self.columns],
            "primary_key": self.primary_key,
            "joins_to": self.joins_to,
        }
        if self.is_view:
            result["is_view"] = True
        return result

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "TableFacts":
        """Create from dictionary."""
        columns = [ColumnFacts.from_dict(c) for c in data.get("columns", [])]
        return cls(
            table_name=data["table_name"],
            row_count=data["row_count"],
            columns=columns,
            primary_key=data.get("primary_key"),
            joins_to=data.get("joins_to", []),
            is_view=data.get("is_view", False),
        )


@dataclass
class SchemaFacts:
    """Facts for an entire schema."""

    db_id: str
    database: str
    tables: list[TableFacts] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return {
            "db_id": self.db_id,
            "database": self.database,
            "tables": [t.to_dict() for t in self.tables],
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "SchemaFacts":
        """Create from dictionary."""
        tables = [TableFacts.from_dict(t) for t in data.get("tables", [])]
        return cls(
            db_id=data["db_id"],
            database=data["database"],
            tables=tables,
        )


def extract_column_facts(
    col: ColumnProfile,
    table_name: str,
    row_count: int = 0,
    history: QueryHistoryResult | None = None,
    column_similarities: list[ColumnSimilarity] | None = None,
    all_tables: list[TableProfile] | None = None,
) -> ColumnFacts:
    """
    Extract facts from a column profile and optional query history.

    Args:
        col: Column profile from SUMMARIZE
        table_name: Name of the table this column belongs to
        row_count: Number of rows in the table (for cardinality calculations)
        history: Optional query history analysis results
        column_similarities: Optional MinHash-detected column similarities from profiler
        all_tables: All tables in schema (for join cardinality calculation)

    Returns:
        ColumnFacts with extracted information
    """
    facts = ColumnFacts(
        table_name=table_name,
        column_name=col.name,
        dtype=col.dtype,
        approx_unique=col.approx_unique,
        is_categorical=col.is_categorical,
        sample_values=col.sample_values,
        row_count=row_count,
        null_percentage=col.null_percentage,
        min_value=col.min_value,
        max_value=col.max_value,
        detected_pattern=col.detected_pattern,
    )

    # Detect if this is a primary key
    facts.is_primary_key = _detect_primary_key(col, row_count)

    # Detect date granularity for timestamp columns
    facts.date_granularity = _detect_date_granularity(col)

    if history:
        # Extract join targets for this column
        facts.join_targets = _extract_join_targets(table_name, col.name, history.joins)

        # Extract filter patterns
        facts.filter_patterns = _extract_filter_patterns(table_name, col.name, history.predicates)

        # Get importance score from field usage
        facts.importance_score = _get_importance_score(table_name, col.name, history.field_usage)

        # Extract common aggregations from derived metrics
        facts.common_aggregations = _extract_aggregations(
            table_name, col.name, history.derived_metrics
        )

        # Extract usage patterns (where, groupby, orderby)
        facts.used_in_where, facts.used_in_groupby, facts.used_in_orderby = (
            _extract_usage_patterns(table_name, col.name, history.field_usage)
        )

        # Calculate join cardinality if we have join targets and all tables
        if facts.join_targets and all_tables:
            facts.join_cardinality = _detect_join_cardinality(
                col, row_count, facts.join_targets[0], all_tables
            )

    # Extract speculative joins from MinHash similarities (when not already in history)
    if column_similarities:
        facts.speculative_joins = _extract_speculative_joins(
            table_name, col.name, column_similarities, facts.join_targets
        )
        # Calculate cardinality for speculative joins if we have all tables
        if facts.speculative_joins and all_tables and not facts.join_cardinality:
            target_table, target_col, _ = facts.speculative_joins[0]
            facts.join_cardinality = _detect_join_cardinality(
                col, row_count, (target_table, target_col, 0), all_tables
            )

    # Extract orphan info from column similarities
    if column_similarities:
        orphan_values, orphan_count, orphan_target = _extract_orphan_info(
            table_name, col.name, column_similarities
        )
        facts.orphan_values = orphan_values
        facts.orphan_count = orphan_count
        facts.orphan_target = orphan_target

    # Detect semantic role AFTER we know about joins
    has_join_target = bool(facts.join_targets or facts.speculative_joins)
    has_confirmed_join = bool(facts.join_targets)
    facts.semantic_role = _detect_semantic_role(
        col, facts.is_primary_key, has_join_target, has_confirmed_join
    )

    return facts


def _detect_primary_key(col: ColumnProfile, row_count: int) -> bool:
    """
    Detect if a column is likely a primary key.

    A column is likely a PK if:
    - It has unique values equal to row count (within 5% tolerance)
    - OR it follows common PK naming patterns
    """
    col_lower = col.name.lower()

    # Check uniqueness: if approx_unique == row_count, it's a candidate
    if col.approx_unique and row_count > 0:
        uniqueness_ratio = col.approx_unique / row_count
        if uniqueness_ratio >= 0.95:  # Allow some tolerance for sampling
            # Only consider columns with PK-like naming patterns
            # (structural convention, not domain-specific)
            if _has_pk_naming(col_lower):
                return True

    return False


def _has_pk_naming(col_lower: str) -> bool:
    """
    Check if a column name follows common primary key naming conventions.

    Uses structural naming patterns only (no domain-specific vocabulary):
    - Exact match: 'id', 'pk', 'key'
    - Suffix: '_id', '_pk', '_key', 'id' (e.g., 'userid')
    - Prefix: 'pk_', 'id_'
    """
    # Exact matches
    if col_lower in ("id", "pk", "key"):
        return True

    # Suffix patterns (e.g., user_id, userid, order_pk, row_key)
    if col_lower.endswith(("_id", "_pk", "_key", "id")):
        return True

    # Prefix patterns (e.g., pk_order, id_user)
    if col_lower.startswith(("pk_", "id_")):
        return True

    return False


def _detect_semantic_role(
    col: ColumnProfile,
    is_primary_key: bool,
    has_join_target: bool = False,
    has_confirmed_join: bool = False,
) -> str | None:
    """
    Detect the semantic role of a column.

    Roles:
    - pk: Primary key (unique identifier for the table)
    - fk: Foreign key (joins to another table)
    - timestamp: Date/time column (used for time-based filtering/grouping)
    - fact: Numeric column that can be aggregated (SUM, AVG)
    - dimension: Categorical column for grouping
    """
    col_lower = col.name.lower()
    dtype_upper = col.dtype.upper()

    # Primary keys
    if is_primary_key:
        return "pk"

    # Foreign keys confirmed by query history always take priority
    if has_confirmed_join:
        return "fk"

    # Foreign key patterns (ends with _id but not primary)
    if col_lower.endswith("_id") or (col_lower.endswith("id") and col_lower != "id"):
        if dtype_upper in ("BIGINT", "INTEGER", "INT"):
            return "fk"

    # Timestamp/date types
    if any(t in dtype_upper for t in ("DATE", "TIME", "TIMESTAMP")):
        return "timestamp"

    # General-purpose measure naming patterns — no domain-specific terms.
    # These are universal indicators of aggregatable numeric columns.
    measure_patterns = (
        "amount", "price", "cost", "total", "sum", "count", "qty",
        "quantity", "value", "revenue", "sales", "profit", "rate",
        "score", "weight", "height", "length", "width", "size",
        "duration", "distance", "percent", "ratio", "average", "avg",
        "num_", "n_",
    )

    # Float/decimal types that aren't IDs
    numeric_types = ("DECIMAL", "DOUBLE", "FLOAT", "REAL", "NUMERIC")
    if any(t in dtype_upper for t in numeric_types):
        return "fact"

    # Integer types: check measure patterns BEFORE categorical/dimension
    if dtype_upper in ("BIGINT", "INTEGER", "INT", "SMALLINT", "TINYINT"):
        # Check measure naming patterns first
        if any(p in col_lower for p in measure_patterns):
            return "fact"

        # Structural heuristic: integer columns with a contiguous range
        # starting at 0 are almost always counts/measures, not dimensions.
        # (e.g., a column with values 0-10 where approx_unique ≈ 11)
        if _is_contiguous_integer_range(col):
            return "fact"

        # Speculative joins (from MinHash) for non-ID integer columns
        # are unreliable — only treat as FK if naming suggests it
        if has_join_target and _has_pk_naming(col_lower):
            return "fk"

        # If categorical and not a measure name, it's a dimension
        if col.is_categorical:
            return "dimension"

    # Categorical columns are dimensions
    if col.is_categorical:
        return "dimension"

    # String columns are typically dimensions
    if "VARCHAR" in dtype_upper or "TEXT" in dtype_upper or "CHAR" in dtype_upper:
        return "dimension"

    return None


def _is_contiguous_integer_range(col: ColumnProfile) -> bool:
    """
    Check if an integer column's values form a contiguous range starting at 0.

    A column with min=0, max=N, and approx_unique close to N+1 is likely a
    count/measure (e.g., values 0-10) rather than a categorical code.

    This is a structural heuristic — no domain-specific knowledge required.
    """
    try:
        min_val = float(col.min_value) if col.min_value is not None else None
        max_val = float(col.max_value) if col.max_value is not None else None
    except (ValueError, TypeError):
        return False

    if min_val is None or max_val is None or col.approx_unique is None:
        return False

    # Must start at 0 with max > 1 (exclude booleans/flags)
    if min_val != 0 or max_val <= 1:
        return False

    # Values should cover a significant portion of the 0..max range
    expected_unique = max_val + 1
    return col.approx_unique >= expected_unique * 0.6


def _detect_date_granularity(col: ColumnProfile) -> str | None:
    """
    Detect the granularity of a date/time column.

    Returns: day, hour, minute, second, or None
    """
    dtype_upper = col.dtype.upper()

    # Only process date/time types
    if not any(t in dtype_upper for t in ("DATE", "TIME", "TIMESTAMP")):
        return None

    # DATE type is day granularity
    if dtype_upper == "DATE":
        return "day"

    # For TIMESTAMP/TIME, check sample values if available
    if col.sample_values:
        # Check if values have time components
        has_seconds = False
        has_minutes = False
        has_hours = False

        for val in col.sample_values[:5]:
            val_str = str(val)
            # Look for time patterns like HH:MM:SS or HH:MM
            time_match = re.search(r"(\d{2}):(\d{2})(?::(\d{2}))?", val_str)
            if time_match:
                hours, minutes, seconds = time_match.groups()
                if hours and hours != "00":
                    has_hours = True
                if minutes and minutes != "00":
                    has_minutes = True
                if seconds and seconds != "00":
                    has_seconds = True

        if has_seconds:
            return "second"
        elif has_minutes:
            return "minute"
        elif has_hours:
            return "hour"
        else:
            # All time components are 00:00:00 — effectively day granularity
            return "day"

    # For TIMESTAMP without samples, check min/max values for midnight pattern
    if "TIMESTAMP" in dtype_upper:
        if col.min_value and col.max_value:
            min_str, max_str = str(col.min_value), str(col.max_value)
            min_match = re.search(r"(\d{2}):(\d{2})(?::(\d{2}))?", min_str)
            max_match = re.search(r"(\d{2}):(\d{2})(?::(\d{2}))?", max_str)
            if min_match and max_match:
                min_parts = min_match.groups()
                max_parts = max_match.groups()
                all_zero = all(
                    (p or "00") == "00"
                    for p in min_parts + max_parts
                )
                if all_zero:
                    return "day"
        return "second"

    return "day"


def _detect_join_cardinality(
    col: ColumnProfile,
    row_count: int,
    join_target: tuple[str, str, int],
    all_tables: list[TableProfile],
) -> str | None:
    """
    Detect the cardinality of a join relationship.

    Returns: 1:1, 1:N, N:1, or N:N
    """
    target_table_name, target_col_name, _ = join_target

    # Find the target table
    target_table = None
    for t in all_tables:
        if t.name.lower() == target_table_name.lower():
            target_table = t
            break

    if not target_table:
        return None

    # Find the target column
    target_col = None
    for c in target_table.columns:
        if c.name.lower() == target_col_name.lower():
            target_col = c
            break

    if not target_col:
        return None

    # Calculate cardinality ratios
    source_unique = col.approx_unique or 0
    target_unique = target_col.approx_unique or 0
    source_rows = row_count
    target_rows = target_table.row_count

    if source_rows == 0 or target_rows == 0:
        return None

    # Determine if each side is "1" or "N"
    # "1" side: unique values ≈ row count (it's the PK side)
    # "N" side: unique values < row count (it's the FK side)

    source_is_unique = source_unique >= source_rows * 0.95 if source_rows > 0 else False
    target_is_unique = target_unique >= target_rows * 0.95 if target_rows > 0 else False

    if source_is_unique and target_is_unique:
        return "1:1"
    elif source_is_unique and not target_is_unique:
        return "1:N"
    elif not source_is_unique and target_is_unique:
        return "N:1"
    else:
        return "N:N"


def _extract_usage_patterns(
    table_name: str,
    column_name: str,
    field_usage: list[FieldUsage],
    min_count: int = 5,
) -> tuple[bool, bool, bool]:
    """
    Extract usage pattern flags from field usage statistics.

    Args:
        table_name: Table name
        column_name: Column name
        field_usage: Field usage statistics from history
        min_count: Minimum count to consider as "used"

    Returns:
        Tuple of (used_in_where, used_in_groupby, used_in_orderby)
    """
    table_lower = table_name.lower()
    col_lower = column_name.lower()

    for usage in field_usage:
        if usage.table.lower() == table_lower and usage.column.lower() == col_lower:
            return (
                usage.where_count >= min_count,
                usage.group_by_count >= min_count,
                usage.order_by_count >= min_count,
            )

    return (False, False, False)


def _extract_aggregations(
    table_name: str,
    column_name: str,
    derived_metrics: list[DerivedMetric],
) -> list[str]:
    """
    Extract common aggregation functions used on this column from query history.

    Returns list of aggregation types like ["SUM", "AVG", "COUNT"]
    """
    col_lower = column_name.lower()
    aggregations: dict[str, int] = {}

    # Common aggregation patterns
    agg_patterns = [
        (r"SUM\s*\(\s*" + re.escape(col_lower) + r"\s*\)", "SUM"),
        (r"AVG\s*\(\s*" + re.escape(col_lower) + r"\s*\)", "AVG"),
        (r"COUNT\s*\(\s*" + re.escape(col_lower) + r"\s*\)", "COUNT"),
        (r"MIN\s*\(\s*" + re.escape(col_lower) + r"\s*\)", "MIN"),
        (r"MAX\s*\(\s*" + re.escape(col_lower) + r"\s*\)", "MAX"),
        # Also check for column in arithmetic expressions
        (r"SUM\s*\([^)]*" + re.escape(col_lower) + r"[^)]*\)", "SUM"),
        (r"AVG\s*\([^)]*" + re.escape(col_lower) + r"[^)]*\)", "AVG"),
    ]

    for metric in derived_metrics:
        expr_lower = metric.expression.lower()
        for pattern, agg_type in agg_patterns:
            if re.search(pattern, expr_lower, re.IGNORECASE):
                aggregations[agg_type] = aggregations.get(agg_type, 0) + metric.occurrence_count

    # Sort by frequency and return
    sorted_aggs = sorted(aggregations.items(), key=lambda x: x[1], reverse=True)
    return [agg for agg, _ in sorted_aggs[:3]]  # Top 3 aggregations


def _extract_join_targets(
    table_name: str,
    column_name: str,
    joins: list[JoinCondition],
) -> list[tuple[str, str, int]]:
    """Extract join targets for a column from query history."""
    targets = []
    table_lower = table_name.lower()
    col_lower = column_name.lower()

    for join in joins:
        # Check if this column is on the left side of the join
        if join.left_table.lower() == table_lower and join.left_column.lower() == col_lower:
            targets.append((join.right_table, join.right_column, join.count))
        # Check if this column is on the right side of the join
        elif join.right_table.lower() == table_lower and join.right_column.lower() == col_lower:
            targets.append((join.left_table, join.left_column, join.count))

    # Sort by frequency descending
    targets.sort(key=lambda x: x[2], reverse=True)
    return targets


def _extract_filter_patterns(
    table_name: str,
    column_name: str,
    predicates: list[PredicatePattern],
) -> list[tuple[str, int]]:
    """Extract filter patterns for a column from query history."""
    patterns: dict[str, int] = {}
    table_lower = table_name.lower()
    col_lower = column_name.lower()

    for pred in predicates:
        if pred.table.lower() == table_lower and pred.column.lower() == col_lower:
            op = pred.operator
            patterns[op] = patterns.get(op, 0) + pred.occurrence_count

    # Convert to list and sort by frequency
    result = [(op, count) for op, count in patterns.items()]
    result.sort(key=lambda x: x[1], reverse=True)
    return result


def _get_importance_score(
    table_name: str,
    column_name: str,
    field_usage: list[FieldUsage],
) -> float:
    """Get importance score for a column from field usage statistics."""
    table_lower = table_name.lower()
    col_lower = column_name.lower()

    for usage in field_usage:
        if usage.table.lower() == table_lower and usage.column.lower() == col_lower:
            return usage.importance_score

    return 0.0


def _extract_speculative_joins(
    table_name: str,
    column_name: str,
    similarities: list[ColumnSimilarity],
    confirmed_joins: list[tuple[str, str, int]],
) -> list[tuple[str, str, float]]:
    """
    Extract speculative join targets from MinHash column similarities.

    Only includes similarities not already confirmed by query history.

    Args:
        table_name: Current table name
        column_name: Current column name
        similarities: MinHash-detected column similarities
        confirmed_joins: Already confirmed joins from query history

    Returns:
        List of (target_table, target_column, similarity_score) tuples
    """
    # Build set of already-confirmed join targets for quick lookup
    confirmed_targets = {
        (tbl.lower(), col.lower()) for tbl, col, _ in confirmed_joins
    }

    speculative = []
    table_lower = table_name.lower()
    col_lower = column_name.lower()

    for sim in similarities:
        # Check if this column is on either side of the similarity
        if sim.source_table.lower() == table_lower and sim.source_column.lower() == col_lower:
            target = (sim.target_table, sim.target_column)
            target_key = (sim.target_table.lower(), sim.target_column.lower())
        elif sim.target_table.lower() == table_lower and sim.target_column.lower() == col_lower:
            target = (sim.source_table, sim.source_column)
            target_key = (sim.source_table.lower(), sim.source_column.lower())
        else:
            continue

        # Skip if already confirmed by query history
        if target_key in confirmed_targets:
            continue

        # Only include high-confidence similarities (foreign_key relationship)
        if sim.likely_relationship == "foreign_key":
            speculative.append((target[0], target[1], sim.jaccard_similarity))

    # Sort by similarity descending
    speculative.sort(key=lambda x: x[2], reverse=True)
    return speculative


def _extract_orphan_info(
    table_name: str,
    column_name: str,
    similarities: list[ColumnSimilarity],
) -> tuple[list[str], int, str | None]:
    """Extract orphan info for a column from the highest-similarity relationship.

    When a column participates in multiple similarity pairs, only the
    highest-similarity pair is used. This keeps the output deterministic
    and avoids cluttering facts with orphan info from weaker matches.

    Returns:
        Tuple of (orphan_values, orphan_count, orphan_target) where orphan_target
        is "table.column" of the join target, or ([], 0, None) if no orphans.
    """
    table_lower = table_name.lower()
    col_lower = column_name.lower()

    best_sim: ColumnSimilarity | None = None
    best_score = -1.0
    is_source_side = True

    for sim in similarities:
        if sim.source_table.lower() == table_lower and sim.source_column.lower() == col_lower:
            if sim.jaccard_similarity > best_score:
                best_sim = sim
                best_score = sim.jaccard_similarity
                is_source_side = True
        elif sim.target_table.lower() == table_lower and sim.target_column.lower() == col_lower:
            if sim.jaccard_similarity > best_score:
                best_sim = sim
                best_score = sim.jaccard_similarity
                is_source_side = False

    if best_sim is None:
        return [], 0, None

    if is_source_side:
        values = best_sim.source_only_values
        count = best_sim.source_only_count
        target = f"{best_sim.target_table}.{best_sim.target_column}"
    else:
        values = best_sim.target_only_values
        count = best_sim.target_only_count
        target = f"{best_sim.source_table}.{best_sim.source_column}"

    if count == 0:
        return [], 0, None

    return values, count, target


def extract_schema_facts(
    profile: SchemaProfile,
    history: QueryHistoryResult | None = None,
) -> SchemaFacts:
    """
    Extract facts for an entire schema.

    Args:
        profile: Schema profile with all tables
        history: Optional query history analysis

    Returns:
        SchemaFacts with facts for all tables and columns
    """
    tables = []
    similarities = profile.column_similarities if profile.column_similarities else None
    all_tables = profile.tables  # For join cardinality calculations

    for table in profile.tables:
        column_facts = [
            extract_column_facts(
                col, table.name, table.row_count, history, similarities, all_tables
            )
            for col in table.columns
        ]

        # Detect primary key from column facts
        primary_key = None
        for cf in column_facts:
            if cf.is_primary_key:
                primary_key = cf.column_name
                break

        # Collect all join targets from columns
        joins_to: set[str] = set()
        for cf in column_facts:
            for target_table, _, _ in cf.join_targets:
                joins_to.add(target_table)
            for target_table, _, _ in cf.speculative_joins:
                joins_to.add(target_table)

        tables.append(TableFacts(
            table_name=table.name,
            row_count=table.row_count,
            columns=column_facts,
            primary_key=primary_key,
            joins_to=sorted(joins_to),
            is_view=table.is_view,
        ))

    return SchemaFacts(
        db_id=profile.db_id,
        database=profile.database,
        tables=tables,
    )


def format_column_facts(
    facts: ColumnFacts,
    token_budget: int = FACT_TOKEN_BUDGET,
) -> str:
    """
    Format column facts into compact notation string.

    Prioritizes facts by value for SQL generation:
    1. High priority (always include if present):
       - Semantic role (id, measure, dimension, timestamp)
       - Categorical values (enum) when card <= 10
       - Join targets with cardinality (fk)
       - Common aggregations

    2. Medium priority (include if space permits):
       - Null rate when > 5%
       - Range for numeric/date columns
       - Date granularity
       - Filter patterns from history
       - Pattern type (email, uuid, etc.)

    3. Low priority (omit for token savings):
       - High cardinality count

    Args:
        facts: ColumnFacts to format
        token_budget: Approximate token limit (~4 chars per token)

    Returns:
        Compact fact string like "role:fact;fk(N:1)->customers.id;agg:[SUM,AVG]" or empty string if no facts
    """
    parts: list[str] = []
    char_budget = token_budget * 4  # Rough estimate: 4 chars per token

    # HIGH PRIORITY FACTS

    # Semantic role (critical for understanding column purpose)
    if facts.semantic_role:
        parts.append(f"role:{facts.semantic_role}")

    # Categorical values (most valuable for filter generation)
    if facts.is_categorical and facts.sample_values:
        enum_str = _format_enum(facts.approx_unique or 0, facts.sample_values)
        parts.append(enum_str)
    # Skip high cardinality counts - doesn't help SQL generation

    # Join targets with cardinality (critical for multi-table queries)
    if facts.join_targets:
        # Include top confirmed join target with cardinality
        target_table, target_col, _ = facts.join_targets[0]
        if facts.join_cardinality:
            fk_str = f"fk({facts.join_cardinality})->{target_table}.{target_col}"
        else:
            fk_str = f"fk->{target_table}.{target_col}"
        parts.append(fk_str)
    elif facts.speculative_joins:
        # Fallback to speculative join from MinHash similarity
        target_table, target_col, _ = facts.speculative_joins[0]
        if facts.join_cardinality:
            fk_str = f"fk?({facts.join_cardinality})->{target_table}.{target_col}"
        else:
            fk_str = f"fk?->{target_table}.{target_col}"
        parts.append(fk_str)

    # Common aggregations (helps model know how to aggregate)
    if facts.common_aggregations:
        agg_str = f"agg:[{','.join(facts.common_aggregations)}]"
        parts.append(agg_str)

    # Check budget before adding medium priority facts
    current_len = sum(len(p) for p in parts) + len(parts)  # ";" separators

    # MEDIUM PRIORITY FACTS

    # Orphaned values (helps identify absence patterns in joins)
    if facts.orphan_count > 0 and facts.orphan_target:
        display_vals = facts.orphan_values[:FACT_ORPHAN_DISPLAY_VALUES]
        if display_vals:
            orphan_str = f"orphans({facts.orphan_count}):[{','.join(display_vals)}]->{facts.orphan_target}"
        else:
            orphan_str = f"orphans({facts.orphan_count})->{facts.orphan_target}"
        if current_len + len(orphan_str) + 1 < char_budget:
            parts.append(orphan_str)
            current_len += len(orphan_str) + 1

    # Null rate (affects JOIN decisions)
    if facts.null_percentage >= FACT_NULL_THRESHOLD:
        null_str = f"null:{facts.null_percentage:.0f}%"
        if current_len + len(null_str) + 1 < char_budget:
            parts.append(null_str)
            current_len += len(null_str) + 1

    # Range for numeric/date columns
    if facts.min_value is not None and facts.max_value is not None:
        # Only add range for non-categorical columns
        if not facts.is_categorical:
            range_str = _format_range(facts.min_value, facts.max_value)
            if current_len + len(range_str) + 1 < char_budget:
                parts.append(range_str)
                current_len += len(range_str) + 1

    # Date granularity for timestamp columns
    if facts.date_granularity:
        gran_str = f"granularity:{facts.date_granularity}"
        if current_len + len(gran_str) + 1 < char_budget:
            parts.append(gran_str)
            current_len += len(gran_str) + 1

    # Filter patterns from history (without counts - saves tokens)
    if facts.filter_patterns:
        ops = ",".join(op for op, _ in facts.filter_patterns[:3])
        filter_str = f"filter:[{ops}]"
        if current_len + len(filter_str) + 1 < char_budget:
            parts.append(filter_str)
            current_len += len(filter_str) + 1

    # Usage indicators (where, groupby, orderby)
    usage_parts = []
    if facts.used_in_where:
        usage_parts.append("where")
    if facts.used_in_groupby:
        usage_parts.append("groupby")
    if facts.used_in_orderby:
        usage_parts.append("orderby")
    if usage_parts:
        usage_str = f"used:[{','.join(usage_parts)}]"
        if current_len + len(usage_str) + 1 < char_budget:
            parts.append(usage_str)
            current_len += len(usage_str) + 1

    # Detected pattern (email, uuid, etc.)
    if facts.detected_pattern:
        pattern_str = f"pattern:{facts.detected_pattern}"
        if current_len + len(pattern_str) + 1 < char_budget:
            parts.append(pattern_str)

    return ";".join(parts) if parts else ""


def _format_enum(count: int, values: list[str]) -> str:
    """Format categorical values as enum notation.

    Only shows count when truncating values.
    """
    if not values:
        return f"enum({count})"

    display_values = values[:FACT_ENUM_DISPLAY_VALUES]
    values_str = ",".join(display_values)

    # Only show count when we're truncating
    if len(values) > FACT_ENUM_DISPLAY_VALUES or count > len(values):
        return f"enum({count}):[{values_str},...]"
    else:
        return f"[{values_str}]"


def _format_range(min_val: str, max_val: str) -> str:
    """Format value range, truncating long values."""
    # Truncate long string values
    max_len = 15
    min_str = min_val[:max_len] + "..." if len(min_val) > max_len else min_val
    max_str = max_val[:max_len] + "..." if len(max_val) > max_len else max_val
    return f"range:[{min_str},{max_str}]"


def format_table_facts(table_facts: TableFacts) -> str:
    """Format table-level facts summary."""
    parts = [f"{table_facts.row_count:,} rows"]

    if table_facts.primary_key:
        parts.append(f"pk:{table_facts.primary_key}")

    if table_facts.joins_to:
        joins_str = ",".join(table_facts.joins_to)
        parts.append(f"joins:{joins_str}")

    return "; ".join(parts)
