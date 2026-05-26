"""
Query History Analysis for MotherDuck

Analyzes query history to discover:
- Join patterns used in practice
- Common query patterns for a schema
- Undocumented relationships between tables

Requires MotherDuck Business plan with organization admin access.
"""

import logging
import os
import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta
import json
from pathlib import Path

import duckdb

from metadata_generator.config import (
    MAX_JOINS_IN_PROMPT,
    MAX_FIELD_USAGE_IN_PROMPT,
    MAX_PREDICATES_IN_PROMPT,
    MAX_METRICS_IN_PROMPT,
    MAX_QUERY_SAMPLES,
    MAX_QUERY_SAMPLE_LENGTH,
    MAX_PREDICATE_EXAMPLES,
    MAX_METRIC_ALIASES,
    PROGRESS_UPDATE_INTERVAL,
    MIN_OCCURRENCE_PERCENT,
    MIN_OCCURRENCE_ABSOLUTE,
    MIN_FIELD_IMPORTANCE_SCORE,
)
from metadata_generator.connection import MotherDuckConnection
from metadata_generator.persistence import save_json, load_json
from metadata_generator.progress import ProgressCallback, ProgressReporter

logger = logging.getLogger(__name__)

try:
    import sqlglot
    from sqlglot import exp
    SQLGLOT_AVAILABLE = True
except ImportError:
    SQLGLOT_AVAILABLE = False


@dataclass
class JoinCondition:
    """Represents a discovered join condition."""
    left_table: str
    left_column: str
    right_table: str
    right_column: str
    count: int = 1

    def __hash__(self):
        # Normalize so A.x = B.y is same as B.y = A.x
        pair = tuple(sorted([
            (self.left_table.lower(), self.left_column.lower()),
            (self.right_table.lower(), self.right_column.lower())
        ]))
        return hash(pair)

    def __eq__(self, other):
        if not isinstance(other, JoinCondition):
            return False
        self_pair = tuple(sorted([
            (self.left_table.lower(), self.left_column.lower()),
            (self.right_table.lower(), self.right_column.lower())
        ]))
        other_pair = tuple(sorted([
            (other.left_table.lower(), other.left_column.lower()),
            (other.right_table.lower(), other.right_column.lower())
        ]))
        return self_pair == other_pair

    def to_dict(self) -> dict:
        return {
            "left_table": self.left_table,
            "left_column": self.left_column,
            "right_table": self.right_table,
            "right_column": self.right_column,
            "count": self.count,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "JoinCondition":
        return cls(**d)


@dataclass
class FieldUsage:
    """Usage statistics for a single field across query history."""

    table: str
    column: str
    select_count: int = 0  # Times used in SELECT
    where_count: int = 0  # Times used in WHERE
    join_count: int = 0  # Times used in JOIN conditions
    group_by_count: int = 0  # Times used in GROUP BY
    order_by_count: int = 0  # Times used in ORDER BY
    total_count: int = 0  # Total references

    @property
    def importance_score(self) -> float:
        """Weighted importance score based on usage context."""
        return (
            self.select_count * 1.0
            + self.where_count * 2.0  # WHERE usage is high signal
            + self.join_count * 3.0  # JOIN usage indicates key field
            + self.group_by_count * 2.0
            + self.order_by_count * 1.0
        )

    def to_dict(self) -> dict:
        return {
            "table": self.table,
            "column": self.column,
            "select_count": self.select_count,
            "where_count": self.where_count,
            "join_count": self.join_count,
            "group_by_count": self.group_by_count,
            "order_by_count": self.order_by_count,
            "total_count": self.total_count,
            "importance_score": self.importance_score,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "FieldUsage":
        # Exclude importance_score as it's computed
        return cls(
            table=d["table"],
            column=d["column"],
            select_count=d.get("select_count", 0),
            where_count=d.get("where_count", 0),
            join_count=d.get("join_count", 0),
            group_by_count=d.get("group_by_count", 0),
            order_by_count=d.get("order_by_count", 0),
            total_count=d.get("total_count", 0),
        )


@dataclass
class PredicatePattern:
    """A commonly used filter condition from query history."""

    table: str
    column: str
    operator: str  # '=', '>', '<', 'IN', 'IS NULL', 'LIKE', 'BETWEEN', etc.
    value_pattern: str  # Anonymized pattern, e.g., "'active'", "<number>", "CURRENT_DATE"
    occurrence_count: int = 1
    example_values: list[str] = field(default_factory=list)

    def __hash__(self):
        return hash((self.table.lower(), self.column.lower(), self.operator, self.value_pattern))

    def __eq__(self, other):
        if not isinstance(other, PredicatePattern):
            return False
        return (self.table.lower(), self.column.lower(), self.operator, self.value_pattern) == \
               (other.table.lower(), other.column.lower(), other.operator, other.value_pattern)

    def to_dict(self) -> dict:
        return {
            "table": self.table,
            "column": self.column,
            "operator": self.operator,
            "value_pattern": self.value_pattern,
            "occurrence_count": self.occurrence_count,
            "example_values": self.example_values,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "PredicatePattern":
        return cls(
            table=d["table"],
            column=d["column"],
            operator=d["operator"],
            value_pattern=d["value_pattern"],
            occurrence_count=d.get("occurrence_count", 1),
            example_values=d.get("example_values", []),
        )


@dataclass
class DerivedMetric:
    """A commonly computed expression from query history."""

    expression: str  # e.g., "SUM(quantity * price)"
    alias_names: list[str] = field(default_factory=list)  # Common aliases
    occurrence_count: int = 1
    tables_involved: list[str] = field(default_factory=list)

    def __hash__(self):
        return hash(self.expression.lower())

    def __eq__(self, other):
        if not isinstance(other, DerivedMetric):
            return False
        return self.expression.lower() == other.expression.lower()

    def to_dict(self) -> dict:
        return {
            "expression": self.expression,
            "alias_names": self.alias_names,
            "occurrence_count": self.occurrence_count,
            "tables_involved": self.tables_involved,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "DerivedMetric":
        return cls(
            expression=d["expression"],
            alias_names=d.get("alias_names", []),
            occurrence_count=d.get("occurrence_count", 1),
            tables_involved=d.get("tables_involved", []),
        )


@dataclass
class IntraTableConstraint:
    """A constraint between columns in the same table discovered from query history.

    Examples: end_date > start_date, total = quantity * price
    """

    table: str
    left_column: str
    operator: str  # '>', '<', '>=', '<=', '=', '!='
    right_column: str
    occurrence_count: int = 1
    example_expression: str = ""

    def __hash__(self):
        # Normalize ordering for commutative operators
        if self.operator in ('=', '!='):
            cols = tuple(sorted([self.left_column.lower(), self.right_column.lower()]))
            return hash((self.table.lower(), cols, self.operator))
        return hash((self.table.lower(), self.left_column.lower(), self.operator, self.right_column.lower()))

    def __eq__(self, other):
        if not isinstance(other, IntraTableConstraint):
            return False
        if self.operator in ('=', '!='):
            self_cols = tuple(sorted([self.left_column.lower(), self.right_column.lower()]))
            other_cols = tuple(sorted([other.left_column.lower(), other.right_column.lower()]))
            return (self.table.lower(), self_cols, self.operator) == \
                   (other.table.lower(), other_cols, other.operator)
        return (self.table.lower(), self.left_column.lower(), self.operator, self.right_column.lower()) == \
               (other.table.lower(), other.left_column.lower(), other.operator, other.right_column.lower())

    def to_dict(self) -> dict:
        return {
            "table": self.table,
            "left_column": self.left_column,
            "operator": self.operator,
            "right_column": self.right_column,
            "occurrence_count": self.occurrence_count,
            "example_expression": self.example_expression,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "IntraTableConstraint":
        return cls(
            table=d["table"],
            left_column=d["left_column"],
            operator=d["operator"],
            right_column=d["right_column"],
            occurrence_count=d.get("occurrence_count", 1),
            example_expression=d.get("example_expression", ""),
        )


@dataclass
class CTEPattern:
    """A Common Table Expression pattern discovered from query history.

    Captures reusable query fragments that appear in WITH clauses.
    """

    cte_name: str  # The alias used for the CTE
    definition_pattern: str  # Simplified/normalized CTE definition
    tables_referenced: list[str] = field(default_factory=list)
    has_aggregation: bool = False  # Whether it contains GROUP BY or aggregates
    occurrence_count: int = 1

    def __hash__(self):
        # Hash by normalized definition pattern
        return hash(self.definition_pattern.lower())

    def __eq__(self, other):
        if not isinstance(other, CTEPattern):
            return False
        return self.definition_pattern.lower() == other.definition_pattern.lower()

    def to_dict(self) -> dict:
        return {
            "cte_name": self.cte_name,
            "definition_pattern": self.definition_pattern,
            "tables_referenced": self.tables_referenced,
            "has_aggregation": self.has_aggregation,
            "occurrence_count": self.occurrence_count,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "CTEPattern":
        return cls(
            cte_name=d["cte_name"],
            definition_pattern=d["definition_pattern"],
            tables_referenced=d.get("tables_referenced", []),
            has_aggregation=d.get("has_aggregation", False),
            occurrence_count=d.get("occurrence_count", 1),
        )


@dataclass
class DerivedColumnDefinition:
    """A computed column definition discovered from query history.

    Maps alias names to their source expressions, enabling field resolution.
    Example: revenue -> SUM(unit_price * quantity * (1 - discount))
    """

    alias: str  # The column alias (e.g., "revenue", "total_orders")
    expression: str  # The source expression
    tables_involved: list[str] = field(default_factory=list)
    occurrence_count: int = 1
    common_contexts: list[str] = field(default_factory=list)  # e.g., ["SELECT", "CTE"]

    def __hash__(self):
        return hash((self.alias.lower(), self.expression.lower()))

    def __eq__(self, other):
        if not isinstance(other, DerivedColumnDefinition):
            return False
        return (self.alias.lower(), self.expression.lower()) == \
               (other.alias.lower(), other.expression.lower())

    def to_dict(self) -> dict:
        return {
            "alias": self.alias,
            "expression": self.expression,
            "tables_involved": self.tables_involved,
            "occurrence_count": self.occurrence_count,
            "common_contexts": self.common_contexts,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "DerivedColumnDefinition":
        return cls(
            alias=d["alias"],
            expression=d["expression"],
            tables_involved=d.get("tables_involved", []),
            occurrence_count=d.get("occurrence_count", 1),
            common_contexts=d.get("common_contexts", []),
        )


@dataclass
class QueryHistoryResult:
    """Result from query history analysis."""

    schema: str
    queries_analyzed: int
    joins: list[JoinCondition] = field(default_factory=list)
    field_usage: list[FieldUsage] = field(default_factory=list)
    predicates: list[PredicatePattern] = field(default_factory=list)
    derived_metrics: list[DerivedMetric] = field(default_factory=list)
    intra_constraints: list[IntraTableConstraint] = field(default_factory=list)
    cte_patterns: list[CTEPattern] = field(default_factory=list)
    derived_columns: list[DerivedColumnDefinition] = field(default_factory=list)
    query_samples: list[str] = field(default_factory=list)
    error: str | None = None
    database: str | None = None  # MotherDuck database name

    def to_dict(self) -> dict:
        result = {
            "schema": self.schema,
            "queries_analyzed": self.queries_analyzed,
            "joins": [j.to_dict() for j in self.joins],
            "field_usage": [f.to_dict() for f in self.field_usage],
            "predicates": [p.to_dict() for p in self.predicates],
            "derived_metrics": [m.to_dict() for m in self.derived_metrics],
            "intra_constraints": [c.to_dict() for c in self.intra_constraints],
            "cte_patterns": [c.to_dict() for c in self.cte_patterns],
            "derived_columns": [d.to_dict() for d in self.derived_columns],
            "query_samples": self.query_samples,
            "error": self.error,
        }
        if self.database:
            result["database"] = self.database
        return result

    @classmethod
    def from_dict(cls, d: dict) -> "QueryHistoryResult":
        joins = [JoinCondition.from_dict(j) for j in d.get("joins", [])]
        field_usage = [FieldUsage.from_dict(f) for f in d.get("field_usage", [])]
        predicates = [PredicatePattern.from_dict(p) for p in d.get("predicates", [])]
        derived_metrics = [DerivedMetric.from_dict(m) for m in d.get("derived_metrics", [])]
        intra_constraints = [IntraTableConstraint.from_dict(c) for c in d.get("intra_constraints", [])]
        cte_patterns = [CTEPattern.from_dict(c) for c in d.get("cte_patterns", [])]
        derived_columns = [DerivedColumnDefinition.from_dict(d) for d in d.get("derived_columns", [])]
        return cls(
            schema=d["schema"],
            queries_analyzed=d["queries_analyzed"],
            joins=joins,
            field_usage=field_usage,
            predicates=predicates,
            derived_metrics=derived_metrics,
            intra_constraints=intra_constraints,
            cte_patterns=cte_patterns,
            derived_columns=derived_columns,
            query_samples=d.get("query_samples", []),
            error=d.get("error"),
            database=d.get("database"),
        )


@dataclass
class _ExtractedPatterns:
    """Internal container for patterns extracted during query analysis."""

    join_counts: dict  # JoinCondition -> count
    field_counts: dict  # (table, column) -> {context -> count}
    predicate_counts: dict  # PredicatePattern -> (count, examples)
    metric_counts: dict  # expression -> (count, aliases, tables)
    intra_constraint_counts: dict  # IntraTableConstraint -> count
    cte_counts: dict  # CTEPattern -> count
    derived_column_counts: dict  # (alias, expression) -> (count, tables, contexts)
    query_candidates: dict  # normalized_query -> (original_query, tables, count)
    queries_with_joins: int = 0


def extract_joins_from_sql(sql: str) -> list[JoinCondition]:
    """
    Extract join conditions from a SQL query.

    Handles:
    - Explicit JOINs: ... JOIN table ON t1.col = t2.col
    - Implicit joins in WHERE: WHERE t1.col = t2.col

    Excludes joins involving CTE-defined tables (WITH clauses).

    Args:
        sql: SQL query string

    Returns:
        List of JoinCondition objects
    """
    if not SQLGLOT_AVAILABLE:
        return []

    joins = []

    try:
        # Parse the SQL (try DuckDB dialect)
        tree = sqlglot.parse_one(sql, dialect="duckdb")

        # Collect CTE names to exclude from joins
        cte_names = set()
        for cte in tree.find_all(exp.CTE):
            if cte.alias:
                cte_names.add(cte.alias.lower())

        # Build alias map: alias -> actual table name
        alias_map = {}
        for table in tree.find_all(exp.Table):
            table_name = table.name
            alias = table.alias if table.alias else table_name
            alias_map[alias.lower()] = table_name

        # Find all equality comparisons that look like joins
        for eq in tree.find_all(exp.EQ):
            left = eq.left
            right = eq.right

            # Check if both sides are column references
            if isinstance(left, exp.Column) and isinstance(right, exp.Column):
                left_table = left.table or ""
                left_col = left.name
                right_table = right.table or ""
                right_col = right.name

                # Resolve aliases to actual table names
                left_table = alias_map.get(left_table.lower(), left_table)
                right_table = alias_map.get(right_table.lower(), right_table)

                # Skip joins involving CTE-defined tables
                if left_table.lower() in cte_names or right_table.lower() in cte_names:
                    continue

                # Only count as join if both have table qualifiers and are different tables
                if left_table and right_table and left_table.lower() != right_table.lower():
                    joins.append(JoinCondition(
                        left_table=left_table,
                        left_column=left_col,
                        right_table=right_table,
                        right_column=right_col,
                    ))

    except sqlglot.errors.ParseError as e:
        logger.debug(f"Failed to parse SQL for join extraction: {e}")
    except Exception as e:
        logger.warning(f"Unexpected error extracting joins from SQL: {e}")

    return joins


def extract_field_usage_from_sql(sql: str) -> list[tuple[str, str, str]]:
    """
    Extract field references from a SQL query with their usage context.

    Args:
        sql: SQL query string

    Returns:
        List of (table, column, context) tuples where context is one of:
        'select', 'where', 'join', 'group_by', 'order_by'
    """
    if not SQLGLOT_AVAILABLE:
        return []

    usage = []

    try:
        tree = sqlglot.parse_one(sql, dialect="duckdb")

        # Build alias map: alias -> actual table name
        alias_map = {}
        for table in tree.find_all(exp.Table):
            table_name = table.name
            alias = table.alias if table.alias else table_name
            alias_map[alias.lower()] = table_name

        def resolve_table(col: exp.Column) -> str:
            """Resolve column's table name using alias map."""
            table = col.table or ""
            return alias_map.get(table.lower(), table)

        def extract_columns(node, context: str):
            """Extract all column references from a node."""
            for col in node.find_all(exp.Column):
                table = resolve_table(col)
                if table:  # Only include qualified columns
                    usage.append((table, col.name, context))

        # Extract from SELECT expressions
        for select in tree.find_all(exp.Select):
            for expr in select.expressions:
                # Don't recurse into subqueries
                if not isinstance(expr, exp.Subquery):
                    for col in expr.find_all(exp.Column):
                        table = resolve_table(col)
                        if table:
                            usage.append((table, col.name, "select"))

        # Extract from WHERE clauses
        for where in tree.find_all(exp.Where):
            extract_columns(where, "where")

        # Extract from JOIN conditions (ON clauses)
        for join in tree.find_all(exp.Join):
            if join.args.get("on"):
                extract_columns(join.args["on"], "join")

        # Extract from GROUP BY
        for group in tree.find_all(exp.Group):
            extract_columns(group, "group_by")

        # Extract from ORDER BY
        for order in tree.find_all(exp.Order):
            extract_columns(order, "order_by")

    except sqlglot.errors.ParseError as e:
        logger.debug(f"Failed to parse SQL for field usage: {e}")
    except Exception as e:
        logger.warning(f"Unexpected error extracting field usage from SQL: {e}")

    return usage


def _anonymize_value(expr) -> str:
    """Convert a literal value to an anonymized pattern."""
    if isinstance(expr, exp.Literal):
        if expr.is_string:
            val = expr.this
            # Keep short enum-like values, anonymize longer strings
            if len(val) <= 20:
                return f"'{val}'"
            return "'<string>'"
        return "<number>"
    if isinstance(expr, exp.Boolean):
        return str(expr.this).upper()
    if isinstance(expr, exp.Null):
        return "NULL"
    if isinstance(expr, exp.CurrentDate):
        return "CURRENT_DATE"
    if isinstance(expr, exp.CurrentTimestamp):
        return "CURRENT_TIMESTAMP"
    # For expressions (like CURRENT_DATE - INTERVAL), return the SQL
    try:
        sql = expr.sql(dialect="duckdb")
        if len(sql) <= 50:
            return sql
        return "<expression>"
    except Exception as e:
        logger.debug(f"Could not convert expression to SQL: {e}")
        return "<expression>"


def extract_predicates_from_sql(sql: str) -> list[tuple[str, str, str, str, str]]:
    """
    Extract WHERE/HAVING predicates from a SQL query.

    Args:
        sql: SQL query string

    Returns:
        List of (table, column, operator, value_pattern, raw_value) tuples
    """
    if not SQLGLOT_AVAILABLE:
        return []

    predicates = []

    try:
        tree = sqlglot.parse_one(sql, dialect="duckdb")

        # Build alias map
        alias_map = {}
        for table in tree.find_all(exp.Table):
            table_name = table.name
            alias = table.alias if table.alias else table_name
            alias_map[alias.lower()] = table_name

        def resolve_table(col: exp.Column) -> str:
            table = col.table or ""
            return alias_map.get(table.lower(), table)

        def extract_from_predicate(node):
            """Extract predicate info from a comparison node."""
            # Handle different comparison types
            comparisons = [
                (exp.EQ, "="),
                (exp.NEQ, "!="),
                (exp.GT, ">"),
                (exp.GTE, ">="),
                (exp.LT, "<"),
                (exp.LTE, "<="),
                (exp.Like, "LIKE"),
                (exp.ILike, "ILIKE"),
                (exp.In, "IN"),
                (exp.Between, "BETWEEN"),
            ]

            for comp_type, op in comparisons:
                for comp in node.find_all(comp_type):
                    left = comp.this
                    if isinstance(left, exp.Column):
                        table = resolve_table(left)
                        if table:
                            # Get the value/pattern
                            if hasattr(comp, "expression"):
                                right = comp.expression
                            elif hasattr(comp, "expressions"):
                                # IN clause
                                right = comp.expressions[0] if comp.expressions else None
                            else:
                                right = None

                            if right:
                                pattern = _anonymize_value(right)
                                try:
                                    raw = right.sql(dialect="duckdb")[:50]
                                except Exception as e:
                                    logger.debug(f"Could not convert predicate value to SQL: {e}")
                                    raw = str(right)[:50]
                                predicates.append((table, left.name, op, pattern, raw))

            # Handle IS NULL / IS NOT NULL
            for is_node in node.find_all(exp.Is):
                left = is_node.this
                if isinstance(left, exp.Column):
                    table = resolve_table(left)
                    if table:
                        if isinstance(is_node.expression, exp.Null):
                            op = "IS NOT NULL" if is_node.args.get("not") else "IS NULL"
                            predicates.append((table, left.name, op, "NULL", "NULL"))

        # Extract from WHERE
        for where in tree.find_all(exp.Where):
            extract_from_predicate(where)

        # Extract from HAVING
        for having in tree.find_all(exp.Having):
            extract_from_predicate(having)

    except sqlglot.errors.ParseError as e:
        logger.debug(f"Failed to parse SQL for predicates: {e}")
    except Exception as e:
        logger.warning(f"Unexpected error extracting predicates from SQL: {e}")

    return predicates


def extract_derived_metrics_from_sql(sql: str) -> list[tuple[str, str | None, list[str]]]:
    """
    Extract derived metrics (aggregations, calculations) from SELECT.

    Args:
        sql: SQL query string

    Returns:
        List of (expression, alias, tables_involved) tuples
    """
    if not SQLGLOT_AVAILABLE:
        return []

    metrics = []

    try:
        tree = sqlglot.parse_one(sql, dialect="duckdb")

        # Build alias map
        alias_map = {}
        for table in tree.find_all(exp.Table):
            table_name = table.name
            alias = table.alias if table.alias else table_name
            alias_map[alias.lower()] = table_name

        def get_tables_from_expr(expr) -> list[str]:
            """Extract table names from an expression."""
            tables = set()
            for col in expr.find_all(exp.Column):
                table = col.table or ""
                resolved = alias_map.get(table.lower(), table)
                if resolved:
                    tables.add(resolved)
            return list(tables)

        def has_aggregation_or_arithmetic(expr) -> bool:
            """Check if expression has aggregation or arithmetic."""
            agg_types = (exp.Sum, exp.Avg, exp.Count, exp.Min, exp.Max, exp.Stddev, exp.Variance)
            arith_types = (exp.Add, exp.Sub, exp.Mul, exp.Div)
            return (
                any(expr.find_all(t) for t in agg_types)
                or any(expr.find_all(t) for t in arith_types)
            )

        # Extract from SELECT
        for select in tree.find_all(exp.Select):
            for expr in select.expressions:
                # Skip simple column references and subqueries
                if isinstance(expr, (exp.Column, exp.Subquery)):
                    continue

                # Check if this is a derived metric
                inner = expr.this if isinstance(expr, exp.Alias) else expr
                if has_aggregation_or_arithmetic(inner):
                    try:
                        expr_sql = inner.sql(dialect="duckdb")
                        if len(expr_sql) <= 100:  # Skip overly complex expressions
                            alias = expr.alias if isinstance(expr, exp.Alias) else None
                            tables = get_tables_from_expr(inner)
                            metrics.append((expr_sql, alias, tables))
                    except Exception as e:
                        logger.debug(f"Could not convert metric expression to SQL: {e}")

    except sqlglot.errors.ParseError as e:
        logger.debug(f"Failed to parse SQL for derived metrics: {e}")
    except Exception as e:
        logger.warning(f"Unexpected error extracting derived metrics from SQL: {e}")

    return metrics


def extract_intra_constraints_from_sql(sql: str) -> list[tuple[str, str, str, str, str]]:
    """
    Extract constraints between columns in the same table.

    Examples: end_date > start_date, total = quantity * price

    Args:
        sql: SQL query string

    Returns:
        List of (table, left_column, operator, right_column, expression) tuples
    """
    if not SQLGLOT_AVAILABLE:
        return []

    constraints = []

    try:
        tree = sqlglot.parse_one(sql, dialect="duckdb")

        # Build alias map
        alias_map = {}
        for table in tree.find_all(exp.Table):
            table_name = table.name
            alias = table.alias if table.alias else table_name
            alias_map[alias.lower()] = table_name

        def resolve_table(col: exp.Column) -> str:
            table = col.table or ""
            return alias_map.get(table.lower(), table)

        # Map operator expression types to string operators
        op_types = [
            (exp.EQ, "="),
            (exp.NEQ, "!="),
            (exp.GT, ">"),
            (exp.GTE, ">="),
            (exp.LT, "<"),
            (exp.LTE, "<="),
        ]

        for op_type, op_str in op_types:
            for comp in tree.find_all(op_type):
                left = comp.this
                right = comp.expression if hasattr(comp, "expression") else None

                # Both sides must be columns
                if not (isinstance(left, exp.Column) and isinstance(right, exp.Column)):
                    continue

                left_table = resolve_table(left)
                right_table = resolve_table(right)

                # Must be from the same table (or both unqualified)
                if left_table and right_table and left_table.lower() != right_table.lower():
                    continue  # Different tables - this is a join, not intra-constraint

                table = left_table or right_table
                if not table:
                    continue

                try:
                    expr_sql = comp.sql(dialect="duckdb")
                    constraints.append((table, left.name, op_str, right.name, expr_sql))
                except Exception:
                    constraints.append((table, left.name, op_str, right.name, ""))

    except sqlglot.errors.ParseError as e:
        logger.debug(f"Failed to parse SQL for intra-constraints: {e}")
    except Exception as e:
        logger.warning(f"Unexpected error extracting intra-constraints from SQL: {e}")

    return constraints


def extract_ctes_from_sql(sql: str) -> list[tuple[str, str, list[str], bool]]:
    """
    Extract Common Table Expression (CTE) patterns from a SQL query.

    Args:
        sql: SQL query string

    Returns:
        List of (cte_name, definition_pattern, tables_referenced, has_aggregation) tuples
    """
    if not SQLGLOT_AVAILABLE:
        return []

    ctes = []

    try:
        tree = sqlglot.parse_one(sql, dialect="duckdb")

        for cte in tree.find_all(exp.CTE):
            cte_name = cte.alias if cte.alias else ""
            if not cte_name:
                continue

            # Get the CTE definition (the subquery)
            cte_query = cte.this
            if not cte_query:
                continue

            # Extract tables referenced in the CTE
            tables = set()
            for table in cte_query.find_all(exp.Table):
                tables.add(table.name)

            # Check if CTE has aggregation (GROUP BY or aggregate functions)
            has_aggregation = False
            if cte_query.find(exp.Group):
                has_aggregation = True
            else:
                agg_types = (exp.Sum, exp.Avg, exp.Count, exp.Min, exp.Max)
                for agg_type in agg_types:
                    if cte_query.find(agg_type):
                        has_aggregation = True
                        break

            # Generate a normalized pattern (simplified SQL)
            try:
                definition = cte_query.sql(dialect="duckdb")
                # Truncate very long definitions
                if len(definition) > 500:
                    definition = definition[:500] + "..."
            except Exception:
                definition = ""

            if definition:
                ctes.append((cte_name, definition, sorted(tables), has_aggregation))

    except sqlglot.errors.ParseError as e:
        logger.debug(f"Failed to parse SQL for CTE extraction: {e}")
    except Exception as e:
        logger.warning(f"Unexpected error extracting CTEs from SQL: {e}")

    return ctes


def extract_derived_columns_from_sql(sql: str) -> list[tuple[str, str, list[str], str]]:
    """
    Extract derived column definitions (alias -> expression mappings) from SQL.

    This enables field resolution by tracking what computed columns mean.

    Args:
        sql: SQL query string

    Returns:
        List of (alias, expression, tables_involved, context) tuples
        where context is "SELECT" or "CTE"
    """
    if not SQLGLOT_AVAILABLE:
        return []

    derived = []

    try:
        tree = sqlglot.parse_one(sql, dialect="duckdb")

        # Build alias map for table resolution
        alias_map = {}
        for table in tree.find_all(exp.Table):
            table_name = table.name
            alias = table.alias if table.alias else table_name
            alias_map[alias.lower()] = table_name

        def get_tables_from_expr(expr) -> list[str]:
            """Extract table names from an expression."""
            tables = set()
            for col in expr.find_all(exp.Column):
                table = col.table or ""
                resolved = alias_map.get(table.lower(), table)
                if resolved:
                    tables.add(resolved)
            return sorted(tables)

        def is_derived_expression(expr) -> bool:
            """Check if expression is a computation (not just a column reference)."""
            if isinstance(expr, exp.Column):
                return False
            # Has aggregation or arithmetic
            agg_types = (exp.Sum, exp.Avg, exp.Count, exp.Min, exp.Max, exp.Stddev, exp.Variance)
            arith_types = (exp.Add, exp.Sub, exp.Mul, exp.Div)
            func_types = (exp.Anonymous,)  # Generic function calls
            return (
                any(expr.find_all(t) for t in agg_types)
                or any(expr.find_all(t) for t in arith_types)
                or any(expr.find_all(t) for t in func_types)
            )

        # Extract from CTEs first
        for cte in tree.find_all(exp.CTE):
            cte_query = cte.this
            if not cte_query:
                continue
            for select in cte_query.find_all(exp.Select):
                for expr in select.expressions:
                    if isinstance(expr, exp.Alias):
                        alias = expr.alias
                        inner = expr.this
                        if alias and is_derived_expression(inner):
                            try:
                                expr_sql = inner.sql(dialect="duckdb")
                                if len(expr_sql) <= 200:
                                    tables = get_tables_from_expr(inner)
                                    derived.append((alias, expr_sql, tables, "CTE"))
                            except Exception:
                                pass

        # Extract from main SELECT (excluding CTEs we already processed)
        for select in tree.find_all(exp.Select):
            # Skip if this SELECT is inside a CTE
            parent = select.parent
            in_cte = False
            while parent:
                if isinstance(parent, exp.CTE):
                    in_cte = True
                    break
                parent = parent.parent
            if in_cte:
                continue

            for expr in select.expressions:
                if isinstance(expr, exp.Alias):
                    alias = expr.alias
                    inner = expr.this
                    if alias and is_derived_expression(inner):
                        try:
                            expr_sql = inner.sql(dialect="duckdb")
                            if len(expr_sql) <= 200:
                                tables = get_tables_from_expr(inner)
                                derived.append((alias, expr_sql, tables, "SELECT"))
                        except Exception:
                            pass

    except sqlglot.errors.ParseError as e:
        logger.debug(f"Failed to parse SQL for derived columns: {e}")
    except Exception as e:
        logger.warning(f"Unexpected error extracting derived columns from SQL: {e}")

    return derived


class QueryHistoryAnalyzer:
    """
    Analyzes MotherDuck query history for a specific schema.

    Requires Business plan with organization admin access.
    """

    def __init__(
        self,
        motherduck_token: str | None = None,
        database: str = "bird_bench",
    ):
        # Connect without attaching a specific database - MD_INFORMATION_SCHEMA
        # is account-level and doesn't require the target database to be attached
        self._db = MotherDuckConnection("", motherduck_token)
        self.database = database

    @property
    def conn(self) -> duckdb.DuckDBPyConnection:
        """Get database connection."""
        return self._db.conn

    def close(self):
        """Close database connection."""
        self._db.close()

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.close()

    def get_query_history(
        self,
        schema: str,
        user_name: str | None = None,
        days: int = 30,
        limit: int = 1000,
    ) -> list[dict]:
        """
        Fetch query history for a specific schema.

        Args:
            schema: Schema name to filter queries for
            user_name: Optional user name to filter by
            days: Number of days to look back (default 30)
            limit: Maximum number of queries to fetch

        Returns:
            List of query records
        """
        # Match both fully-qualified (database.schema.table) and schema-only (schema.table) references
        params: list = []
        escaped_schema = schema.replace("'", "''")
        if self.database:
            escaped_db = self.database.replace("'", "''")
            conditions = [
                f"(QUERY_TEXT ILIKE '%{escaped_db}.{escaped_schema}.%' OR QUERY_TEXT ILIKE '% {escaped_schema}.%' OR QUERY_TEXT ILIKE '%\"{escaped_schema}\".%')"
            ]
        else:
            conditions = [f"QUERY_TEXT ILIKE '%{escaped_schema}.%'"]

        if user_name:
            conditions.append("USER_NAME = ?")
            params.append(user_name)

        if days > 0:
            conditions.append("START_TIME >= NOW() - INTERVAL ? DAY")
            params.append(days)

        # Exclude metadata-related queries at SQL level to get full limit of useful queries
        conditions.append("QUERY_TEXT NOT ILIKE '%SUMMARIZE%'")
        conditions.append("QUERY_TEXT NOT ILIKE '%COMMENT ON%'")
        conditions.append("QUERY_TEXT NOT ILIKE '%MD_INFORMATION_SCHEMA%'")
        conditions.append("QUERY_TEXT NOT ILIKE '%INFORMATION_SCHEMA.QUERY_HISTORY%'")
        conditions.append("QUERY_TEXT NOT ILIKE '%metadata.%'")

        where_clause = " AND ".join(conditions)

        sql = f"""
            SELECT
                QUERY_ID,
                QUERY_TEXT,
                USER_NAME,
                START_TIME,
                EXECUTION_TIME,
                QUERY_TYPE
            FROM MD_INFORMATION_SCHEMA.QUERY_HISTORY
            WHERE {where_clause}
            ORDER BY START_TIME DESC
            LIMIT ?
        """
        params.append(limit)

        result = self.conn.execute(sql, params).fetchdf()
        return result.to_dict("records")

    def analyze_schema(
        self,
        schema: str,
        user_name: str | None = None,
        days: int = 30,
        limit: int = 1000,
        verbose: bool = False,
        on_progress: ProgressCallback | None = None,
    ) -> QueryHistoryResult:
        """
        Analyze query history for a schema to discover join patterns and field usage.

        Args:
            schema: Schema name to analyze
            user_name: Optional user name to filter by
            days: Number of days to look back
            limit: Maximum queries to analyze
            verbose: Print progress (show generated descriptions)
            on_progress: Optional callback for progress reporting

        Returns:
            QueryHistoryResult with discovered joins and field usage
        """
        progress = ProgressReporter(on_progress, enabled=on_progress is not None)

        if not SQLGLOT_AVAILABLE:
            return QueryHistoryResult(
                schema=schema,
                queries_analyzed=0,
                error="sqlglot not installed. Run: uv add sqlglot",
            )

        # Fetch queries (may return error result)
        queries = self._fetch_queries(schema, user_name, days, limit, progress)
        if isinstance(queries, QueryHistoryResult):
            return queries

        # Extract all patterns from queries
        patterns = self._extract_all_patterns(queries, progress)

        # Build and return result
        return self._build_result(schema, queries, patterns, verbose, progress)

    def _fetch_queries(
        self,
        schema: str,
        user_name: str | None,
        days: int,
        limit: int,
        progress: ProgressReporter,
    ) -> list[dict] | QueryHistoryResult:
        """Fetch queries from history, returning error result on failure."""
        progress("Fetching query history from MotherDuck...")

        try:
            queries = self.get_query_history(schema, user_name, days, limit)
            progress(f"Retrieved {len(queries)} queries matching schema '{schema}'")
            return queries
        except Exception as e:
            error_msg = str(e)
            if "organization admins" in error_msg.lower():
                return QueryHistoryResult(
                    schema=schema,
                    queries_analyzed=0,
                    error="Query history requires MotherDuck Business plan with organization admin access",
                )
            return QueryHistoryResult(
                schema=schema,
                queries_analyzed=0,
                error=f"Failed to fetch query history: {error_msg}",
            )

    def _extract_all_patterns(
        self, queries: list[dict], progress: ProgressReporter
    ) -> _ExtractedPatterns:
        """Extract all pattern types from queries."""
        progress("Parsing queries to extract patterns...")

        patterns = _ExtractedPatterns(
            join_counts={},
            field_counts={},
            predicate_counts={},
            metric_counts={},
            intra_constraint_counts={},
            cte_counts={},
            derived_column_counts={},
            query_candidates={},
        )

        for i, q in enumerate(queries):
            # Column names are lowercase when returned from fetchdf()
            query_text = q.get("query_text", "")
            if not query_text:
                continue

            # Skip meta-queries (queries about query history itself)
            if self._is_meta_query(query_text):
                continue

            self._extract_joins(query_text, patterns)
            self._extract_field_usage(query_text, patterns)
            self._extract_predicates(query_text, patterns)
            self._extract_metrics(query_text, patterns)
            self._extract_intra_constraints(query_text, patterns)
            self._extract_ctes(query_text, patterns)
            self._extract_derived_columns(query_text, patterns)
            self._collect_sample(query_text, patterns)

            if (i + 1) % PROGRESS_UPDATE_INTERVAL == 0:
                progress(f"Processed {i + 1}/{len(queries)} queries...")

        return patterns

    def _extract_joins(self, sql: str, patterns: _ExtractedPatterns) -> None:
        """Extract and accumulate join patterns from SQL."""
        joins = extract_joins_from_sql(sql)
        if joins:
            patterns.queries_with_joins += 1
        for join in joins:
            patterns.join_counts[join] = patterns.join_counts.get(join, 0) + 1

    def _extract_field_usage(self, sql: str, patterns: _ExtractedPatterns) -> None:
        """Extract and accumulate field usage from SQL."""
        field_refs = extract_field_usage_from_sql(sql)
        for table, column, context in field_refs:
            key = (table, column)
            if key not in patterns.field_counts:
                patterns.field_counts[key] = {
                    "select": 0, "where": 0, "join": 0,
                    "group_by": 0, "order_by": 0, "total": 0,
                }
            patterns.field_counts[key][context] += 1
            patterns.field_counts[key]["total"] += 1

    def _extract_predicates(self, sql: str, patterns: _ExtractedPatterns) -> None:
        """Extract and accumulate predicate patterns from SQL."""
        preds = extract_predicates_from_sql(sql)
        for table, column, operator, pattern, raw_value in preds:
            pred = PredicatePattern(
                table=table, column=column, operator=operator, value_pattern=pattern
            )
            if pred in patterns.predicate_counts:
                count, examples = patterns.predicate_counts[pred]
                if len(examples) < MAX_PREDICATE_EXAMPLES and raw_value not in examples:
                    examples.append(raw_value)
                patterns.predicate_counts[pred] = (count + 1, examples)
            else:
                patterns.predicate_counts[pred] = (1, [raw_value])

    def _extract_metrics(self, sql: str, patterns: _ExtractedPatterns) -> None:
        """Extract and accumulate derived metrics from SQL."""
        metrics = extract_derived_metrics_from_sql(sql)
        for expr, alias, tables in metrics:
            if expr in patterns.metric_counts:
                count, aliases, tbls = patterns.metric_counts[expr]
                if alias:
                    aliases.add(alias)
                tbls.update(tables)
                patterns.metric_counts[expr] = (count + 1, aliases, tbls)
            else:
                patterns.metric_counts[expr] = (1, {alias} if alias else set(), set(tables))

    def _extract_intra_constraints(self, sql: str, patterns: _ExtractedPatterns) -> None:
        """Extract and accumulate intra-table constraints from SQL."""
        constraints = extract_intra_constraints_from_sql(sql)
        for table, left_col, operator, right_col, expr in constraints:
            constraint = IntraTableConstraint(
                table=table,
                left_column=left_col,
                operator=operator,
                right_column=right_col,
                example_expression=expr,
            )
            patterns.intra_constraint_counts[constraint] = (
                patterns.intra_constraint_counts.get(constraint, 0) + 1
            )

    def _extract_ctes(self, sql: str, patterns: _ExtractedPatterns) -> None:
        """Extract and accumulate CTE patterns from SQL."""
        ctes = extract_ctes_from_sql(sql)
        for cte_name, definition, tables, has_agg in ctes:
            cte = CTEPattern(
                cte_name=cte_name,
                definition_pattern=definition,
                tables_referenced=tables,
                has_aggregation=has_agg,
            )
            patterns.cte_counts[cte] = patterns.cte_counts.get(cte, 0) + 1

    def _extract_derived_columns(self, sql: str, patterns: _ExtractedPatterns) -> None:
        """Extract and accumulate derived column definitions from SQL."""
        derived = extract_derived_columns_from_sql(sql)
        for alias, expression, tables, context in derived:
            key = (alias.lower(), expression.lower())
            if key in patterns.derived_column_counts:
                count, tbls, contexts = patterns.derived_column_counts[key]
                tbls.update(tables)
                contexts.add(context)
                patterns.derived_column_counts[key] = (count + 1, tbls, contexts)
            else:
                patterns.derived_column_counts[key] = (1, set(tables), {context})

    def _is_meta_query(self, sql: str) -> bool:
        """Check if query is about metadata/query history itself."""
        sql_upper = sql.upper()
        # Filter queries about information schema
        if "MD_INFORMATION_SCHEMA" in sql_upper or "INFORMATION_SCHEMA.QUERY_HISTORY" in sql_upper:
            return True
        # Filter queries that reference the metadata schema (reads or writes)
        if "METADATA." in sql_upper or "METADATA ." in sql_upper:
            return True
        # Filter SUMMARIZE queries (used by profiler)
        if "SUMMARIZE" in sql_upper:
            return True
        # Filter COMMENT ON queries (used by sql generator)
        if "COMMENT ON" in sql_upper:
            return True
        return False

    def _collect_sample(self, query_text: str, patterns: _ExtractedPatterns) -> None:
        """Collect candidate query with frequency tracking for diverse selection."""
        # Normalize whitespace: collapse multiple spaces/tabs/newlines to single space
        cleaned = re.sub(r'\s+', ' ', query_text).strip()
        # Truncate if limit is set (0 = unlimited)
        if MAX_QUERY_SAMPLE_LENGTH > 0 and len(cleaned) > MAX_QUERY_SAMPLE_LENGTH:
            cleaned = cleaned[:MAX_QUERY_SAMPLE_LENGTH] + "..."

        # Normalize for deduplication (lowercase, collapse whitespace)
        normalized = cleaned.lower().strip()

        # Extract tables for diversity scoring
        tables = self._extract_tables(query_text)

        # Track frequency of each unique query pattern
        if normalized in patterns.query_candidates:
            _, existing_tables, count = patterns.query_candidates[normalized]
            patterns.query_candidates[normalized] = (cleaned, existing_tables, count + 1)
        else:
            patterns.query_candidates[normalized] = (cleaned, frozenset(tables), 1)

    def _extract_tables(self, sql: str) -> list[str]:
        """Extract table names from SQL for diversity scoring."""
        if not SQLGLOT_AVAILABLE:
            return []
        tables = set()
        try:
            tree = sqlglot.parse_one(sql, dialect="duckdb")
            for table in tree.find_all(exp.Table):
                tables.add(table.name)
        except Exception:
            pass
        return sorted(tables)

    def _extract_query_signature(self, sql: str) -> dict:
        """
        Extract semantic features from a query for diversity comparison.

        Returns dict with:
        - tables: frozenset of table names
        - aggregates: frozenset of aggregate functions used (COUNT, SUM, etc.)
        - group_by_cols: frozenset of GROUP BY column names
        - expressions: frozenset of derived expression patterns
        """
        signature = {
            "tables": frozenset(),
            "aggregates": frozenset(),
            "group_by_cols": frozenset(),
            "expressions": frozenset(),
        }

        if not SQLGLOT_AVAILABLE:
            return signature

        try:
            tree = sqlglot.parse_one(sql, dialect="duckdb")

            # Extract tables
            tables = set()
            for table in tree.find_all(exp.Table):
                tables.add(table.name)
            signature["tables"] = frozenset(tables)

            # Extract aggregate functions
            aggregates = set()
            for func in tree.find_all(exp.AggFunc):
                aggregates.add(func.key.upper())
            signature["aggregates"] = frozenset(aggregates)

            # Extract GROUP BY columns
            group_cols = set()
            for group in tree.find_all(exp.Group):
                for expr in group.expressions:
                    if isinstance(expr, exp.Column):
                        group_cols.add(expr.name)
            signature["group_by_cols"] = frozenset(group_cols)

            # Extract derived expression patterns (simplified: function names + operators)
            expressions = set()
            for select in tree.find_all(exp.Select):
                for expr in select.expressions:
                    if isinstance(expr, exp.Alias):
                        inner = expr.this
                        # Capture the type of expression
                        if isinstance(inner, exp.AggFunc):
                            expressions.add(f"agg:{inner.key}")
                        elif isinstance(inner, (exp.Add, exp.Sub, exp.Mul, exp.Div)):
                            expressions.add(f"math:{type(inner).__name__}")
                        elif isinstance(inner, exp.Case):
                            expressions.add("case")
                        elif isinstance(inner, exp.Cast):
                            expressions.add(f"cast:{inner.to.this}")
            signature["expressions"] = frozenset(expressions)

        except Exception:
            pass

        return signature

    def _select_diverse_samples(
        self, candidates: dict[str, tuple[str, frozenset[str], int]]
    ) -> list[str]:
        """
        Select diverse query samples prioritizing frequency.

        Algorithm:
        1. Sort by frequency (most common first)
        2. Always take the most common query
        3. For subsequent queries, add if they bring something new:
           - New table combination (joins)
           - New aggregate functions (measures)
           - New GROUP BY columns (dimensions)
           - New derived expressions (calculations)
        """
        if not candidates:
            return []

        # Sort by frequency descending (most common patterns first)
        sorted_candidates = sorted(candidates.values(), key=lambda x: x[2], reverse=True)

        selected: list[str] = []
        covered_tables: set[frozenset[str]] = set()
        covered_aggregates: set[str] = set()
        covered_group_cols: set[str] = set()
        covered_expressions: set[str] = set()

        for query, tables, count in sorted_candidates:
            if len(selected) >= MAX_QUERY_SAMPLES:
                break

            # Always take first query
            if not selected:
                sig = self._extract_query_signature(query)
                selected.append(query)
                if tables:
                    covered_tables.add(tables)
                covered_aggregates.update(sig["aggregates"])
                covered_group_cols.update(sig["group_by_cols"])
                covered_expressions.update(sig["expressions"])
                continue

            # Check if this query brings something new
            sig = self._extract_query_signature(query)

            new_tables = tables and tables not in covered_tables
            new_aggregates = sig["aggregates"] - covered_aggregates
            new_group_cols = sig["group_by_cols"] - covered_group_cols
            new_expressions = sig["expressions"] - covered_expressions

            if new_tables or new_aggregates or new_group_cols or new_expressions:
                selected.append(query)
                if tables:
                    covered_tables.add(tables)
                covered_aggregates.update(sig["aggregates"])
                covered_group_cols.update(sig["group_by_cols"])
                covered_expressions.update(sig["expressions"])

        return selected

    def _build_result(
        self,
        schema: str,
        queries: list[dict],
        patterns: _ExtractedPatterns,
        verbose: bool,
        progress: ProgressReporter,
    ) -> QueryHistoryResult:
        """Convert extracted patterns into result object."""
        # Calculate minimum occurrence threshold
        min_threshold = max(
            MIN_OCCURRENCE_ABSOLUTE,
            int(len(queries) * MIN_OCCURRENCE_PERCENT / 100),
        )

        progress("Parsing complete:")
        if verbose:
            progress(f"Queries with joins: {patterns.queries_with_joins}")
            progress(f"Unique join patterns: {len(patterns.join_counts)}")
            progress(f"Unique fields referenced: {len(patterns.field_counts)}")
            progress(f"Unique predicates: {len(patterns.predicate_counts)}")
            progress(f"Unique derived metrics: {len(patterns.metric_counts)}")
            progress(f"Unique intra-table constraints: {len(patterns.intra_constraint_counts)}")
            progress(f"Unique CTE patterns: {len(patterns.cte_counts)}")
            progress(f"Unique derived columns: {len(patterns.derived_column_counts)}")
            progress(f"Filtering patterns with < {min_threshold} occurrences")

        # Select diverse query samples
        query_samples = self._select_diverse_samples(patterns.query_candidates)
        if verbose:
            progress(f"Selected {len(query_samples)} diverse samples from {len(patterns.query_candidates)} candidates")

        return QueryHistoryResult(
            schema=schema,
            queries_analyzed=len(queries),
            joins=self._finalize_joins(patterns.join_counts, min_threshold),
            field_usage=self._finalize_field_usage(patterns.field_counts, min_threshold),
            predicates=self._finalize_predicates(patterns.predicate_counts, min_threshold),
            derived_metrics=self._finalize_metrics(patterns.metric_counts, min_threshold),
            intra_constraints=self._finalize_intra_constraints(patterns.intra_constraint_counts, min_threshold),
            cte_patterns=self._finalize_ctes(patterns.cte_counts, min_threshold),
            derived_columns=self._finalize_derived_columns(patterns.derived_column_counts, min_threshold),
            query_samples=query_samples,
            database=self.database,
        )

    def _finalize_joins(self, join_counts: dict, min_threshold: int) -> list[JoinCondition]:
        """Convert join counts to sorted list, filtering rare patterns."""
        joins_list = []
        for join, count in join_counts.items():
            if count >= min_threshold:
                join.count = count
                joins_list.append(join)
        joins_list.sort(key=lambda j: j.count, reverse=True)
        return joins_list

    def _finalize_field_usage(self, field_counts: dict, min_threshold: int) -> list[FieldUsage]:
        """Convert field counts to sorted list, filtering rare and low-importance patterns."""
        field_usage_list = []
        for (table, column), counts in field_counts.items():
            if counts["total"] < min_threshold:
                continue
            usage = FieldUsage(
                table=table,
                column=column,
                select_count=counts["select"],
                where_count=counts["where"],
                join_count=counts["join"],
                group_by_count=counts["group_by"],
                order_by_count=counts["order_by"],
                total_count=counts["total"],
            )
            # Filter by importance score if threshold is set
            if MIN_FIELD_IMPORTANCE_SCORE > 0 and usage.importance_score < MIN_FIELD_IMPORTANCE_SCORE:
                continue
            field_usage_list.append(usage)
        field_usage_list.sort(key=lambda f: f.importance_score, reverse=True)
        return field_usage_list

    def _finalize_predicates(self, predicate_counts: dict, min_threshold: int) -> list[PredicatePattern]:
        """Convert predicate counts to sorted list, filtering rare patterns."""
        predicates_list = []
        for pred, (count, examples) in predicate_counts.items():
            if count >= min_threshold:
                pred.occurrence_count = count
                pred.example_values = examples
                predicates_list.append(pred)
        predicates_list.sort(key=lambda p: p.occurrence_count, reverse=True)
        return predicates_list

    def _finalize_metrics(self, metric_counts: dict, min_threshold: int) -> list[DerivedMetric]:
        """Convert metric counts to sorted list, filtering rare patterns."""
        metrics_list = []
        for expr, (count, aliases, tables) in metric_counts.items():
            if count < min_threshold:
                continue
            metric = DerivedMetric(
                expression=expr,
                alias_names=list(aliases - {None}),
                occurrence_count=count,
                tables_involved=list(tables),
            )
            metrics_list.append(metric)
        metrics_list.sort(key=lambda m: m.occurrence_count, reverse=True)
        return metrics_list

    def _finalize_intra_constraints(self, constraint_counts: dict, min_threshold: int) -> list[IntraTableConstraint]:
        """Convert intra-constraint counts to sorted list, filtering rare patterns."""
        constraints_list = []
        for constraint, count in constraint_counts.items():
            if count >= min_threshold:
                constraint.occurrence_count = count
                constraints_list.append(constraint)
        constraints_list.sort(key=lambda c: c.occurrence_count, reverse=True)
        return constraints_list

    def _finalize_ctes(self, cte_counts: dict, min_threshold: int) -> list[CTEPattern]:
        """Convert CTE counts to sorted list, filtering rare patterns."""
        cte_list = []
        for cte, count in cte_counts.items():
            if count >= min_threshold:
                cte.occurrence_count = count
                cte_list.append(cte)
        cte_list.sort(key=lambda c: c.occurrence_count, reverse=True)
        return cte_list

    def _finalize_derived_columns(self, derived_column_counts: dict, min_threshold: int) -> list[DerivedColumnDefinition]:
        """Convert derived column counts to sorted list, filtering rare patterns."""
        derived_list = []
        for (alias, expression), (count, tables, contexts) in derived_column_counts.items():
            if count < min_threshold:
                continue
            derived = DerivedColumnDefinition(
                alias=alias,
                expression=expression,
                tables_involved=sorted(tables),
                occurrence_count=count,
                common_contexts=sorted(contexts),
            )
            derived_list.append(derived)
        derived_list.sort(key=lambda d: d.occurrence_count, reverse=True)
        return derived_list

    def save_analysis(
        self,
        result: QueryHistoryResult,
        output_dir: str = "output/history",
    ) -> Path:
        """Save analysis result to JSON."""
        db = result.database or self.database
        filename = f"{db}_{result.schema}_history.json"
        return save_json(result, output_dir, filename)

    def load_analysis(
        self,
        schema: str,
        history_dir: str = "output/history",
        database: str | None = None,
    ) -> QueryHistoryResult | None:
        """Load cached analysis from JSON."""
        db = database or self.database
        filename = f"{db}_{schema}_history.json"
        return load_json(QueryHistoryResult, Path(history_dir) / filename)


def format_joins_for_prompt(result: QueryHistoryResult) -> str:
    """
    Format discovered joins as text for inclusion in prompts.

    Args:
        result: QueryHistoryResult from analysis

    Returns:
        Formatted string or empty if no joins
    """
    if not result.joins:
        return ""

    lines = [f"DISCOVERED JOIN PATTERNS FOR {result.schema}:"]
    lines.append(f"(from {result.queries_analyzed} queries in history)")
    lines.append("-" * 40)

    for join in result.joins[:MAX_JOINS_IN_PROMPT]:
        lines.append(
            f"  {join.left_table}.{join.left_column} = "
            f"{join.right_table}.{join.right_column} "
            f"(used {join.count}x)"
        )

    return "\n".join(lines)


def format_field_usage_for_prompt(result: QueryHistoryResult) -> str:
    """
    Format field usage statistics as text for inclusion in prompts.

    Args:
        result: QueryHistoryResult from analysis

    Returns:
        Formatted string or empty if no field usage
    """
    if not result.field_usage:
        return ""

    lines = [f"FIELD IMPORTANCE FOR {result.schema}:"]
    lines.append(f"(from {result.queries_analyzed} queries in history)")
    lines.append("-" * 40)

    for field in result.field_usage[:MAX_FIELD_USAGE_IN_PROMPT]:
        contexts = []
        if field.select_count > 0:
            contexts.append(f"SELECT:{field.select_count}")
        if field.where_count > 0:
            contexts.append(f"WHERE:{field.where_count}")
        if field.join_count > 0:
            contexts.append(f"JOIN:{field.join_count}")
        if field.group_by_count > 0:
            contexts.append(f"GROUP:{field.group_by_count}")
        if field.order_by_count > 0:
            contexts.append(f"ORDER:{field.order_by_count}")

        context_str = ", ".join(contexts) if contexts else f"total:{field.total_count}"
        lines.append(
            f"  {field.table}.{field.column} "
            f"(score: {field.importance_score:.0f}, {context_str})"
        )

    return "\n".join(lines)


def format_predicates_for_prompt(result: QueryHistoryResult) -> str:
    """
    Format predicate patterns as text for inclusion in prompts.

    Args:
        result: QueryHistoryResult from analysis

    Returns:
        Formatted string or empty if no predicates
    """
    if not result.predicates:
        return ""

    lines = [f"COMMON FILTER PATTERNS FOR {result.schema}:"]
    lines.append(f"(from {result.queries_analyzed} queries in history)")
    lines.append("-" * 40)

    for pred in result.predicates[:MAX_PREDICATES_IN_PROMPT]:
        examples_str = ""
        if pred.example_values:
            examples = pred.example_values[:3]
            examples_str = f" (e.g., {', '.join(examples)})"
        lines.append(
            f"  {pred.table}.{pred.column} {pred.operator} {pred.value_pattern} "
            f"({pred.occurrence_count}x){examples_str}"
        )

    return "\n".join(lines)


def format_metrics_for_prompt(result: QueryHistoryResult) -> str:
    """
    Format derived metrics as text for inclusion in prompts.

    Args:
        result: QueryHistoryResult from analysis

    Returns:
        Formatted string or empty if no metrics
    """
    if not result.derived_metrics:
        return ""

    lines = [f"COMMON DERIVED METRICS FOR {result.schema}:"]
    lines.append(f"(from {result.queries_analyzed} queries in history)")
    lines.append("-" * 40)

    for metric in result.derived_metrics[:MAX_METRICS_IN_PROMPT]:
        alias_str = ""
        if metric.alias_names:
            alias_str = f" AS {', '.join(metric.alias_names[:MAX_METRIC_ALIASES])}"
        tables_str = ""
        if metric.tables_involved:
            tables_str = f" [from: {', '.join(metric.tables_involved)}]"
        lines.append(
            f"  {metric.expression}{alias_str} ({metric.occurrence_count}x){tables_str}"
        )

    return "\n".join(lines)


def format_history_for_prompt(result: QueryHistoryResult) -> str:
    """
    Format complete query history analysis for inclusion in prompts.

    Args:
        result: QueryHistoryResult from analysis

    Returns:
        Formatted string combining joins, field usage, predicates, and metrics
    """
    parts = []

    joins_text = format_joins_for_prompt(result)
    if joins_text:
        parts.append(joins_text)

    field_text = format_field_usage_for_prompt(result)
    if field_text:
        parts.append(field_text)

    predicates_text = format_predicates_for_prompt(result)
    if predicates_text:
        parts.append(predicates_text)

    metrics_text = format_metrics_for_prompt(result)
    if metrics_text:
        parts.append(metrics_text)

    return "\n\n".join(parts)


# ============================================================================
# Metadata Schema SQL Generation
# ============================================================================

METADATA_SCHEMA = "metadata"


def generate_metadata_schema_sql(result: QueryHistoryResult, database: str) -> str:
    """
    Generate SQL to create and populate metadata tables from query history analysis.

    Creates tables in a 'metadata' schema:
    - join_patterns: Discovered join relationships
    - field_usage: Field importance and usage statistics
    - predicate_patterns: Common filter conditions
    - derived_metrics: Common aggregations and calculations
    - query_samples: Sample queries from history

    Args:
        result: QueryHistoryResult from analysis
        database: Database name for context

    Returns:
        SQL string with CREATE TABLE and INSERT statements
    """
    statements = []

    # Create schema
    statements.append(f"CREATE SCHEMA IF NOT EXISTS {METADATA_SCHEMA};")
    statements.append("")

    # Generate each table
    statements.append(_generate_join_patterns_sql(result))
    statements.append(_generate_field_usage_sql(result))
    statements.append(_generate_predicate_patterns_sql(result))
    statements.append(_generate_derived_metrics_sql(result))
    statements.append(_generate_query_samples_sql(result))

    return "\n".join(statements)


def _escape_sql_string(s: str) -> str:
    """Escape single quotes in SQL string literals."""
    return s.replace("'", "''")


def dollar_quote(s: str) -> str:
    """
    Wrap string in dollar-quotes for safe SQL embedding.

    Dollar-quoting avoids escaping issues with nested quotes.
    Uses $$...$$ unless the string contains $$, then uses $q$...$q$.
    """
    if "$$" not in s:
        return f"$${s}$$"
    # Find a unique tag that doesn't appear in the string
    for tag in ["q", "sql", "query", "txt", "str"]:
        marker = f"${tag}$"
        if marker not in s:
            return f"{marker}{s}{marker}"
    # Fallback: use numbered tags
    i = 0
    while f"$t{i}$" in s:
        i += 1
    marker = f"$t{i}$"
    return f"{marker}{s}{marker}"


def split_sql_statements(sql: str) -> list[str]:
    """
    Split SQL text into individual statements, respecting dollar-quoted strings.

    Unlike naive sql.split(";"), this correctly handles semicolons inside
    dollar-quoted strings ($$...$$, $tag$...$tag$).

    Args:
        sql: SQL text potentially containing multiple statements

    Returns:
        List of individual SQL statements (without trailing semicolons)
    """
    statements = []
    current = []
    i = 0
    n = len(sql)

    while i < n:
        char = sql[i]

        # Check for dollar-quote start
        if char == '$':
            # Find the end of the tag (could be $$ or $tag$)
            tag_end = i + 1
            while tag_end < n and (sql[tag_end].isalnum() or sql[tag_end] == '_'):
                tag_end += 1
            if tag_end < n and sql[tag_end] == '$':
                # Found a dollar-quote tag like $$ or $tag$
                tag = sql[i:tag_end + 1]
                current.append(tag)
                i = tag_end + 1

                # Find the closing tag
                close_pos = sql.find(tag, i)
                if close_pos != -1:
                    current.append(sql[i:close_pos])
                    current.append(tag)
                    i = close_pos + len(tag)
                else:
                    # Unterminated dollar-quote - take rest of string
                    current.append(sql[i:])
                    i = n
                continue

        # Check for single-quoted string
        if char == "'":
            current.append(char)
            i += 1
            while i < n:
                if sql[i] == "'":
                    current.append(sql[i])
                    i += 1
                    # Check for escaped quote ''
                    if i < n and sql[i] == "'":
                        current.append(sql[i])
                        i += 1
                    else:
                        break
                else:
                    current.append(sql[i])
                    i += 1
            continue

        # Check for statement terminator
        if char == ';':
            stmt = ''.join(current).strip()
            # Strip leading comment lines (e.g., "-- Table: x\nCOMMENT ON...")
            while stmt.startswith('--'):
                newline_pos = stmt.find('\n')
                if newline_pos == -1:
                    stmt = ''  # Only comment, no actual statement
                    break
                stmt = stmt[newline_pos + 1:].strip()
            if stmt:
                statements.append(stmt)
            current = []
            i += 1
            continue

        current.append(char)
        i += 1

    # Don't forget the last statement if it doesn't end with semicolon
    stmt = ''.join(current).strip()
    # Strip leading comment lines
    while stmt.startswith('--'):
        newline_pos = stmt.find('\n')
        if newline_pos == -1:
            stmt = ''
            break
        stmt = stmt[newline_pos + 1:].strip()
    if stmt:
        statements.append(stmt)

    return statements


def _generate_join_patterns_sql(result: QueryHistoryResult) -> str:
    """Generate SQL for join_patterns table."""
    lines = [
        f"-- Join patterns for schema: {result.schema}",
        f"CREATE TABLE IF NOT EXISTS {METADATA_SCHEMA}.join_patterns (",
        "    left_table VARCHAR,",
        "    left_column VARCHAR,",
        "    right_table VARCHAR,",
        "    right_column VARCHAR,",
        "    occurrence_count INTEGER,",
        "    schema_name VARCHAR,",
        "    analyzed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP",
        ");",
        f"DELETE FROM {METADATA_SCHEMA}.join_patterns WHERE schema_name = '{_escape_sql_string(result.schema)}';",
    ]

    if result.joins:
        lines.append(f"INSERT INTO {METADATA_SCHEMA}.join_patterns ")
        lines.append("    (left_table, left_column, right_table, right_column, occurrence_count, schema_name)")
        lines.append("VALUES")
        values = []
        for j in result.joins:
            values.append(
                f"    ('{_escape_sql_string(j.left_table)}', '{_escape_sql_string(j.left_column)}', "
                f"'{_escape_sql_string(j.right_table)}', '{_escape_sql_string(j.right_column)}', "
                f"{j.count}, '{_escape_sql_string(result.schema)}')"
            )
        lines.append(",\n".join(values) + ";")

    lines.append("")
    return "\n".join(lines)


def _generate_field_usage_sql(result: QueryHistoryResult) -> str:
    """Generate SQL for field_usage table."""
    lines = [
        f"-- Field usage for schema: {result.schema}",
        f"CREATE TABLE IF NOT EXISTS {METADATA_SCHEMA}.field_usage (",
        "    table_name VARCHAR,",
        "    column_name VARCHAR,",
        "    select_count INTEGER,",
        "    where_count INTEGER,",
        "    join_count INTEGER,",
        "    group_by_count INTEGER,",
        "    order_by_count INTEGER,",
        "    total_count INTEGER,",
        "    importance_score DOUBLE,",
        "    schema_name VARCHAR,",
        "    analyzed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP",
        ");",
        f"DELETE FROM {METADATA_SCHEMA}.field_usage WHERE schema_name = '{_escape_sql_string(result.schema)}';",
    ]

    if result.field_usage:
        lines.append(f"INSERT INTO {METADATA_SCHEMA}.field_usage ")
        lines.append("    (table_name, column_name, select_count, where_count, join_count, ")
        lines.append("     group_by_count, order_by_count, total_count, importance_score, schema_name)")
        lines.append("VALUES")
        values = []
        for f in result.field_usage:
            values.append(
                f"    ('{_escape_sql_string(f.table)}', '{_escape_sql_string(f.column)}', "
                f"{f.select_count}, {f.where_count}, {f.join_count}, {f.group_by_count}, "
                f"{f.order_by_count}, {f.total_count}, {f.importance_score}, "
                f"'{_escape_sql_string(result.schema)}')"
            )
        lines.append(",\n".join(values) + ";")

    lines.append("")
    return "\n".join(lines)


def _generate_predicate_patterns_sql(result: QueryHistoryResult) -> str:
    """Generate SQL for predicate_patterns table."""
    lines = [
        f"-- Predicate patterns for schema: {result.schema}",
        f"CREATE TABLE IF NOT EXISTS {METADATA_SCHEMA}.predicate_patterns (",
        "    table_name VARCHAR,",
        "    column_name VARCHAR,",
        "    operator VARCHAR,",
        "    value_pattern VARCHAR,",
        "    occurrence_count INTEGER,",
        "    example_values VARCHAR[],",
        "    schema_name VARCHAR,",
        "    analyzed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP",
        ");",
        f"DELETE FROM {METADATA_SCHEMA}.predicate_patterns WHERE schema_name = '{_escape_sql_string(result.schema)}';",
    ]

    if result.predicates:
        lines.append(f"INSERT INTO {METADATA_SCHEMA}.predicate_patterns ")
        lines.append("    (table_name, column_name, operator, value_pattern, occurrence_count, example_values, schema_name)")
        lines.append("VALUES")
        values = []
        for p in result.predicates:
            examples_sql = "[" + ", ".join(f"'{_escape_sql_string(e)}'" for e in p.example_values) + "]"
            values.append(
                f"    ('{_escape_sql_string(p.table)}', '{_escape_sql_string(p.column)}', "
                f"'{_escape_sql_string(p.operator)}', '{_escape_sql_string(p.value_pattern)}', "
                f"{p.occurrence_count}, {examples_sql}, '{_escape_sql_string(result.schema)}')"
            )
        lines.append(",\n".join(values) + ";")

    lines.append("")
    return "\n".join(lines)


def _generate_derived_metrics_sql(result: QueryHistoryResult) -> str:
    """Generate SQL for derived_metrics table."""
    lines = [
        f"-- Derived metrics for schema: {result.schema}",
        f"CREATE TABLE IF NOT EXISTS {METADATA_SCHEMA}.derived_metrics (",
        "    expression VARCHAR,",
        "    alias_names VARCHAR[],",
        "    occurrence_count INTEGER,",
        "    tables_involved VARCHAR[],",
        "    schema_name VARCHAR,",
        "    analyzed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP",
        ");",
        f"DELETE FROM {METADATA_SCHEMA}.derived_metrics WHERE schema_name = '{_escape_sql_string(result.schema)}';",
    ]

    if result.derived_metrics:
        lines.append(f"INSERT INTO {METADATA_SCHEMA}.derived_metrics ")
        lines.append("    (expression, alias_names, occurrence_count, tables_involved, schema_name)")
        lines.append("VALUES")
        values = []
        for m in result.derived_metrics:
            aliases_sql = "[" + ", ".join(f"'{_escape_sql_string(a)}'" for a in m.alias_names) + "]"
            tables_sql = "[" + ", ".join(f"'{_escape_sql_string(t)}'" for t in m.tables_involved) + "]"
            values.append(
                f"    ('{_escape_sql_string(m.expression)}', {aliases_sql}, "
                f"{m.occurrence_count}, {tables_sql}, '{_escape_sql_string(result.schema)}')"
            )
        lines.append(",\n".join(values) + ";")

    lines.append("")
    return "\n".join(lines)


def _generate_query_samples_sql(result: QueryHistoryResult) -> str:
    """Generate SQL for query_samples table."""
    lines = [
        f"-- Query samples for schema: {result.schema}",
        f"CREATE TABLE IF NOT EXISTS {METADATA_SCHEMA}.query_samples (",
        "    sample_index INTEGER,",
        "    query_text VARCHAR,",
        "    schema_name VARCHAR,",
        "    analyzed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP",
        ");",
        f"DELETE FROM {METADATA_SCHEMA}.query_samples WHERE schema_name = '{_escape_sql_string(result.schema)}';",
    ]

    # Generate individual INSERT statements to avoid semicolon-splitting issues
    # when query_text contains semicolons (which break the CLI's sql.split(";"))
    for i, sample in enumerate(result.query_samples):
        lines.append(
            f"INSERT INTO {METADATA_SCHEMA}.query_samples "
            f"(sample_index, query_text, schema_name) VALUES "
            f"({i}, {dollar_quote(sample)}, '{_escape_sql_string(result.schema)}');"
        )

    lines.append("")
    return "\n".join(lines)
