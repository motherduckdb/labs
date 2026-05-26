#!/usr/bin/env python3
"""
Automatic Metadata Extraction for Text-to-SQL

A standalone implementation of the paper "Automatic Metadata Extraction for Text-to-SQL"
(arXiv:2505.19988) for MotherDuck databases.

Two commands:
  history <schema>   - Analyze query history and store patterns
  generate <schema>  - Generate metadata with history context

Usage:
  uv run metadata_generator.py -d mydb history myschema
  uv run metadata_generator.py -d mydb generate myschema --with-history

Environment variables:
  MOTHERDUCK_TOKEN    - Required for all database operations
  OPENROUTER_API_KEY  - Required for LLM descriptions

Reference:
  Shkapenyuk, Srivastava, Johnson, Ghane. "Automatic Metadata Extraction for Text-to-SQL."
  arXiv:2505.19988, May 2025.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import re
from dataclasses import dataclass, field, asdict
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Protocol, TypeVar

import duckdb
import pandas as pd
from dotenv import load_dotenv
from openai import OpenAI

# Optional: sqlglot for SQL parsing
try:
    import sqlglot
    from sqlglot import exp
    SQLGLOT_AVAILABLE = True
except ImportError:
    SQLGLOT_AVAILABLE = False
    print("Warning: sqlglot not installed. Run: uv add sqlglot")

logger = logging.getLogger(__name__)

# ============================================================================
# Configuration Constants
# ============================================================================

CATEGORICAL_THRESHOLD = 20
CATEGORICAL_SAMPLE_LIMIT = 10
PATTERN_DETECTION_SAMPLE_SIZE = 20
PATTERN_MATCH_THRESHOLD = 0.8
STRING_SHAPE_SAMPLE_SIZE = 10_000

OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
DEFAULT_LLM_MODEL = "google/gemini-3-flash-preview"
HTTP_REFERER = "https://github.com/matsonj/metadata_generator"
APP_TITLE = "MotherDuck Metadata Generator"

MAX_JOINS_IN_PROMPT = 15
MAX_QUERY_SAMPLES = 30
MAX_PREDICATE_EXAMPLES = 5
MAX_METRIC_ALIASES = 3
PROGRESS_UPDATE_INTERVAL = 100

MIN_OCCURRENCE_PERCENT = 0.5
MIN_OCCURRENCE_ABSOLUTE = 2
MIN_FIELD_IMPORTANCE_SCORE = 50

# ============================================================================
# Progress Reporting
# ============================================================================

class ProgressCallback(Protocol):
    def __call__(self, message: str) -> None: ...


def print_progress(message: str) -> None:
    print(f"  {message}")


class ProgressReporter:
    def __init__(self, callback: ProgressCallback | None = None, enabled: bool = True):
        self._callback = callback or print_progress
        self._enabled = enabled

    def __call__(self, message: str) -> None:
        if self._enabled:
            self._callback(message)


# ============================================================================
# Data Models
# ============================================================================

@dataclass
class ColumnProfile:
    name: str
    dtype: str
    min_value: str | None = None
    max_value: str | None = None
    approx_unique: int | None = None
    avg: float | None = None
    std: float | None = None
    q25: float | None = None
    q50: float | None = None
    q75: float | None = None
    count: int = 0
    null_percentage: float = 0.0
    is_categorical: bool = False
    sample_values: list[str] | None = None
    min_length: int | None = None
    max_length: int | None = None
    avg_length: float | None = None
    detected_pattern: str | None = None
    char_composition: dict | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ColumnProfile":
        known_fields = {f.name for f in cls.__dataclass_fields__.values()}
        filtered_data = {k: v for k, v in data.items() if k in known_fields}
        return cls(**filtered_data)


@dataclass
class TableProfile:
    name: str
    row_count: int
    columns: list[ColumnProfile] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {"name": self.name, "row_count": self.row_count, "columns": [c.to_dict() for c in self.columns]}

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "TableProfile":
        columns = [ColumnProfile.from_dict(c) for c in data.get("columns", [])]
        return cls(name=data["name"], row_count=data["row_count"], columns=columns)


@dataclass
class SchemaProfile:
    db_id: str
    database: str
    tables: list[TableProfile] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {"db_id": self.db_id, "database": self.database, "tables": [t.to_dict() for t in self.tables]}

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "SchemaProfile":
        tables = [TableProfile.from_dict(t) for t in data.get("tables", [])]
        return cls(db_id=data["db_id"], database=data.get("database", ""), tables=tables)


@dataclass
class ColumnDescription:
    column_name: str
    table_name: str
    description: str
    semantic_type: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ColumnDescription":
        return cls(**data)


@dataclass
class TableDescription:
    table_name: str
    description: str
    columns: list[ColumnDescription] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {"table_name": self.table_name, "description": self.description, "columns": [c.to_dict() for c in self.columns]}

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "TableDescription":
        columns = [ColumnDescription.from_dict(c) for c in data.get("columns", [])]
        return cls(table_name=data["table_name"], description=data["description"], columns=columns)


@dataclass
class SchemaDescription:
    db_id: str
    tables: list[TableDescription] = field(default_factory=list)
    database: str | None = None

    def to_dict(self) -> dict[str, Any]:
        result = {"db_id": self.db_id, "tables": [t.to_dict() for t in self.tables]}
        if self.database:
            result["database"] = self.database
        return result

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "SchemaDescription":
        tables = [TableDescription.from_dict(t) for t in data.get("tables", [])]
        return cls(db_id=data["db_id"], tables=tables, database=data.get("database"))


@dataclass
class QueryTranslation:
    sql: str
    natural_language: str
    tables_referenced: list[str] = field(default_factory=list)
    short_question: str | None = None
    long_question: str | None = None

    def to_dict(self) -> dict[str, Any]:
        result = {"sql": self.sql, "natural_language": self.natural_language, "tables_referenced": self.tables_referenced}
        if self.short_question:
            result["short_question"] = self.short_question
        if self.long_question:
            result["long_question"] = self.long_question
        return result

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "QueryTranslation":
        return cls(
            sql=data["sql"],
            natural_language=data["natural_language"],
            tables_referenced=data.get("tables_referenced", []),
            short_question=data.get("short_question"),
            long_question=data.get("long_question"),
        )


# Query History Data Models

@dataclass
class JoinCondition:
    left_table: str
    left_column: str
    right_table: str
    right_column: str
    count: int = 1

    def __hash__(self):
        pair = tuple(sorted([(self.left_table.lower(), self.left_column.lower()),
                             (self.right_table.lower(), self.right_column.lower())]))
        return hash(pair)

    def __eq__(self, other):
        return isinstance(other, JoinCondition) and hash(self) == hash(other)

    def to_dict(self) -> dict:
        return {"left_table": self.left_table, "left_column": self.left_column,
                "right_table": self.right_table, "right_column": self.right_column, "count": self.count}

    @classmethod
    def from_dict(cls, d: dict) -> "JoinCondition":
        return cls(**d)


@dataclass
class FieldUsage:
    table: str
    column: str
    select_count: int = 0
    where_count: int = 0
    join_count: int = 0
    group_by_count: int = 0
    order_by_count: int = 0
    total_count: int = 0

    @property
    def importance_score(self) -> float:
        return self.select_count * 1.0 + self.where_count * 2.0 + self.join_count * 3.0 + self.group_by_count * 2.0 + self.order_by_count * 1.0

    def to_dict(self) -> dict:
        return {"table": self.table, "column": self.column, "select_count": self.select_count,
                "where_count": self.where_count, "join_count": self.join_count, "group_by_count": self.group_by_count,
                "order_by_count": self.order_by_count, "total_count": self.total_count, "importance_score": self.importance_score}

    @classmethod
    def from_dict(cls, d: dict) -> "FieldUsage":
        return cls(table=d["table"], column=d["column"], select_count=d.get("select_count", 0),
                   where_count=d.get("where_count", 0), join_count=d.get("join_count", 0),
                   group_by_count=d.get("group_by_count", 0), order_by_count=d.get("order_by_count", 0),
                   total_count=d.get("total_count", 0))


@dataclass
class PredicatePattern:
    table: str
    column: str
    operator: str
    value_pattern: str
    occurrence_count: int = 1
    example_values: list[str] = field(default_factory=list)

    def __hash__(self):
        return hash((self.table.lower(), self.column.lower(), self.operator, self.value_pattern))

    def __eq__(self, other):
        return isinstance(other, PredicatePattern) and hash(self) == hash(other)

    def to_dict(self) -> dict:
        return {"table": self.table, "column": self.column, "operator": self.operator,
                "value_pattern": self.value_pattern, "occurrence_count": self.occurrence_count,
                "example_values": self.example_values}

    @classmethod
    def from_dict(cls, d: dict) -> "PredicatePattern":
        return cls(table=d["table"], column=d["column"], operator=d["operator"],
                   value_pattern=d["value_pattern"], occurrence_count=d.get("occurrence_count", 1),
                   example_values=d.get("example_values", []))


@dataclass
class DerivedMetric:
    expression: str
    alias_names: list[str] = field(default_factory=list)
    occurrence_count: int = 1
    tables_involved: list[str] = field(default_factory=list)

    def __hash__(self):
        return hash(self.expression.lower())

    def __eq__(self, other):
        return isinstance(other, DerivedMetric) and hash(self) == hash(other)

    def to_dict(self) -> dict:
        return {"expression": self.expression, "alias_names": self.alias_names,
                "occurrence_count": self.occurrence_count, "tables_involved": self.tables_involved}

    @classmethod
    def from_dict(cls, d: dict) -> "DerivedMetric":
        return cls(expression=d["expression"], alias_names=d.get("alias_names", []),
                   occurrence_count=d.get("occurrence_count", 1), tables_involved=d.get("tables_involved", []))


@dataclass
class DerivedColumnDefinition:
    alias: str
    expression: str
    tables_involved: list[str] = field(default_factory=list)
    occurrence_count: int = 1
    common_contexts: list[str] = field(default_factory=list)

    def __hash__(self):
        return hash((self.alias.lower(), self.expression.lower()))

    def __eq__(self, other):
        return isinstance(other, DerivedColumnDefinition) and hash(self) == hash(other)

    def to_dict(self) -> dict:
        return {"alias": self.alias, "expression": self.expression, "tables_involved": self.tables_involved,
                "occurrence_count": self.occurrence_count, "common_contexts": self.common_contexts}

    @classmethod
    def from_dict(cls, d: dict) -> "DerivedColumnDefinition":
        return cls(alias=d["alias"], expression=d["expression"], tables_involved=d.get("tables_involved", []),
                   occurrence_count=d.get("occurrence_count", 1), common_contexts=d.get("common_contexts", []))


@dataclass
class QueryHistoryResult:
    schema: str
    queries_analyzed: int
    joins: list[JoinCondition] = field(default_factory=list)
    field_usage: list[FieldUsage] = field(default_factory=list)
    predicates: list[PredicatePattern] = field(default_factory=list)
    derived_metrics: list[DerivedMetric] = field(default_factory=list)
    derived_columns: list[DerivedColumnDefinition] = field(default_factory=list)
    query_samples: list[str] = field(default_factory=list)
    error: str | None = None
    database: str | None = None

    def to_dict(self) -> dict:
        result = {"schema": self.schema, "queries_analyzed": self.queries_analyzed,
                  "joins": [j.to_dict() for j in self.joins], "field_usage": [f.to_dict() for f in self.field_usage],
                  "predicates": [p.to_dict() for p in self.predicates],
                  "derived_metrics": [m.to_dict() for m in self.derived_metrics],
                  "derived_columns": [d.to_dict() for d in self.derived_columns],
                  "query_samples": self.query_samples, "error": self.error}
        if self.database:
            result["database"] = self.database
        return result

    @classmethod
    def from_dict(cls, d: dict) -> "QueryHistoryResult":
        return cls(
            schema=d["schema"], queries_analyzed=d["queries_analyzed"],
            joins=[JoinCondition.from_dict(j) for j in d.get("joins", [])],
            field_usage=[FieldUsage.from_dict(f) for f in d.get("field_usage", [])],
            predicates=[PredicatePattern.from_dict(p) for p in d.get("predicates", [])],
            derived_metrics=[DerivedMetric.from_dict(m) for m in d.get("derived_metrics", [])],
            derived_columns=[DerivedColumnDefinition.from_dict(dc) for dc in d.get("derived_columns", [])],
            query_samples=d.get("query_samples", []), error=d.get("error"), database=d.get("database"))


# ============================================================================
# Database Connection
# ============================================================================

class MotherDuckConnection:
    def __init__(self, database: str = "", token: str | None = None):
        self.database = database
        self.token = token or os.environ.get("MOTHERDUCK_TOKEN")
        if not self.token:
            raise ValueError("MOTHERDUCK_TOKEN not set")
        self._conn: duckdb.DuckDBPyConnection | None = None

    @property
    def conn(self) -> duckdb.DuckDBPyConnection:
        if self._conn is None:
            if self.database:
                self._conn = duckdb.connect(f"md:{self.database}?motherduck_token={self.token}")
            else:
                self._conn = duckdb.connect(f"md:?motherduck_token={self.token}")
        return self._conn

    def close(self) -> None:
        if self._conn is not None:
            self._conn.close()
            self._conn = None

    def __enter__(self) -> "MotherDuckConnection":
        return self

    def __exit__(self, exc_type, exc_val, exc_tb) -> None:
        self.close()


# ============================================================================
# LLM Client
# ============================================================================

def create_openrouter_client(api_key: str | None = None) -> OpenAI:
    api_key = api_key or os.environ.get("OPENROUTER_API_KEY")
    if not api_key:
        raise ValueError("OPENROUTER_API_KEY not set")
    return OpenAI(
        base_url=OPENROUTER_BASE_URL, api_key=api_key,
        default_headers={"HTTP-Referer": HTTP_REFERER, "X-Title": APP_TITLE})


def get_model(model: str | None = None) -> str:
    return model or DEFAULT_LLM_MODEL


# ============================================================================
# SQL Parsing Utilities
# ============================================================================

def extract_tables_from_sql(sql: str) -> list[str]:
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


def extract_joins_from_sql(sql: str) -> list[JoinCondition]:
    if not SQLGLOT_AVAILABLE:
        return []
    joins = []
    try:
        tree = sqlglot.parse_one(sql, dialect="duckdb")
        cte_names = {cte.alias.lower() for cte in tree.find_all(exp.CTE) if cte.alias}
        alias_map = {}
        for table in tree.find_all(exp.Table):
            alias_map[(table.alias if table.alias else table.name).lower()] = table.name

        for eq in tree.find_all(exp.EQ):
            left, right = eq.left, eq.right
            if isinstance(left, exp.Column) and isinstance(right, exp.Column):
                left_table = alias_map.get((left.table or "").lower(), left.table or "")
                right_table = alias_map.get((right.table or "").lower(), right.table or "")
                if left_table.lower() in cte_names or right_table.lower() in cte_names:
                    continue
                if left_table and right_table and left_table.lower() != right_table.lower():
                    joins.append(JoinCondition(left_table=left_table, left_column=left.name,
                                               right_table=right_table, right_column=right.name))
    except Exception:
        pass
    return joins


def extract_field_usage_from_sql(sql: str) -> list[tuple[str, str, str]]:
    if not SQLGLOT_AVAILABLE:
        return []
    usage = []
    try:
        tree = sqlglot.parse_one(sql, dialect="duckdb")
        alias_map = {}
        for table in tree.find_all(exp.Table):
            alias_map[(table.alias if table.alias else table.name).lower()] = table.name

        def resolve_table(col: exp.Column) -> str:
            return alias_map.get((col.table or "").lower(), col.table or "")

        for select in tree.find_all(exp.Select):
            for expr in select.expressions:
                if not isinstance(expr, exp.Subquery):
                    for col in expr.find_all(exp.Column):
                        table = resolve_table(col)
                        if table:
                            usage.append((table, col.name, "select"))

        for where in tree.find_all(exp.Where):
            for col in where.find_all(exp.Column):
                table = resolve_table(col)
                if table:
                    usage.append((table, col.name, "where"))

        for join in tree.find_all(exp.Join):
            if join.args.get("on"):
                for col in join.args["on"].find_all(exp.Column):
                    table = resolve_table(col)
                    if table:
                        usage.append((table, col.name, "join"))

        for group in tree.find_all(exp.Group):
            for col in group.find_all(exp.Column):
                table = resolve_table(col)
                if table:
                    usage.append((table, col.name, "group_by"))

        for order in tree.find_all(exp.Order):
            for col in order.find_all(exp.Column):
                table = resolve_table(col)
                if table:
                    usage.append((table, col.name, "order_by"))
    except Exception:
        pass
    return usage


def _anonymize_value(expr) -> str:
    if isinstance(expr, exp.Literal):
        if expr.is_string:
            return f"'{expr.this}'" if len(expr.this) <= 20 else "'<string>'"
        return "<number>"
    if isinstance(expr, exp.Boolean):
        return str(expr.this).upper()
    if isinstance(expr, exp.Null):
        return "NULL"
    if isinstance(expr, exp.CurrentDate):
        return "CURRENT_DATE"
    if isinstance(expr, exp.CurrentTimestamp):
        return "CURRENT_TIMESTAMP"
    try:
        sql = expr.sql(dialect="duckdb")
        return sql if len(sql) <= 50 else "<expression>"
    except Exception:
        return "<expression>"


def extract_predicates_from_sql(sql: str) -> list[tuple[str, str, str, str, str]]:
    if not SQLGLOT_AVAILABLE:
        return []
    predicates = []
    try:
        tree = sqlglot.parse_one(sql, dialect="duckdb")
        alias_map = {}
        for table in tree.find_all(exp.Table):
            alias_map[(table.alias if table.alias else table.name).lower()] = table.name

        def resolve_table(col: exp.Column) -> str:
            return alias_map.get((col.table or "").lower(), col.table or "")

        comparisons = [(exp.EQ, "="), (exp.NEQ, "!="), (exp.GT, ">"), (exp.GTE, ">="),
                       (exp.LT, "<"), (exp.LTE, "<="), (exp.Like, "LIKE"), (exp.ILike, "ILIKE"),
                       (exp.In, "IN"), (exp.Between, "BETWEEN")]

        for where in tree.find_all(exp.Where):
            for comp_type, op in comparisons:
                for comp in where.find_all(comp_type):
                    left = comp.this
                    if isinstance(left, exp.Column):
                        table = resolve_table(left)
                        if table:
                            right = getattr(comp, 'expression', None) or (comp.expressions[0] if hasattr(comp, 'expressions') and comp.expressions else None)
                            if right:
                                pattern = _anonymize_value(right)
                                try:
                                    raw = right.sql(dialect="duckdb")[:50]
                                except Exception:
                                    raw = str(right)[:50]
                                predicates.append((table, left.name, op, pattern, raw))
    except Exception:
        pass
    return predicates


def extract_derived_metrics_from_sql(sql: str) -> list[tuple[str, str | None, list[str]]]:
    if not SQLGLOT_AVAILABLE:
        return []
    metrics = []
    try:
        tree = sqlglot.parse_one(sql, dialect="duckdb")
        alias_map = {}
        for table in tree.find_all(exp.Table):
            alias_map[(table.alias if table.alias else table.name).lower()] = table.name

        def get_tables_from_expr(expr) -> list[str]:
            tables = set()
            for col in expr.find_all(exp.Column):
                resolved = alias_map.get((col.table or "").lower(), col.table or "")
                if resolved:
                    tables.add(resolved)
            return list(tables)

        def has_aggregation_or_arithmetic(expr) -> bool:
            agg_types = (exp.Sum, exp.Avg, exp.Count, exp.Min, exp.Max, exp.Stddev, exp.Variance)
            arith_types = (exp.Add, exp.Sub, exp.Mul, exp.Div)
            return any(expr.find_all(t) for t in agg_types) or any(expr.find_all(t) for t in arith_types)

        for select in tree.find_all(exp.Select):
            for expr in select.expressions:
                if isinstance(expr, (exp.Column, exp.Subquery)):
                    continue
                inner = expr.this if isinstance(expr, exp.Alias) else expr
                if has_aggregation_or_arithmetic(inner):
                    try:
                        expr_sql = inner.sql(dialect="duckdb")
                        if len(expr_sql) <= 100:
                            alias = expr.alias if isinstance(expr, exp.Alias) else None
                            metrics.append((expr_sql, alias, get_tables_from_expr(inner)))
                    except Exception:
                        pass
    except Exception:
        pass
    return metrics


def extract_derived_columns_from_sql(sql: str) -> list[tuple[str, str, list[str], str]]:
    if not SQLGLOT_AVAILABLE:
        return []
    derived = []
    try:
        tree = sqlglot.parse_one(sql, dialect="duckdb")
        alias_map = {}
        for table in tree.find_all(exp.Table):
            alias_map[(table.alias if table.alias else table.name).lower()] = table.name

        def get_tables_from_expr(expr) -> list[str]:
            tables = set()
            for col in expr.find_all(exp.Column):
                resolved = alias_map.get((col.table or "").lower(), col.table or "")
                if resolved:
                    tables.add(resolved)
            return sorted(tables)

        def is_derived_expression(expr) -> bool:
            if isinstance(expr, exp.Column):
                return False
            agg_types = (exp.Sum, exp.Avg, exp.Count, exp.Min, exp.Max, exp.Stddev, exp.Variance)
            arith_types = (exp.Add, exp.Sub, exp.Mul, exp.Div)
            func_types = (exp.Anonymous,)
            return any(expr.find_all(t) for t in agg_types) or any(expr.find_all(t) for t in arith_types) or any(expr.find_all(t) for t in func_types)

        for cte in tree.find_all(exp.CTE):
            cte_query = cte.this
            if cte_query:
                for select in cte_query.find_all(exp.Select):
                    for expr in select.expressions:
                        if isinstance(expr, exp.Alias):
                            alias, inner = expr.alias, expr.this
                            if alias and is_derived_expression(inner):
                                try:
                                    expr_sql = inner.sql(dialect="duckdb")
                                    if len(expr_sql) <= 200:
                                        derived.append((alias, expr_sql, get_tables_from_expr(inner), "CTE"))
                                except Exception:
                                    pass

        for select in tree.find_all(exp.Select):
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
                    alias, inner = expr.alias, expr.this
                    if alias and is_derived_expression(inner):
                        try:
                            expr_sql = inner.sql(dialect="duckdb")
                            if len(expr_sql) <= 200:
                                derived.append((alias, expr_sql, get_tables_from_expr(inner), "SELECT"))
                        except Exception:
                            pass
    except Exception:
        pass
    return derived


# ============================================================================
# Database Profiler
# ============================================================================

class DatabaseProfiler:
    def __init__(self, motherduck_token: str | None = None, database: str = ""):
        self._db = MotherDuckConnection(database, motherduck_token)
        self.database = database

    @property
    def conn(self) -> duckdb.DuckDBPyConnection:
        return self._db.conn

    def close(self):
        self._db.close()

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.close()

    def get_tables(self, schema: str) -> list[str]:
        result = self.conn.execute(f"""
            SELECT table_name FROM information_schema.tables
            WHERE table_catalog = '{self.database}' AND table_schema = '{schema}'
            ORDER BY table_name
        """).fetchall()
        return [row[0] for row in result]

    def get_sample_values(self, schema: str, table: str, column: str, limit: int = 5) -> list[str]:
        try:
            result = self.conn.execute(f"""
                SELECT DISTINCT "{column}" FROM {schema}."{table}"
                WHERE "{column}" IS NOT NULL LIMIT {limit}
            """).fetchall()
            return [str(row[0]) for row in result]
        except Exception:
            return []

    def _safe_float(self, value) -> float | None:
        if value is None or pd.isna(value):
            return None
        try:
            return float(value)
        except (ValueError, TypeError):
            return None

    def _safe_int(self, value) -> int | None:
        if value is None or pd.isna(value):
            return None
        try:
            return int(value)
        except (ValueError, TypeError):
            return None

    def _safe_str(self, value) -> str | None:
        if value is None or pd.isna(value):
            return None
        return str(value)

    def _is_string_type(self, dtype: str) -> bool:
        return any(t in dtype.upper() for t in ["VARCHAR", "TEXT", "STRING", "CHAR"])

    def _analyze_string_shape(self, schema: str, table: str, column: str) -> tuple[int | None, int | None, float | None, dict | None]:
        try:
            result = self.conn.execute(f"""
                SELECT MIN(LENGTH(CAST("{column}" AS VARCHAR)), MAX(LENGTH(CAST("{column}" AS VARCHAR)),
                       AVG(LENGTH(CAST("{column}" AS VARCHAR)),
                       SUM(LENGTH(REGEXP_REPLACE(CAST("{column}" AS VARCHAR), '[^a-zA-Z]', '', 'g')))::DOUBLE /
                           NULLIF(SUM(LENGTH(CAST("{column}" AS VARCHAR))), 0),
                       SUM(LENGTH(REGEXP_REPLACE(CAST("{column}" AS VARCHAR), '[^0-9]', '', 'g')))::DOUBLE /
                           NULLIF(SUM(LENGTH(CAST("{column}" AS VARCHAR))), 0)
                FROM (SELECT "{column}" FROM {schema}."{table}" WHERE "{column}" IS NOT NULL LIMIT {STRING_SHAPE_SAMPLE_SIZE}) sample
            """).fetchone()
            if not result:
                return None, None, None, None
            min_len, max_len = self._safe_int(result[0]), self._safe_int(result[1])
            avg_len = self._safe_float(result[2])
            alpha_ratio = self._safe_float(result[3]) or 0.0
            numeric_ratio = self._safe_float(result[4]) or 0.0
            special_ratio = max(0.0, 1.0 - alpha_ratio - numeric_ratio)
            return min_len, max_len, avg_len, {"alpha": round(alpha_ratio, 2), "numeric": round(numeric_ratio, 2), "special": round(special_ratio, 2)}
        except Exception:
            return None, None, None, None

    def _detect_pattern(self, sample_values: list[str] | None) -> str | None:
        if not sample_values:
            return None
        patterns = {
            "email": re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", re.IGNORECASE),
            "uuid": re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE),
            "url": re.compile(r"^https?://", re.IGNORECASE),
            "phone": re.compile(r"^[\+]?[(]?[0-9]{1,3}[)]?[-\s\.]?[0-9]{3}[-\s\.]?[0-9]{4,6}$"),
            "date_string": re.compile(r"^(\d{4}[-/]\d{2}[-/]\d{2}|\d{2}[-/]\d{2}[-/]\d{4}|\d{2}[-/]\d{2}[-/]\d{2})$"),
        }
        total = len(sample_values)
        for pattern_name, regex in patterns.items():
            matches = sum(1 for v in sample_values if regex.match(str(v)))
            if matches / total >= PATTERN_MATCH_THRESHOLD:
                return pattern_name
        return None

    def profile_table(self, schema: str, table: str) -> TableProfile:
        summary_df = self.conn.execute(f'SUMMARIZE {schema}."{table}"').fetchdf()
        row_count_result = self.conn.execute(f'SELECT COUNT(*) FROM {schema}."{table}"').fetchone()
        row_count = row_count_result[0] if row_count_result else 0

        columns = []
        for _, row in summary_df.iterrows():
            col_name, col_type = row["column_name"], row["column_type"]
            approx_unique = self._safe_int(row["approx_unique"])
            is_categorical = approx_unique is not None and approx_unique <= CATEGORICAL_THRESHOLD
            is_string = self._is_string_type(col_type)

            sample_values = None
            if is_categorical and approx_unique and approx_unique > 0:
                sample_values = self.get_sample_values(schema, table, col_name, limit=min(approx_unique, CATEGORICAL_SAMPLE_LIMIT))
            elif is_string:
                sample_values = self.get_sample_values(schema, table, col_name, limit=PATTERN_DETECTION_SAMPLE_SIZE)

            min_length, max_length, avg_length, char_composition, detected_pattern = None, None, None, None, None
            if is_string:
                min_length, max_length, avg_length, char_composition = self._analyze_string_shape(schema, table, col_name)
                detected_pattern = self._detect_pattern(sample_values)

            columns.append(ColumnProfile(
                name=col_name, dtype=col_type, min_value=self._safe_str(row["min"]), max_value=self._safe_str(row["max"]),
                approx_unique=approx_unique, avg=self._safe_float(row["avg"]), std=self._safe_float(row["std"]),
                q25=self._safe_float(row["q25"]), q50=self._safe_float(row["q50"]), q75=self._safe_float(row["q75"]),
                count=self._safe_int(row["count"]) or 0, null_percentage=self._safe_float(row["null_percentage"]) or 0.0,
                is_categorical=is_categorical, sample_values=sample_values,
                min_length=min_length, max_length=max_length, avg_length=avg_length,
                detected_pattern=detected_pattern, char_composition=char_composition))

        return TableProfile(name=table, row_count=row_count, columns=columns)

    def profile_schema(self, schema: str, verbose: bool = False, on_progress: ProgressCallback | None = None) -> SchemaProfile:
        progress = ProgressReporter(on_progress, enabled=on_progress is not None)
        tables = self.get_tables(schema)
        table_profiles = []
        progress(f"Found {len(tables)} tables in schema '{schema}'")

        for i, table in enumerate(tables, 1):
            try:
                profile = self.profile_table(schema, table)
                table_profiles.append(profile)
                if verbose:
                    categorical_cols = sum(1 for c in profile.columns if c.is_categorical)
                    progress(f"[{i}/{len(tables)}] Profiling: {table} -> {profile.row_count:,} rows, {len(profile.columns)} cols ({categorical_cols} categorical)")
                else:
                    progress(f"[{i}/{len(tables)}] Profiling: {table}")
            except Exception as e:
                progress(f"[{i}/{len(tables)}] Profiling: {table} -> FAILED: {e}")

        return SchemaProfile(db_id=schema, database=self.database, tables=table_profiles)

    def save_profile(self, profile: SchemaProfile, output_dir: str = "output/profiles") -> Path:
        output_path = Path(output_dir) / f"{profile.database}_{profile.db_id}_profile.json"
        output_path.parent.mkdir(parents=True, exist_ok=True)
        with open(output_path, "w") as f:
            json.dump(profile.to_dict(), f, indent=2, default=str)
        return output_path

    def load_profile(self, schema: str, profiles_dir: str = "output/profiles", database: str | None = None) -> SchemaProfile | None:
        db = database or self.database
        filepath = Path(profiles_dir) / f"{db}_{schema}_profile.json"
        if not filepath.exists():
            return None
        with open(filepath) as f:
            return SchemaProfile.from_dict(json.load(f))


# ============================================================================
# Query History Analyzer
# ============================================================================

@dataclass
class _ExtractedPatterns:
    join_counts: dict
    field_counts: dict
    predicate_counts: dict
    metric_counts: dict
    derived_column_counts: dict
    query_candidates: dict
    queries_with_joins: int = 0


class QueryHistoryAnalyzer:
    def __init__(self, motherduck_token: str | None = None, database: str = ""):
        self._db = MotherDuckConnection("", motherduck_token)
        self.database = database

    @property
    def conn(self) -> duckdb.DuckDBPyConnection:
        return self._db.conn

    def close(self):
        self._db.close()

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.close()

    def get_query_history(self, schema: str, user_name: str | None = None, days: int = 30, limit: int = 1000) -> list[dict]:
        schema_pattern = f"{self.database}.{schema}" if self.database else schema
        conditions = [f"QUERY_TEXT ILIKE '%{schema_pattern}.%'"]
        if user_name:
            conditions.append(f"USER_NAME = '{user_name}'")
        if days > 0:
            conditions.append(f"START_TIME >= NOW() - INTERVAL '{days} days'")
        where_clause = " AND ".join(conditions)

        sql = f"""
            SELECT QUERY_ID, QUERY_TEXT, USER_NAME, START_TIME, EXECUTION_TIME, QUERY_TYPE
            FROM MD_INFORMATION_SCHEMA.QUERY_HISTORY
            WHERE {where_clause}
            ORDER BY START_TIME DESC LIMIT {limit}
        """
        return self.conn.execute(sql).fetchdf().to_dict("records")

    def analyze_schema(self, schema: str, user_name: str | None = None, days: int = 30, limit: int = 1000,
                       verbose: bool = False, on_progress: ProgressCallback | None = None) -> QueryHistoryResult:
        progress = ProgressReporter(on_progress, enabled=on_progress is not None)

        if not SQLGLOT_AVAILABLE:
            return QueryHistoryResult(schema=schema, queries_analyzed=0, error="sqlglot not installed")

        progress("Fetching query history from MotherDuck...")
        try:
            queries = self.get_query_history(schema, user_name, days, limit)
            progress(f"Retrieved {len(queries)} queries matching schema '{schema}'")
        except Exception as e:
            error_msg = str(e)
            if "organization admins" in error_msg.lower():
                return QueryHistoryResult(schema=schema, queries_analyzed=0,
                                          error="Query history requires MotherDuck Business plan with organization admin access")
            return QueryHistoryResult(schema=schema, queries_analyzed=0, error=f"Failed to fetch query history: {error_msg}")

        progress("Parsing queries to extract patterns...")
        patterns = _ExtractedPatterns(join_counts={}, field_counts={}, predicate_counts={},
                                      metric_counts={}, derived_column_counts={}, query_candidates={})

        for i, q in enumerate(queries):
            query_text = q.get("query_text", "")
            if not query_text or self._is_meta_query(query_text):
                continue

            joins = extract_joins_from_sql(query_text)
            if joins:
                patterns.queries_with_joins += 1
            for join in joins:
                patterns.join_counts[join] = patterns.join_counts.get(join, 0) + 1

            for table, column, context in extract_field_usage_from_sql(query_text):
                key = (table, column)
                if key not in patterns.field_counts:
                    patterns.field_counts[key] = {"select": 0, "where": 0, "join": 0, "group_by": 0, "order_by": 0, "total": 0}
                patterns.field_counts[key][context] += 1
                patterns.field_counts[key]["total"] += 1

            for table, column, operator, pattern, raw_value in extract_predicates_from_sql(query_text):
                pred = PredicatePattern(table=table, column=column, operator=operator, value_pattern=pattern)
                if pred in patterns.predicate_counts:
                    count, examples = patterns.predicate_counts[pred]
                    if len(examples) < MAX_PREDICATE_EXAMPLES and raw_value not in examples:
                        examples.append(raw_value)
                    patterns.predicate_counts[pred] = (count + 1, examples)
                else:
                    patterns.predicate_counts[pred] = (1, [raw_value])

            for expr, alias, tables in extract_derived_metrics_from_sql(query_text):
                if expr in patterns.metric_counts:
                    count, aliases, tbls = patterns.metric_counts[expr]
                    if alias:
                        aliases.add(alias)
                    tbls.update(tables)
                    patterns.metric_counts[expr] = (count + 1, aliases, tbls)
                else:
                    patterns.metric_counts[expr] = (1, {alias} if alias else set(), set(tables))

            for alias, expression, tables, context in extract_derived_columns_from_sql(query_text):
                key = (alias.lower(), expression.lower())
                if key in patterns.derived_column_counts:
                    count, tbls, contexts = patterns.derived_column_counts[key]
                    tbls.update(tables)
                    contexts.add(context)
                    patterns.derived_column_counts[key] = (count + 1, tbls, contexts)
                else:
                    patterns.derived_column_counts[key] = (1, set(tables), {context})

            self._collect_sample(query_text, patterns)

            if (i + 1) % PROGRESS_UPDATE_INTERVAL == 0:
                progress(f"Processed {i + 1}/{len(queries)} queries...")

        min_threshold = max(MIN_OCCURRENCE_ABSOLUTE, int(len(queries) * MIN_OCCURRENCE_PERCENT / 100))
        query_samples = self._select_diverse_samples(patterns.query_candidates)

        if verbose:
            progress(f"Queries with joins: {patterns.queries_with_joins}")
            progress(f"Selected {len(query_samples)} diverse samples from {len(patterns.query_candidates)} candidates")

        return QueryHistoryResult(
            schema=schema, queries_analyzed=len(queries), database=self.database,
            joins=self._finalize_joins(patterns.join_counts, min_threshold),
            field_usage=self._finalize_field_usage(patterns.field_counts, min_threshold),
            predicates=self._finalize_predicates(patterns.predicate_counts, min_threshold),
            derived_metrics=self._finalize_metrics(patterns.metric_counts, min_threshold),
            derived_columns=self._finalize_derived_columns(patterns.derived_column_counts, min_threshold),
            query_samples=query_samples)

    def _is_meta_query(self, sql: str) -> bool:
        sql_upper = sql.upper()
        return "MD_INFORMATION_SCHEMA" in sql_upper or "METADATA." in sql_upper

    def _collect_sample(self, query_text: str, patterns: _ExtractedPatterns) -> None:
        cleaned = re.sub(r'\s+', ' ', query_text).strip()
        normalized = cleaned.lower().strip()
        tables = frozenset(extract_tables_from_sql(query_text))
        if normalized in patterns.query_candidates:
            _, existing_tables, count = patterns.query_candidates[normalized]
            patterns.query_candidates[normalized] = (cleaned, existing_tables, count + 1)
        else:
            patterns.query_candidates[normalized] = (cleaned, tables, 1)

    def _select_diverse_samples(self, candidates: dict) -> list[str]:
        if not candidates:
            return []
        candidate_list = [(query, tables, count) for query, tables, count in candidates.values()]
        candidate_list.sort(key=lambda x: x[2], reverse=True)

        selected, covered_table_combos, table_coverage_count = [], set(), {}

        def score_candidate(query: str, tables: frozenset[str], count: int) -> float:
            base_score = count
            if tables and tables not in covered_table_combos:
                base_score *= 10
            novelty_bonus = sum(2 if table_coverage_count.get(t, 0) == 0 else (1 if table_coverage_count.get(t, 0) < 3 else 0) for t in tables)
            return base_score + novelty_bonus

        while len(selected) < MAX_QUERY_SAMPLES and candidate_list:
            scored = [(score_candidate(q, t, c), q, t, c) for q, t, c in candidate_list if q not in selected]
            if not scored:
                break
            scored.sort(key=lambda x: x[0], reverse=True)
            _, best_query, best_tables, _ = scored[0]
            selected.append(best_query)
            if best_tables:
                covered_table_combos.add(best_tables)
                for t in best_tables:
                    table_coverage_count[t] = table_coverage_count.get(t, 0) + 1
            candidate_list = [(q, t, c) for q, t, c in candidate_list if q != best_query]
        return selected

    def _finalize_joins(self, join_counts: dict, min_threshold: int) -> list[JoinCondition]:
        joins_list = [j for j, count in join_counts.items() if count >= min_threshold]
        for j in joins_list:
            j.count = join_counts[j]
        return sorted(joins_list, key=lambda j: j.count, reverse=True)

    def _finalize_field_usage(self, field_counts: dict, min_threshold: int) -> list[FieldUsage]:
        field_usage_list = []
        for (table, column), counts in field_counts.items():
            if counts["total"] < min_threshold:
                continue
            usage = FieldUsage(table=table, column=column, select_count=counts["select"], where_count=counts["where"],
                               join_count=counts["join"], group_by_count=counts["group_by"],
                               order_by_count=counts["order_by"], total_count=counts["total"])
            if MIN_FIELD_IMPORTANCE_SCORE > 0 and usage.importance_score < MIN_FIELD_IMPORTANCE_SCORE:
                continue
            field_usage_list.append(usage)
        return sorted(field_usage_list, key=lambda f: f.importance_score, reverse=True)

    def _finalize_predicates(self, predicate_counts: dict, min_threshold: int) -> list[PredicatePattern]:
        predicates_list = []
        for pred, (count, examples) in predicate_counts.items():
            if count >= min_threshold:
                pred.occurrence_count = count
                pred.example_values = examples
                predicates_list.append(pred)
        return sorted(predicates_list, key=lambda p: p.occurrence_count, reverse=True)

    def _finalize_metrics(self, metric_counts: dict, min_threshold: int) -> list[DerivedMetric]:
        metrics_list = []
        for expr, (count, aliases, tables) in metric_counts.items():
            if count >= min_threshold:
                metrics_list.append(DerivedMetric(expression=expr, alias_names=list(aliases - {None}),
                                                  occurrence_count=count, tables_involved=list(tables)))
        return sorted(metrics_list, key=lambda m: m.occurrence_count, reverse=True)

    def _finalize_derived_columns(self, derived_column_counts: dict, min_threshold: int) -> list[DerivedColumnDefinition]:
        derived_list = []
        for (alias, expression), (count, tables, contexts) in derived_column_counts.items():
            if count >= min_threshold:
                derived_list.append(DerivedColumnDefinition(alias=alias, expression=expression,
                                                            tables_involved=sorted(tables), occurrence_count=count,
                                                            common_contexts=sorted(contexts)))
        return sorted(derived_list, key=lambda d: d.occurrence_count, reverse=True)

    def save_analysis(self, result: QueryHistoryResult, output_dir: str = "output/history") -> Path:
        db = result.database or self.database
        output_path = Path(output_dir) / f"{db}_{result.schema}_history.json"
        output_path.parent.mkdir(parents=True, exist_ok=True)
        with open(output_path, "w") as f:
            json.dump(result.to_dict(), f, indent=2, default=str)
        return output_path


# ============================================================================
# SQL-to-Text Translation
# ============================================================================

class SQLToTextGenerator:
    def __init__(self, api_key: str | None = None, model: str | None = None):
        self.client = create_openrouter_client(api_key)
        self.model = get_model(model)

    def translate_query(self, sql: str) -> QueryTranslation:
        prompt = f"""Translate this SQL query into TWO natural language questions:

SQL Query:
```sql
{sql}
```

Generate:
1. SHORT QUESTION (5-10 words): Concise, uses key domain terms. Good for few-shot examples.
2. LONG QUESTION (15-30 words): Detailed, fully describes what the query answers. Good for semantic search.

Respond in JSON format:
{{"short_question": "...", "long_question": "..."}}"""

        try:
            response = self.client.chat.completions.create(
                model=self.model,
                messages=[{"role": "system", "content": "You are a database expert who translates SQL queries into clear business questions. Respond only with valid JSON."},
                          {"role": "user", "content": prompt}],
                max_tokens=300, temperature=0.0)

            content = response.choices[0].message.content.strip()
            if content.startswith("```"):
                lines = content.split("\n")
                content = "\n".join(lines[1:-1] if lines[-1].startswith("```") else lines[1:])

            try:
                result = json.loads(content)
                short_question = result.get("short_question", "")
                long_question = result.get("long_question", "")
            except json.JSONDecodeError:
                short_question = content[:100] if content else "Query translation failed"
                long_question = ""

            return QueryTranslation(sql=sql, natural_language=short_question, tables_referenced=extract_tables_from_sql(sql),
                                    short_question=short_question, long_question=long_question)
        except Exception as e:
            raise RuntimeError(f"SQL translation failed: {e}") from e


# ============================================================================
# Metadata Generator (LLM Descriptions)
# ============================================================================

@dataclass
class PredicateContext:
    table_name: str
    column_name: str
    operator: str
    value_pattern: str
    occurrence_count: int
    example_values: list[str]


@dataclass
class JoinPatternContext:
    left_table: str
    left_column: str
    right_table: str
    right_column: str
    occurrence_count: int


@dataclass
class FieldUsageContext:
    table_name: str
    column_name: str
    select_count: int
    where_count: int
    join_count: int
    group_by_count: int
    order_by_count: int
    importance_score: float


@dataclass
class DerivedMetricContext:
    expression: str
    alias_names: list[str]
    occurrence_count: int
    tables_involved: list[str]


@dataclass
class DerivedColumnContext:
    alias: str
    expression: str
    tables_involved: list[str]
    occurrence_count: int
    contexts: list[str]


@dataclass
class QueryUseCaseContext:
    query_text: str
    natural_language: str
    tables_involved: list[str]


class MetadataGenerator:
    def __init__(self, api_key: str | None = None, model: str | None = None):
        self.client = create_openrouter_client(api_key)
        self.model = get_model(model)

    def _build_column_prompt(self, col: ColumnProfile, table_name: str,
                              predicates: list[PredicateContext] | None = None,
                              field_usage: FieldUsageContext | None = None,
                              join_patterns: list[JoinPatternContext] | None = None,
                              derived_columns: list[DerivedColumnContext] | None = None) -> str:
        lines = [f"Column: {col.name}", f"Table: {table_name}", f"Type: {col.dtype}"]
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
        if col.detected_pattern:
            lines.append(f"Detected pattern: {col.detected_pattern}")
        if col.avg_length is not None:
            lines.append(f"Avg length: {col.avg_length:.1f} chars")

        if field_usage:
            lines.extend(["", "Query usage from history:", f"  - Importance score: {field_usage.importance_score:.0f}"])
            usage_parts = []
            if field_usage.select_count > 0:
                usage_parts.append(f"SELECT: {field_usage.select_count}x")
            if field_usage.where_count > 0:
                usage_parts.append(f"WHERE: {field_usage.where_count}x")
            if field_usage.join_count > 0:
                usage_parts.append(f"JOIN: {field_usage.join_count}x")
            if field_usage.group_by_count > 0:
                usage_parts.append(f"GROUP BY: {field_usage.group_by_count}x")
            if usage_parts:
                lines.append(f"  - {', '.join(usage_parts)}")

        if predicates:
            lines.extend(["", "Common filter patterns from query history:"])
            for pred in predicates[:5]:
                example_str = ""
                if pred.example_values and pred.operator == "=":
                    example_str = f" (e.g., {', '.join(str(v) for v in pred.example_values[:3])})"
                lines.append(f"  - {pred.operator} {pred.value_pattern} ({pred.occurrence_count}x){example_str}")

        if join_patterns:
            lines.extend(["", "Join relationships from query history:"])
            for jp in join_patterns[:5]:
                if jp.left_table == table_name and jp.left_column == col.name:
                    lines.append(f"  - Joins to {jp.right_table}.{jp.right_column} ({jp.occurrence_count}x)")
                elif jp.right_table == table_name and jp.right_column == col.name:
                    lines.append(f"  - Joins to {jp.left_table}.{jp.left_column} ({jp.occurrence_count}x)")

        if derived_columns:
            relevant = [dc for dc in derived_columns if col.name.lower() in dc.expression.lower()]
            if relevant:
                lines.extend(["", "Common computed aliases from query history:"])
                for dc in relevant[:5]:
                    expr_preview = dc.expression[:60] + '...' if len(dc.expression) > 60 else dc.expression
                    lines.append(f"  - '{dc.alias}' = {expr_preview} ({dc.occurrence_count}x)")

        return "\n".join(lines)

    def _generate_column_description(self, col: ColumnProfile, table_name: str,
                                      predicates: list[PredicateContext] | None = None,
                                      field_usage: FieldUsageContext | None = None,
                                      join_patterns: list[JoinPatternContext] | None = None,
                                      derived_columns: list[DerivedColumnContext] | None = None) -> ColumnDescription:
        col_info = self._build_column_prompt(col, table_name, predicates, field_usage, join_patterns, derived_columns)

        history_hints = []
        if join_patterns:
            join_targets = []
            for jp in join_patterns[:3]:
                if jp.left_table == table_name and jp.left_column == col.name:
                    join_targets.append(f"{jp.right_table}.{jp.right_column}")
                elif jp.right_table == table_name and jp.right_column == col.name:
                    join_targets.append(f"{jp.left_table}.{jp.left_column}")
            if join_targets:
                history_hints.append(f"This column joins to: {', '.join(join_targets)}.")

        if predicates:
            has_equality = any(p.operator == "=" for p in predicates)
            has_comparisons = any(p.operator in (">", "<", ">=", "<=", "BETWEEN") for p in predicates)
            if has_equality and not has_comparisons:
                history_hints.append("This column is commonly filtered with exact matches, suggesting categorical values.")

        predicate_hint = ("\nNote: " + " ".join(history_hints)) if history_hints else ""

        prompt = f"""Column statistics:
{col_info}
{predicate_hint}
Write a description maximizing both conciseness and precision. Sentence fragments are ok. Never start with "This column" or "Stores".

Also classify the semantic type as one of: "identifier", "categorical", "measure", "date", "text", "flag", "foreign_key"

Respond in JSON format:
{{"description": "...", "semantic_type": "..."}}"""

        try:
            response = self.client.chat.completions.create(
                model=self.model,
                messages=[{"role": "system", "content": "You are a database documentation expert. Maximize conciseness and precision. Sentence fragments are ok. Never start with 'This column' or 'Stores'."},
                          {"role": "user", "content": prompt}],
                max_tokens=200, temperature=0.0)

            content = response.choices[0].message.content
            if "```json" in content:
                content = content.split("```json")[1].split("```")[0]
            elif "```" in content:
                content = content.split("```")[1].split("```")[0]
            data = json.loads(content.strip())
            return ColumnDescription(column_name=col.name, table_name=table_name,
                                     description=data.get("description", ""), semantic_type=data.get("semantic_type"))
        except Exception as e:
            logger.warning(f"Failed to generate description for {table_name}.{col.name}: {e}")
            return ColumnDescription(column_name=col.name, table_name=table_name,
                                     description=f"{col.dtype} column with {col.approx_unique or 'unknown'} distinct values",
                                     semantic_type="unknown")

    def _generate_table_description(self, table_name: str, columns: list[str], row_count: int,
                                     derived_metrics: list[DerivedMetricContext] | None = None,
                                     use_cases: list[QueryUseCaseContext] | None = None,
                                     join_patterns: list[JoinPatternContext] | None = None) -> str:
        joins_section = ""
        if join_patterns:
            joins_lines = ["\nCommon joins from query history:"]
            for jp in join_patterns[:5]:
                joins_lines.append(f"  - {jp.left_table}.{jp.left_column} = {jp.right_table}.{jp.right_column} ({jp.occurrence_count}x)")
            joins_section = "\n".join(joins_lines)

        metrics_section = ""
        if derived_metrics:
            metrics_lines = ["\nCommon calculations from query history:"]
            for metric in derived_metrics[:5]:
                alias_str = f" (aliased as: {', '.join(metric.alias_names[:3])})" if metric.alias_names else ""
                metrics_lines.append(f"  - {metric.expression}{alias_str} ({metric.occurrence_count}x)")
            metrics_section = "\n".join(metrics_lines)

        use_cases_section = ""
        if use_cases:
            use_cases_lines = ["\nCommon use cases from query history:"]
            for uc in use_cases[:3]:
                use_cases_lines.append(f"  - {uc.natural_language}")
            use_cases_section = "\n".join(use_cases_lines)

        prompt = f"""Table: {table_name}
Columns: {', '.join(columns)}
Row count: {row_count:,}
{joins_section}
{metrics_section}
{use_cases_section}

Write a description maximizing both conciseness and precision. Sentence fragments are ok. Never start with "This table".
If joins/metrics/use cases are provided, note key relationships or analyses.
Respond with just the description, no JSON."""

        try:
            response = self.client.chat.completions.create(
                model=self.model,
                messages=[{"role": "system", "content": "You are a database documentation expert. Maximize conciseness and precision. Sentence fragments are ok."},
                          {"role": "user", "content": prompt}],
                max_tokens=200, temperature=0.0)
            return response.choices[0].message.content.strip()
        except Exception as e:
            logger.warning(f"Failed to generate description for table {table_name}: {e}")
            return f"Table with {row_count:,} rows"

    def generate_descriptions(self, profile: SchemaProfile, verbose: bool = True, on_progress: ProgressCallback | None = None,
                              predicate_patterns: dict | None = None, derived_metrics: dict | None = None,
                              use_cases: dict | None = None, join_patterns: dict | None = None,
                              field_usage: dict | None = None, derived_columns: dict | None = None) -> SchemaDescription:
        progress = ProgressReporter(on_progress, enabled=on_progress is not None)
        tables = []

        for table_idx, table in enumerate(profile.tables, 1):
            progress(f"[{table_idx}/{len(profile.tables)}] Table: {table.name} ({len(table.columns)} columns)")

            table_metrics = derived_metrics.get(table.name) if derived_metrics else None
            table_use_cases = use_cases.get(table.name) if use_cases else None
            table_joins = join_patterns.get(table.name) if join_patterns else None
            table_derived_cols = derived_columns.get(table.name) if derived_columns else None

            progress("Generating table description...")
            col_names = [c.name for c in table.columns]
            table_desc = self._generate_table_description(table.name, col_names, table.row_count, table_metrics, table_use_cases, table_joins)

            if verbose:
                desc_preview = table_desc[:70] + "..." if len(table_desc) > 70 else table_desc
                progress(f"-> \"{desc_preview}\"")

            col_descs = []
            for col_idx, col in enumerate(table.columns, 1):
                col_predicates = predicate_patterns.get((table.name, col.name)) if predicate_patterns else None
                col_field_usage = field_usage.get((table.name, col.name)) if field_usage else None
                col_join_patterns = None
                if table_joins:
                    col_join_patterns = [jp for jp in table_joins
                                         if (jp.left_table == table.name and jp.left_column == col.name) or
                                            (jp.right_table == table.name and jp.right_column == col.name)] or None

                col_desc = self._generate_column_description(col, table.name, col_predicates, col_field_usage, col_join_patterns, table_derived_cols)
                col_descs.append(col_desc)

                if verbose and col_desc.semantic_type:
                    progress(f"Column [{col_idx}/{len(table.columns)}]: {col.name} [{col_desc.semantic_type}]")
                else:
                    progress(f"Column [{col_idx}/{len(table.columns)}]: {col.name}")

            tables.append(TableDescription(table_name=table.name, description=table_desc, columns=col_descs))

        return SchemaDescription(db_id=profile.db_id, tables=tables, database=profile.database)

    def save_descriptions(self, desc: SchemaDescription, output_dir: str = "output/descriptions") -> Path:
        filename = f"{desc.database}_{desc.db_id}_descriptions.json" if desc.database else f"{desc.db_id}_descriptions.json"
        output_path = Path(output_dir) / filename
        output_path.parent.mkdir(parents=True, exist_ok=True)
        with open(output_path, "w") as f:
            json.dump(desc.to_dict(), f, indent=2)
        return output_path


# ============================================================================
# SQL Comment Generator
# ============================================================================

def escape_sql_string(s: str) -> str:
    return s.replace("'", "''")


def quote_identifier(name: str) -> str:
    return f'"{name}"' if any(c in name for c in " ()-%/") else name


def generate_sql_comments(profile: SchemaProfile, descriptions: SchemaDescription | None = None) -> str:
    lines = [f"-- COMMENT ON statements for schema: {profile.db_id}", f"-- Database: {profile.database}", ""]
    desc_tables = {t.table_name: t for t in descriptions.tables} if descriptions else {}

    for table in profile.tables:
        desc_table = desc_tables.get(table.name)
        table_comment_parts = []
        if desc_table:
            table_comment_parts.append(desc_table.description)
        table_comment_parts.append(f"({table.row_count:,} rows)")
        table_comment = " ".join(table_comment_parts)

        lines.append(f"-- Table: {table.name}")
        lines.append(f"COMMENT ON TABLE {profile.db_id}.{quote_identifier(table.name)} IS '{escape_sql_string(table_comment)}';")
        lines.append("")

        desc_columns = {c.column_name: c for c in desc_table.columns} if desc_table else {}

        for col in table.columns:
            desc_col = desc_columns.get(col.name)
            parts = []
            if desc_col and desc_col.semantic_type:
                parts.append(f"[{desc_col.semantic_type}]")
            parts.append(desc_col.description if desc_col else f"{col.dtype} column")
            stats = [col.dtype]
            if col.approx_unique is not None:
                stats.append(f"{col.approx_unique:,} distinct")
            if col.null_percentage > 0:
                stats.append(f"{col.null_percentage:.0f}% null")
            if col.min_value is not None and col.max_value is not None:
                stats.append(f"range: {str(col.min_value)[:30]}..{str(col.max_value)[:30]}")
            if col.detected_pattern:
                stats.append(f"pattern: {col.detected_pattern}")
            parts.append(f"({', '.join(stats)})")
            col_comment = " ".join(parts)
            lines.append(f"COMMENT ON COLUMN {profile.db_id}.{quote_identifier(table.name)}.{quote_identifier(col.name)} IS '{escape_sql_string(col_comment)}';")
        lines.append("")
    return "\n".join(lines)


def save_sql_comments(profile: SchemaProfile, descriptions: SchemaDescription | None, output_dir: str = "output/sql") -> Path:
    output_path = Path(output_dir) / f"{profile.database}_{profile.db_id}_comments.sql"
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w") as f:
        f.write(generate_sql_comments(profile, descriptions))
    return output_path


def execute_sql_comments(sql: str, database: str, motherduck_token: str | None = None,
                         verbose: bool = False, on_progress: ProgressCallback | None = None) -> bool:
    progress = ProgressReporter(on_progress, enabled=on_progress is not None)
    progress("Connecting to MotherDuck...")

    with MotherDuckConnection(database, motherduck_token) as db:
        statements = [s.strip() for s in sql.split(";") if s.strip() and not s.strip().startswith("--")]
        progress(f"Executing {len(statements)} statements...")
        success_count, error_count = 0, 0

        for stmt in statements:
            try:
                db.conn.execute(stmt)
                success_count += 1
            except Exception as e:
                error_count += 1
                progress(f"ERROR: {e}")

        progress(f"Results: {success_count} successful" + (f", {error_count} failed" if error_count else ""))
        return error_count == 0


# ============================================================================
# Metadata Schema SQL Generation
# ============================================================================

def dollar_quote(s: str) -> str:
    if "$$" not in s:
        return f"$${s}$$"
    for tag in ["q", "sql", "query", "txt"]:
        marker = f"${tag}$"
        if marker not in s:
            return f"{marker}{s}{marker}"
    i = 0
    while f"$t{i}$" in s:
        i += 1
    return f"$t{i}${s}$t{i}$"


def split_sql_statements(sql: str) -> list[str]:
    statements, current, i, n = [], [], 0, len(sql)
    while i < n:
        char = sql[i]
        if char == '$':
            tag_end = i + 1
            while tag_end < n and (sql[tag_end].isalnum() or sql[tag_end] == '_'):
                tag_end += 1
            if tag_end < n and sql[tag_end] == '$':
                tag = sql[i:tag_end + 1]
                current.append(tag)
                i = tag_end + 1
                close_pos = sql.find(tag, i)
                if close_pos != -1:
                    current.append(sql[i:close_pos])
                    current.append(tag)
                    i = close_pos + len(tag)
                else:
                    current.append(sql[i:])
                    i = n
                continue
        if char == "'":
            current.append(char)
            i += 1
            while i < n:
                if sql[i] == "'":
                    current.append(sql[i])
                    i += 1
                    if i < n and sql[i] == "'":
                        current.append(sql[i])
                        i += 1
                    else:
                        break
                else:
                    current.append(sql[i])
                    i += 1
            continue
        if char == ';':
            stmt = ''.join(current).strip()
            if stmt and not stmt.startswith('--'):
                statements.append(stmt)
            current = []
            i += 1
            continue
        current.append(char)
        i += 1
    stmt = ''.join(current).strip()
    if stmt and not stmt.startswith('--'):
        statements.append(stmt)
    return statements


def generate_metadata_schema_sql(result: QueryHistoryResult, database: str) -> str:
    METADATA_SCHEMA = "metadata"
    _escape = lambda s: s.replace("'", "''")
    statements = [f"CREATE SCHEMA IF NOT EXISTS {METADATA_SCHEMA};", ""]

    # Join patterns
    statements.extend([f"-- Join patterns for schema: {result.schema}",
                       f"DROP TABLE IF EXISTS {METADATA_SCHEMA}.join_patterns;",
                       f"""CREATE TABLE {METADATA_SCHEMA}.join_patterns (
    left_table VARCHAR, left_column VARCHAR, right_table VARCHAR, right_column VARCHAR,
    occurrence_count INTEGER, schema_name VARCHAR, analyzed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);"""])
    if result.joins:
        statements.append(f"INSERT INTO {METADATA_SCHEMA}.join_patterns (left_table, left_column, right_table, right_column, occurrence_count, schema_name) VALUES")
        values = [f"    ('{_escape(j.left_table)}', '{_escape(j.left_column)}', '{_escape(j.right_table)}', '{_escape(j.right_column)}', {j.count}, '{_escape(result.schema)}')" for j in result.joins]
        statements.append(",\n".join(values) + ";")
    statements.append("")

    # Field usage
    statements.extend([f"-- Field usage for schema: {result.schema}",
                       f"DROP TABLE IF EXISTS {METADATA_SCHEMA}.field_usage;",
                       f"""CREATE TABLE {METADATA_SCHEMA}.field_usage (
    table_name VARCHAR, column_name VARCHAR, select_count INTEGER, where_count INTEGER,
    join_count INTEGER, group_by_count INTEGER, order_by_count INTEGER, total_count INTEGER,
    importance_score DOUBLE, schema_name VARCHAR, analyzed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);"""])
    if result.field_usage:
        statements.append(f"INSERT INTO {METADATA_SCHEMA}.field_usage (table_name, column_name, select_count, where_count, join_count, group_by_count, order_by_count, total_count, importance_score, schema_name) VALUES")
        values = [f"    ('{_escape(f.table)}', '{_escape(f.column)}', {f.select_count}, {f.where_count}, {f.join_count}, {f.group_by_count}, {f.order_by_count}, {f.total_count}, {f.importance_score}, '{_escape(result.schema)}')" for f in result.field_usage]
        statements.append(",\n".join(values) + ";")
    statements.append("")

    # Predicate patterns
    statements.extend([f"-- Predicate patterns for schema: {result.schema}",
                       f"DROP TABLE IF EXISTS {METADATA_SCHEMA}.predicate_patterns;",
                       f"""CREATE TABLE {METADATA_SCHEMA}.predicate_patterns (
    table_name VARCHAR, column_name VARCHAR, operator VARCHAR, value_pattern VARCHAR,
    occurrence_count INTEGER, example_values VARCHAR[], schema_name VARCHAR,
    analyzed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);"""])
    if result.predicates:
        statements.append(f"INSERT INTO {METADATA_SCHEMA}.predicate_patterns (table_name, column_name, operator, value_pattern, occurrence_count, example_values, schema_name) VALUES")
        values = []
        for p in result.predicates:
            examples_sql = "[" + ", ".join(f"'{_escape(e)}'" for e in p.example_values) + "]"
            values.append(f"    ('{_escape(p.table)}', '{_escape(p.column)}', '{_escape(p.operator)}', '{_escape(p.value_pattern)}', {p.occurrence_count}, {examples_sql}, '{_escape(result.schema)}')")
        statements.append(",\n".join(values) + ";")
    statements.append("")

    # Derived metrics
    statements.extend([f"-- Derived metrics for schema: {result.schema}",
                       f"DROP TABLE IF EXISTS {METADATA_SCHEMA}.derived_metrics;",
                       f"""CREATE TABLE {METADATA_SCHEMA}.derived_metrics (
    expression VARCHAR, alias_names VARCHAR[], occurrence_count INTEGER, tables_involved VARCHAR[],
    schema_name VARCHAR, analyzed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);"""])
    if result.derived_metrics:
        statements.append(f"INSERT INTO {METADATA_SCHEMA}.derived_metrics (expression, alias_names, occurrence_count, tables_involved, schema_name) VALUES")
        values = []
        for m in result.derived_metrics:
            aliases_sql = "[" + ", ".join(f"'{_escape(a)}'" for a in m.alias_names) + "]"
            tables_sql = "[" + ", ".join(f"'{_escape(t)}'" for t in m.tables_involved) + "]"
            values.append(f"    ('{_escape(m.expression)}', {aliases_sql}, {m.occurrence_count}, {tables_sql}, '{_escape(result.schema)}')")
        statements.append(",\n".join(values) + ";")
    statements.append("")

    # Query samples
    statements.extend([f"-- Query samples for schema: {result.schema}",
                       f"DROP TABLE IF EXISTS {METADATA_SCHEMA}.query_samples;",
                       f"""CREATE TABLE {METADATA_SCHEMA}.query_samples (
    sample_index INTEGER, query_text VARCHAR, schema_name VARCHAR,
    analyzed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);"""])
    for i, sample in enumerate(result.query_samples):
        statements.append(f"INSERT INTO {METADATA_SCHEMA}.query_samples (sample_index, query_text, schema_name) VALUES ({i}, {dollar_quote(sample)}, '{_escape(result.schema)}');")

    return "\n".join(statements)


# ============================================================================
# History Context Loaders
# ============================================================================

_history_cache: dict[str, QueryHistoryResult | None] = {}


def _load_history_from_json(schema: str, history_dir: str = "output/history", database: str | None = None) -> QueryHistoryResult | None:
    cache_key = f"{history_dir}/{database}/{schema}"
    if cache_key in _history_cache:
        return _history_cache[cache_key]

    json_path = Path(history_dir) / (f"{database}_{schema}_history.json" if database else f"{schema}_history.json")
    if not json_path.exists():
        _history_cache[cache_key] = None
        return None

    with open(json_path) as f:
        result = QueryHistoryResult.from_dict(json.load(f))
    _history_cache[cache_key] = result
    return result


def load_predicate_patterns(schema: str, token: str | None = None, history_dir: str = "output/history", database: str | None = None) -> dict[tuple[str, str], list[PredicateContext]]:
    token = token or os.environ.get("MOTHERDUCK_TOKEN")
    if not token:
        return {}

    try:
        conn = duckdb.connect(f"md:?motherduck_token={token}")
        result = conn.execute("SELECT table_name, column_name, operator, value_pattern, occurrence_count, example_values FROM metadata.predicate_patterns WHERE schema_name = ? ORDER BY occurrence_count DESC", [schema]).fetchall()
        conn.close()
        patterns = {}
        for row in result:
            key = (row[0], row[1])
            ctx = PredicateContext(table_name=row[0], column_name=row[1], operator=row[2], value_pattern=row[3], occurrence_count=row[4], example_values=row[5] or [])
            patterns.setdefault(key, []).append(ctx)
        return patterns
    except Exception:
        history = _load_history_from_json(schema, history_dir, database)
        if history and history.predicates:
            patterns = {}
            for pred in history.predicates:
                key = (pred.table, pred.column)
                ctx = PredicateContext(table_name=pred.table, column_name=pred.column, operator=pred.operator, value_pattern=pred.value_pattern, occurrence_count=pred.occurrence_count, example_values=pred.example_values or [])
                patterns.setdefault(key, []).append(ctx)
            return patterns
        return {}


def load_join_patterns(schema: str, token: str | None = None, history_dir: str = "output/history", database: str | None = None) -> dict[str, list[JoinPatternContext]]:
    token = token or os.environ.get("MOTHERDUCK_TOKEN")
    if not token:
        return {}

    try:
        conn = duckdb.connect(f"md:?motherduck_token={token}")
        result = conn.execute("SELECT left_table, left_column, right_table, right_column, occurrence_count FROM metadata.join_patterns WHERE schema_name = ? ORDER BY occurrence_count DESC", [schema]).fetchall()
        conn.close()
        patterns = {}
        for row in result:
            ctx = JoinPatternContext(left_table=row[0], left_column=row[1], right_table=row[2], right_column=row[3], occurrence_count=row[4])
            for table in [row[0], row[2]]:
                patterns.setdefault(table, []).append(ctx)
        return patterns
    except Exception:
        history = _load_history_from_json(schema, history_dir, database)
        if history and history.joins:
            patterns = {}
            for join in history.joins:
                ctx = JoinPatternContext(left_table=join.left_table, left_column=join.left_column, right_table=join.right_table, right_column=join.right_column, occurrence_count=join.count)
                for table in [join.left_table, join.right_table]:
                    patterns.setdefault(table, []).append(ctx)
            return patterns
        return {}


def load_field_usage(schema: str, token: str | None = None, history_dir: str = "output/history", database: str | None = None) -> dict[tuple[str, str], FieldUsageContext]:
    token = token or os.environ.get("MOTHERDUCK_TOKEN")
    if not token:
        return {}

    try:
        conn = duckdb.connect(f"md:?motherduck_token={token}")
        result = conn.execute("SELECT table_name, column_name, select_count, where_count, join_count, group_by_count, order_by_count, importance_score FROM metadata.field_usage WHERE schema_name = ? ORDER BY importance_score DESC", [schema]).fetchall()
        conn.close()
        return {(row[0], row[1]): FieldUsageContext(table_name=row[0], column_name=row[1], select_count=row[2], where_count=row[3], join_count=row[4], group_by_count=row[5], order_by_count=row[6], importance_score=row[7]) for row in result}
    except Exception:
        history = _load_history_from_json(schema, history_dir, database)
        if history and history.field_usage:
            return {(f.table, f.column): FieldUsageContext(table_name=f.table, column_name=f.column, select_count=f.select_count, where_count=f.where_count, join_count=f.join_count, group_by_count=f.group_by_count, order_by_count=f.order_by_count, importance_score=f.importance_score) for f in history.field_usage}
        return {}


def load_derived_metrics(schema: str, token: str | None = None, history_dir: str = "output/history", database: str | None = None) -> dict[str, list[DerivedMetricContext]]:
    token = token or os.environ.get("MOTHERDUCK_TOKEN")
    if not token:
        return {}

    try:
        conn = duckdb.connect(f"md:?motherduck_token={token}")
        result = conn.execute("SELECT expression, alias_names, occurrence_count, tables_involved FROM metadata.derived_metrics WHERE schema_name = ? ORDER BY occurrence_count DESC", [schema]).fetchall()
        conn.close()
        metrics = {}
        for row in result:
            tables = row[3] or []
            if not tables:
                continue
            ctx = DerivedMetricContext(expression=row[0], alias_names=row[1] or [], occurrence_count=row[2], tables_involved=tables)
            for table in tables:
                metrics.setdefault(table, []).append(ctx)
        return metrics
    except Exception:
        history = _load_history_from_json(schema, history_dir, database)
        if history and history.derived_metrics:
            metrics = {}
            for m in history.derived_metrics:
                ctx = DerivedMetricContext(expression=m.expression, alias_names=m.alias_names or [], occurrence_count=m.occurrence_count, tables_involved=m.tables_involved or [])
                for table in m.tables_involved or []:
                    metrics.setdefault(table, []).append(ctx)
            return metrics
        return {}


def load_derived_columns(schema: str, history_dir: str = "output/history", database: str | None = None) -> dict[str, list[DerivedColumnContext]]:
    history = _load_history_from_json(schema, history_dir, database)
    if not history or not history.derived_columns:
        return {}
    columns = {}
    for dc in history.derived_columns:
        ctx = DerivedColumnContext(alias=dc.alias, expression=dc.expression, tables_involved=dc.tables_involved or [], occurrence_count=dc.occurrence_count, contexts=dc.common_contexts or [])
        for table in dc.tables_involved or []:
            columns.setdefault(table, []).append(ctx)
    return columns


def load_query_samples(schema: str, token: str | None = None, history_dir: str = "output/history", database: str | None = None) -> list[str]:
    token = token or os.environ.get("MOTHERDUCK_TOKEN")
    if not token:
        return []

    try:
        conn = duckdb.connect(f"md:?motherduck_token={token}")
        result = conn.execute("SELECT query_text FROM metadata.query_samples WHERE schema_name = ? ORDER BY sample_index", [schema]).fetchall()
        conn.close()
        return [row[0] for row in result]
    except Exception:
        history = _load_history_from_json(schema, history_dir, database)
        return history.query_samples if history else []


def generate_use_cases(query_samples: list[str], model: str | None = None, max_samples: int = MAX_QUERY_SAMPLES,
                       schema: str | None = None, output_dir: str = "output/use_cases",
                       database: str | None = None) -> dict[str, list[QueryUseCaseContext]]:
    if not query_samples:
        return {}

    generator = SQLToTextGenerator(model=model)
    use_cases = {}
    all_translations = []

    for sql in query_samples[:max_samples]:
        try:
            translation = generator.translate_query(sql)
            tables = extract_tables_from_sql(sql)
            ctx = QueryUseCaseContext(query_text=sql, natural_language=translation.natural_language, tables_involved=tables)
            all_translations.append({"query": sql, "natural_language": translation.natural_language, "tables": tables})
            for table in tables:
                use_cases.setdefault(table, []).append(ctx)
        except Exception as e:
            logger.warning(f"Failed to translate query: {e}")

    if schema and all_translations:
        output_path = Path(output_dir)
        output_path.mkdir(parents=True, exist_ok=True)
        output_file = output_path / (f"{database}_{schema}_use_cases.json" if database else f"{schema}_use_cases.json")
        with open(output_file, "w") as f:
            json.dump({"schema": schema, "database": database, "use_cases": all_translations}, f, indent=2)

    return use_cases


# ============================================================================
# CLI Commands
# ============================================================================

def cmd_history(args):
    """Analyze query history for a schema to discover patterns."""
    load_dotenv()

    print(f"\n{'='*60}")
    print(f"HISTORY: Analyzing query patterns for schema '{args.schema}'")
    print(f"{'='*60}")
    print(f"  Database: {args.database}")
    print(f"  Time range: Last {args.days} days")
    print(f"  Query limit: {args.limit}")
    print()

    progress_cb = print_progress if args.verbose else None

    print("Connecting to MotherDuck...")
    with QueryHistoryAnalyzer(database=args.database) as analyzer:
        print("  Querying MD_INFORMATION_SCHEMA.QUERY_HISTORY...")
        result = analyzer.analyze_schema(schema=args.schema, days=args.days, limit=args.limit,
                                         verbose=args.verbose, on_progress=progress_cb)

        if result.error:
            print(f"Error: {result.error}")
            return 1

        print(f"\nAnalysis complete:")
        print(f"  Queries analyzed: {result.queries_analyzed}")
        print(f"  Unique join patterns: {len(result.joins)}")
        print(f"  Field usage patterns: {len(result.field_usage)}")
        print(f"  Predicate patterns: {len(result.predicates)}")
        print(f"  Derived metrics: {len(result.derived_metrics)}")
        print(f"  Query samples: {len(result.query_samples)}")

        output_path = analyzer.save_analysis(result, args.output_dir + "/history")
        print(f"\nSaved analysis to: {output_path}")

        # Translate query samples to natural language (independent of -x)
        translations = []
        if args.translate and result.query_samples:
            print("\nTranslating query samples to natural language...")
            print(f"  Model: {args.model}")
            generator = SQLToTextGenerator(model=args.model)
            for i, sql_text in enumerate(result.query_samples):
                try:
                    translation = generator.translate_query(sql_text)
                    translations.append(translation)
                    if args.verbose:
                        print(f"  [{i+1}/{len(result.query_samples)}] {translation.natural_language[:50]}...")
                    else:
                        print(f"  [{i+1}/{len(result.query_samples)}] Translated")
                except Exception as e:
                    print(f"  [{i+1}/{len(result.query_samples)}] Failed: {e}")
            print(f"  Translated {len(translations)} queries")

            # Save translations to JSON
            translations_output = {
                "schema": args.schema,
                "database": args.database,
                "translations": [t.to_dict() for t in translations]
            }
            translations_path = Path(args.output_dir) / "translations" / f"{args.database}_{args.schema}_translations.json"
            translations_path.parent.mkdir(parents=True, exist_ok=True)
            with open(translations_path, "w") as f:
                json.dump(translations_output, f, indent=2)
            print(f"  Saved translations to: {translations_path}")

        # Store results in metadata schema (optional with -x)
        if args.execute:
            print("\nStoring results in metadata schema...")
            sql = generate_metadata_schema_sql(result, args.database)
            sql_path = Path(args.output_dir) / "sql" / f"{args.database}_{result.schema}_metadata.sql"
            sql_path.parent.mkdir(parents=True, exist_ok=True)
            with open(sql_path, "w") as f:
                f.write(sql)
            print(f"  SQL saved to: {sql_path}")

            with MotherDuckConnection("") as db:
                for statement in split_sql_statements(sql):
                    try:
                        db.conn.execute(statement)
                    except Exception as e:
                        print(f"  Warning: {e}")
            print("  Metadata tables created in 'metadata' schema")

            # Store translations in database if we have them
            if translations:
                print("  Storing translations in metadata.query_use_cases...")
                use_case_sql = ["\n-- Query use cases", "DROP TABLE IF EXISTS metadata.query_use_cases;",
                                """CREATE TABLE metadata.query_use_cases (
    sample_index INTEGER, query_text VARCHAR, natural_language VARCHAR,
    tables_referenced VARCHAR[], schema_name VARCHAR);"""]
                for i, t in enumerate(translations):
                    tables_array = "[" + ", ".join(f"'{tbl}'" for tbl in t.tables_referenced) + "]"
                    use_case_sql.append(f"INSERT INTO metadata.query_use_cases VALUES ({i}, {dollar_quote(t.sql)}, '{escape_sql_string(t.natural_language)}', {tables_array}, '{args.schema}');")

                with MotherDuckConnection("") as db:
                    for statement in split_sql_statements("\n".join(use_case_sql)):
                        try:
                            db.conn.execute(statement)
                        except Exception as e:
                            print(f"  Warning: {e}")
                print(f"  Stored {len(translations)} use cases in metadata.query_use_cases")

    return 0


def cmd_generate(args):
    """Full pipeline: profile -> describe -> SQL."""
    load_dotenv()

    print(f"\n{'='*60}")
    print(f"GENERATE: Full metadata pipeline for schema '{args.schema}'")
    print(f"{'='*60}")
    print(f"  Database: {args.database}")
    print(f"  Output directory: {args.output_dir}")
    print(f"  LLM model: {args.model}")
    print(f"  With history: {'Yes' if args.with_history else 'No'}")
    print(f"  Execute SQL: {'Yes' if args.execute else 'No'}")
    print()

    progress_cb = print_progress if args.verbose else None

    # Step 1: Profile
    print("=" * 40)
    print("STEP 1/4: Profiling schema")
    print("=" * 40)
    with DatabaseProfiler(database=args.database) as profiler:
        profile = profiler.profile_schema(args.schema, verbose=args.verbose, on_progress=progress_cb)
        profile_path = profiler.save_profile(profile, args.output_dir + "/profiles")

    if not profile.tables:
        print("Error: No tables found in schema")
        return 1

    total_cols = sum(len(t.columns) for t in profile.tables)
    print(f"\n  Profile complete: {len(profile.tables)} tables, {total_cols} columns")
    print(f"  Saved to: {profile_path}")

    # Step 2: Describe
    print()
    print("=" * 40)
    print("STEP 2/4: Generating LLM descriptions")
    print("=" * 40)

    predicate_patterns, derived_metrics, derived_columns, use_cases, join_patterns, field_usage = None, None, None, None, None, None
    if args.with_history:
        print("  Loading query history context...")
        predicate_patterns = load_predicate_patterns(args.schema, database=args.database)
        derived_metrics = load_derived_metrics(args.schema, database=args.database)
        derived_columns = load_derived_columns(args.schema, database=args.database)
        join_patterns = load_join_patterns(args.schema, database=args.database)
        field_usage = load_field_usage(args.schema, database=args.database)
        query_samples = load_query_samples(args.schema, database=args.database)

        if predicate_patterns:
            print(f"    Predicate patterns: {len(predicate_patterns)} columns")
        if derived_metrics:
            print(f"    Derived metrics: {len(derived_metrics)} tables")
        if derived_columns:
            print(f"    Derived columns: {len(derived_columns)} tables")
        if join_patterns:
            print(f"    Join patterns: {len(join_patterns)} tables")
        if field_usage:
            print(f"    Field usage: {len(field_usage)} columns")
        if query_samples:
            print(f"    Query samples: {len(query_samples)} queries")
            print("    Translating query samples to use cases...")
            use_cases = generate_use_cases(query_samples, model=args.model, schema=args.schema,
                                           output_dir=args.output_dir + "/use_cases", database=args.database)
            if use_cases:
                print(f"    Generated use cases for {len(use_cases)} tables")
        if not any([predicate_patterns, derived_metrics, derived_columns, use_cases, join_patterns, field_usage]):
            print("    No history data found (run 'history -x' first)")

    try:
        print(f"  Initializing LLM client...")
        generator = MetadataGenerator(model=args.model)
        print(f"  Model: {args.model}")
        print()
        descriptions = generator.generate_descriptions(profile, verbose=args.verbose, on_progress=progress_cb,
                                                        predicate_patterns=predicate_patterns, derived_metrics=derived_metrics,
                                                        use_cases=use_cases, join_patterns=join_patterns,
                                                        field_usage=field_usage, derived_columns=derived_columns)
        desc_path = generator.save_descriptions(descriptions, args.output_dir + "/descriptions")
        print(f"\n  Saved descriptions to: {desc_path}")
    except ValueError as e:
        print(f"  Skipping descriptions: {e}")
        descriptions = None

    # Step 3: Generate SQL
    print()
    print("=" * 40)
    print("STEP 3/4: Generating SQL COMMENT statements")
    print("=" * 40)
    sql = generate_sql_comments(profile, descriptions)
    sql_path = save_sql_comments(profile, descriptions, args.output_dir + "/sql")
    stmt_count = len([s for s in sql.split(";") if s.strip() and not s.strip().startswith("--")])
    print(f"  Generated {stmt_count} COMMENT statements")
    print(f"  Saved to: {sql_path}")

    # Step 4: Execute
    if args.execute:
        print()
        print("=" * 40)
        print("STEP 4/4: Executing SQL on MotherDuck")
        print("=" * 40)
        success = execute_sql_comments(sql, database=args.database, verbose=args.verbose, on_progress=progress_cb)
        if not success:
            print("  Some statements failed!")
            return 1
    else:
        print()
        print("=" * 40)
        print("STEP 4/4: Skipping SQL execution")
        print("=" * 40)
        print("  Use --execute (-x) to apply comments to MotherDuck")

    print()
    print("=" * 60)
    print("COMPLETE: Metadata generation finished")
    print("=" * 60)
    print(f"  Schema: {args.schema}")
    print(f"  Tables: {len(profile.tables)}")
    print(f"  Columns: {total_cols}")
    print(f"  SQL statements: {stmt_count}")
    if args.execute:
        print(f"  Applied to: md:{args.database}")

    return 0


def main():
    parser = argparse.ArgumentParser(
        prog="metadata-generator",
        description="Automatic Metadata Extraction for Text-to-SQL (arXiv:2505.19988)")
    parser.add_argument("--database", "-d", default="bird_bench", help="MotherDuck database name")
    parser.add_argument("--output-dir", "-o", default="output", help="Output directory")
    parser.add_argument("--verbose", "-v", action="store_true", help="Verbose output")

    subparsers = parser.add_subparsers(dest="command", help="Commands")

    # history command
    history_parser = subparsers.add_parser("history", help="Analyze query history to discover patterns")
    history_parser.add_argument("schema", help="Schema name to analyze")
    history_parser.add_argument("--days", type=int, default=30, help="Days to look back (default: 30)")
    history_parser.add_argument("--limit", type=int, default=1000, help="Max queries to analyze (default: 1000)")
    history_parser.add_argument("--execute", "-x", action="store_true", help="Store results in metadata schema")
    history_parser.add_argument("--translate", "-t", action="store_true", help="Translate query samples to natural language")
    history_parser.add_argument("--model", default=DEFAULT_LLM_MODEL, help="LLM model for translation")

    # generate command
    generate_parser = subparsers.add_parser("generate", help="Full pipeline: profile -> describe -> SQL")
    generate_parser.add_argument("schema", help="Schema name")
    generate_parser.add_argument("--model", default=DEFAULT_LLM_MODEL, help="LLM model to use")
    generate_parser.add_argument("--execute", "-x", action="store_true", help="Execute SQL statements")
    generate_parser.add_argument("--with-history", action="store_true", help="Use query history context for better descriptions")

    args = parser.parse_args()

    if args.command == "history":
        return cmd_history(args)
    elif args.command == "generate":
        return cmd_generate(args)
    else:
        parser.print_help()
        return 1


if __name__ == "__main__":
    exit(main())
