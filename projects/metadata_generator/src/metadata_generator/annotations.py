"""
Custom domain annotations for metadata comments.

Loads YAML annotation files and merges domain-expert knowledge with
auto-generated facts at SQL generation time. No LLM calls needed.

YAML format:
    tables:
      orders:
        annotation: "Core transactional table. One row per order."
        columns:
          status: "NULL = matches all regions"
          rate: "Basis points. rate=75 means 0.75%"
      customers:
        columns:
          tier: "Gold/Silver/Bronze. Determines discount level."
"""

import re
from dataclasses import dataclass, field
from pathlib import Path

import yaml

from metadata_generator.config import ANNOTATION_MAX_LENGTH
from metadata_generator.models import SchemaProfile


@dataclass
class TableAnnotation:
    """Annotations for a single table."""

    annotation: str | None = None
    columns: dict[str, str] = field(default_factory=dict)


@dataclass
class SchemaAnnotations:
    """Domain annotations for a schema, loaded from YAML."""

    tables: dict[str, TableAnnotation] = field(default_factory=dict)

    def get_table_annotation(self, table_name: str) -> str | None:
        """Get table-level annotation, or None."""
        ta = self.tables.get(table_name)
        return ta.annotation if ta else None

    def get_column_annotation(self, table_name: str, column_name: str) -> str | None:
        """Get column-level annotation, or None."""
        ta = self.tables.get(table_name)
        if ta is None:
            return None
        return ta.columns.get(column_name)


def load_annotations(path: Path) -> SchemaAnnotations:
    """
    Load annotations from a YAML file.

    Args:
        path: Path to the YAML annotations file.

    Returns:
        SchemaAnnotations parsed from the file.

    Raises:
        FileNotFoundError: If the file does not exist.
        yaml.YAMLError: If the file contains invalid YAML.
        ValueError: If the YAML structure is not a valid annotations format.
    """
    path = Path(path)
    if not path.exists():
        raise FileNotFoundError(f"Annotations file not found: {path}")

    with open(path) as f:
        raw = yaml.safe_load(f)

    if raw is None:
        return SchemaAnnotations()

    if not isinstance(raw, dict):
        raise ValueError(f"Annotations file must contain a YAML mapping, got {type(raw).__name__}")

    raw_tables = raw.get("tables", {})
    if not isinstance(raw_tables, dict):
        raise ValueError("'tables' must be a mapping")

    tables: dict[str, TableAnnotation] = {}
    for table_name, table_data in raw_tables.items():
        table_name = str(table_name)
        if table_data is None:
            tables[table_name] = TableAnnotation()
            continue
        if isinstance(table_data, str):
            tables[table_name] = TableAnnotation(annotation=table_data)
            continue
        if not isinstance(table_data, dict):
            raise ValueError(
                f"Table '{table_name}' must be a mapping or string, got {type(table_data).__name__}"
            )

        annotation = table_data.get("annotation")
        if annotation is not None:
            annotation = str(annotation)

        raw_columns = table_data.get("columns", {})
        if not isinstance(raw_columns, dict):
            raise ValueError(f"Table '{table_name}' columns must be a mapping")

        columns = {str(k): str(v) for k, v in raw_columns.items()}
        tables[table_name] = TableAnnotation(annotation=annotation, columns=columns)

    return SchemaAnnotations(tables=tables)


def validate_annotations(
    annotations: SchemaAnnotations,
    profile: SchemaProfile,
    max_length: int = ANNOTATION_MAX_LENGTH,
) -> list[str]:
    """
    Validate annotations against a schema profile.

    Returns a list of warning strings. Empty list means all clean.
    """
    warnings: list[str] = []

    # Build lookup of tables and columns in the profile
    profile_tables: dict[str, set[str]] = {}
    for table in profile.tables:
        profile_tables[table.name] = {col.name for col in table.columns}

    for table_name, table_ann in annotations.tables.items():
        # Check table exists
        if table_name not in profile_tables:
            warnings.append(f"Unknown table '{table_name}' (not found in schema)")
            continue

        # Validate table annotation
        if table_ann.annotation is not None:
            _validate_text(
                warnings, table_ann.annotation, f"Table '{table_name}' annotation", max_length
            )

        # Validate column annotations
        known_columns = profile_tables[table_name]
        for col_name, col_text in table_ann.columns.items():
            if col_name not in known_columns:
                warnings.append(
                    f"Unknown column '{table_name}.{col_name}' (not found in schema)"
                )
                continue

            _validate_text(
                warnings, col_text, f"Column '{table_name}.{col_name}' annotation", max_length
            )

            # Check if annotation just restates the column name
            if _is_restated_name(col_name, col_text):
                warnings.append(
                    f"Column '{table_name}.{col_name}' annotation appears to just "
                    f"restate the column name"
                )

    return warnings


def _validate_text(
    warnings: list[str], text: str, label: str, max_length: int
) -> None:
    """Validate a single annotation text, appending any warnings."""
    if not text or not text.strip():
        warnings.append(f"{label} is empty or whitespace-only")
        return

    if len(text) > max_length:
        warnings.append(
            f"{label} exceeds max length ({len(text)} > {max_length} chars)"
        )


def _is_restated_name(column_name: str, annotation: str) -> bool:
    """
    Check if an annotation just restates the column name.

    Heuristic: all words derived from the column name appear in the annotation,
    and the annotation adds no new substantive words.
    """
    # Split column name on common separators
    name_words = set(_split_identifier(column_name))
    if not name_words:
        return False

    # Get annotation words (lowercase, strip punctuation)
    ann_words = set()
    for word in annotation.lower().split():
        cleaned = word.strip(".,;:!?()[]{}\"'")
        if cleaned and len(cleaned) > 2:  # Skip short filler words
            ann_words.add(cleaned)

    if not ann_words:
        return False

    # Filler words that don't count as "new" content
    fillers = {
        "the", "this", "that", "is", "are", "was", "were", "for", "and",
        "of", "in", "to", "a", "an", "column", "field", "value", "values",
    }
    substantive_words = ann_words - name_words - fillers

    return len(substantive_words) == 0


def _split_identifier(name: str) -> list[str]:
    """Split an identifier into lowercase words (handles snake_case, camelCase)."""
    # First split on underscores
    parts = name.split("_")

    # Then split camelCase
    words = []
    for part in parts:
        # Insert split before uppercase letters
        sub_parts = re.sub(r"([A-Z])", r" \1", part).split()
        words.extend(w.lower() for w in sub_parts if w)

    return words
