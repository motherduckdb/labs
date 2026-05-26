"""
MotherDuck Metadata Generator

Generate rich metadata for MotherDuck databases:
- Profile statistics using DuckDB SUMMARIZE
- LLM-generated semantic descriptions
- Facts-only compact metadata (token-efficient)
- SQL COMMENT statements
- Query history analysis for join discovery
"""

from metadata_generator.models import (
    ColumnProfile,
    TableProfile,
    SchemaProfile,
    ColumnDescription,
    TableDescription,
    SchemaDescription,
)
from metadata_generator.profiler import DatabaseProfiler
from metadata_generator.generator import MetadataGenerator
from metadata_generator.sql import generate_sql_comments, save_sql_comments
from metadata_generator.history import (
    QueryHistoryAnalyzer,
    QueryHistoryResult,
    JoinCondition,
)
from metadata_generator.facts import (
    ColumnFacts,
    TableFacts,
    SchemaFacts,
    extract_column_facts,
    extract_schema_facts,
    format_column_facts,
)

__version__ = "0.1.0"

__all__ = [
    "ColumnProfile",
    "TableProfile",
    "SchemaProfile",
    "ColumnDescription",
    "TableDescription",
    "SchemaDescription",
    "DatabaseProfiler",
    "MetadataGenerator",
    "generate_sql_comments",
    "save_sql_comments",
    "QueryHistoryAnalyzer",
    "QueryHistoryResult",
    "JoinCondition",
    # Facts-only metadata
    "ColumnFacts",
    "TableFacts",
    "SchemaFacts",
    "extract_column_facts",
    "extract_schema_facts",
    "format_column_facts",
]
