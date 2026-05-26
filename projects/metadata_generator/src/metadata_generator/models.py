"""
Data models for metadata generation.
"""

from dataclasses import dataclass, asdict, field
from typing import Any


@dataclass
class ColumnProfile:
    """Profile statistics for a single column from DuckDB SUMMARIZE."""

    name: str
    dtype: str
    min_value: str | None = None
    max_value: str | None = None
    approx_unique: int | None = None
    avg: float | None = None
    std: float | None = None
    q25: float | None = None
    q50: float | None = None  # median
    q75: float | None = None
    count: int = 0
    null_percentage: float = 0.0
    is_categorical: bool = False
    sample_values: list[str] | None = None

    # String shape analysis fields
    min_length: int | None = None
    max_length: int | None = None
    avg_length: float | None = None
    detected_pattern: str | None = None  # "email", "phone", "uuid", "url", "date_string"
    char_composition: dict | None = None  # {"alpha": 0.6, "numeric": 0.3, "special": 0.1}

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ColumnProfile":
        """Create from dictionary."""
        # Filter to only known fields to handle forward compatibility
        known_fields = {f.name for f in cls.__dataclass_fields__.values()}
        filtered_data = {k: v for k, v in data.items() if k in known_fields}
        return cls(**filtered_data)


@dataclass
class ColumnSimilarity:
    """Detected similarity between two columns based on value overlap."""

    source_table: str
    source_column: str
    target_table: str
    target_column: str
    jaccard_similarity: float  # 0.0 to 1.0
    likely_relationship: str  # "foreign_key", "shared_dimension", "partial_overlap"
    source_only_values: list[str] = field(default_factory=list)
    target_only_values: list[str] = field(default_factory=list)
    source_only_count: int = 0
    target_only_count: int = 0

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ColumnSimilarity":
        """Create from dictionary."""
        known_fields = {f.name for f in cls.__dataclass_fields__.values()}
        filtered_data = {k: v for k, v in data.items() if k in known_fields}
        return cls(**filtered_data)


@dataclass
class TableProfile:
    """Profile for a single table."""

    name: str
    row_count: int
    columns: list[ColumnProfile] = field(default_factory=list)
    is_view: bool = False

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        result = {
            "name": self.name,
            "row_count": self.row_count,
            "columns": [c.to_dict() for c in self.columns],
        }
        if self.is_view:
            result["is_view"] = True
        return result

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "TableProfile":
        """Create from dictionary."""
        columns = [ColumnProfile.from_dict(c) for c in data.get("columns", [])]
        return cls(
            name=data["name"],
            row_count=data["row_count"],
            columns=columns,
            is_view=data.get("is_view", False),
        )


@dataclass
class SchemaProfile:
    """Profile for an entire schema (database)."""

    db_id: str
    database: str  # MotherDuck database name
    tables: list[TableProfile] = field(default_factory=list)
    column_similarities: list[ColumnSimilarity] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return {
            "db_id": self.db_id,
            "database": self.database,
            "tables": [t.to_dict() for t in self.tables],
            "column_similarities": [s.to_dict() for s in self.column_similarities],
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "SchemaProfile":
        """Create from dictionary."""
        tables = [TableProfile.from_dict(t) for t in data.get("tables", [])]
        similarities = [
            ColumnSimilarity.from_dict(s) for s in data.get("column_similarities", [])
        ]
        return cls(
            db_id=data["db_id"],
            database=data.get("database", ""),
            tables=tables,
            column_similarities=similarities,
        )


@dataclass
class ColumnDescription:
    """LLM-generated description for a column."""

    column_name: str
    table_name: str
    description: str
    semantic_type: str | None = None  # e.g., "identifier", "categorical", "measure"

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ColumnDescription":
        """Create from dictionary."""
        known_fields = {f.name for f in cls.__dataclass_fields__.values()}
        filtered_data = {k: v for k, v in data.items() if k in known_fields}
        return cls(**filtered_data)


@dataclass
class TableDescription:
    """LLM-generated descriptions for a table."""

    table_name: str
    description: str
    columns: list[ColumnDescription] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return {
            "table_name": self.table_name,
            "description": self.description,
            "columns": [c.to_dict() for c in self.columns],
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "TableDescription":
        """Create from dictionary."""
        columns = [ColumnDescription.from_dict(c) for c in data.get("columns", [])]
        return cls(
            table_name=data["table_name"],
            description=data["description"],
            columns=columns,
        )


@dataclass
class SchemaDescription:
    """LLM-generated descriptions for a schema."""

    db_id: str
    tables: list[TableDescription] = field(default_factory=list)
    database: str | None = None  # MotherDuck database name

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        result = {
            "db_id": self.db_id,
            "tables": [t.to_dict() for t in self.tables],
        }
        if self.database:
            result["database"] = self.database
        return result

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "SchemaDescription":
        """Create from dictionary."""
        tables = [TableDescription.from_dict(t) for t in data.get("tables", [])]
        return cls(db_id=data["db_id"], tables=tables, database=data.get("database"))


@dataclass
class QueryTranslation:
    """A SQL query with its natural language translation."""

    sql: str
    natural_language: str  # Backwards compat - same as short_question
    tables_referenced: list[str] = field(default_factory=list)
    short_question: str | None = None  # Concise (5-10 words) for few-shot prompts
    long_question: str | None = None   # Detailed (15-30 words) for semantic search

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        result = {
            "sql": self.sql,
            "natural_language": self.natural_language,
            "tables_referenced": self.tables_referenced,
        }
        if self.short_question:
            result["short_question"] = self.short_question
        if self.long_question:
            result["long_question"] = self.long_question
        return result

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "QueryTranslation":
        """Create from dictionary."""
        return cls(
            sql=data["sql"],
            natural_language=data["natural_language"],
            tables_referenced=data.get("tables_referenced", []),
            short_question=data.get("short_question"),
            long_question=data.get("long_question"),
        )


@dataclass
class TranslatedQueryHistory:
    """Collection of translated queries for a schema."""

    schema: str
    generated_at: str  # ISO format datetime
    translations: list[QueryTranslation] = field(default_factory=list)
    database: str | None = None  # MotherDuck database name

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        result = {
            "schema": self.schema,
            "generated_at": self.generated_at,
            "translations": [t.to_dict() for t in self.translations],
        }
        if self.database:
            result["database"] = self.database
        return result

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "TranslatedQueryHistory":
        """Create from dictionary."""
        translations = [
            QueryTranslation.from_dict(t) for t in data.get("translations", [])
        ]
        return cls(
            schema=data["schema"],
            generated_at=data["generated_at"],
            translations=translations,
            database=data.get("database"),
        )
