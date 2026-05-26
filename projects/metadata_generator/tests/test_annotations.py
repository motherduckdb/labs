"""Tests for annotations module."""

import pytest
import textwrap
from pathlib import Path

from metadata_generator.annotations import (
    SchemaAnnotations,
    TableAnnotation,
    load_annotations,
    validate_annotations,
)
from metadata_generator.models import (
    ColumnProfile,
    TableProfile,
    SchemaProfile,
)
from metadata_generator.sql import generate_sql_comments


@pytest.fixture
def tmp_yaml(tmp_path):
    """Helper to write a YAML file and return its path."""
    def _write(content: str) -> Path:
        p = tmp_path / "annotations.yaml"
        p.write_text(textwrap.dedent(content))
        return p
    return _write


@pytest.fixture
def sample_profile():
    """A simple profile for testing."""
    return SchemaProfile(
        db_id="myschema",
        database="mydb",
        tables=[
            TableProfile(
                name="orders",
                row_count=1000,
                columns=[
                    ColumnProfile(name="id", dtype="BIGINT", approx_unique=1000),
                    ColumnProfile(name="status", dtype="VARCHAR", approx_unique=3,
                                  is_categorical=True,
                                  sample_values=["pending", "shipped", "delivered"]),
                    ColumnProfile(name="rate", dtype="DECIMAL", min_value="0", max_value="500"),
                    ColumnProfile(name="blob_col", dtype="BLOB"),
                ],
            ),
            TableProfile(
                name="customers",
                row_count=200,
                columns=[
                    ColumnProfile(name="cust_id", dtype="BIGINT", approx_unique=200),
                    ColumnProfile(name="tier", dtype="VARCHAR", approx_unique=3,
                                  is_categorical=True,
                                  sample_values=["Gold", "Silver", "Bronze"]),
                ],
            ),
        ],
    )


class TestLoadAnnotations:
    """Tests for load_annotations()."""

    def test_valid_yaml_roundtrip(self, tmp_yaml):
        """Valid YAML with tables and columns loads correctly."""
        p = tmp_yaml("""\
            tables:
              orders:
                annotation: "Core transactional table"
                columns:
                  status: "NULL = matches all"
                  rate: "Basis points. rate=75 means 0.75%"
              customers:
                columns:
                  tier: "Gold/Silver/Bronze. Determines discount."
        """)
        ann = load_annotations(p)

        assert len(ann.tables) == 2
        assert ann.get_table_annotation("orders") == "Core transactional table"
        assert ann.get_column_annotation("orders", "status") == "NULL = matches all"
        assert ann.get_column_annotation("orders", "rate") == "Basis points. rate=75 means 0.75%"
        assert ann.get_table_annotation("customers") is None
        assert ann.get_column_annotation("customers", "tier") == "Gold/Silver/Bronze. Determines discount."

    def test_missing_file_error(self, tmp_path):
        """Missing file raises FileNotFoundError."""
        with pytest.raises(FileNotFoundError):
            load_annotations(tmp_path / "nonexistent.yaml")

    def test_malformed_yaml_error(self, tmp_yaml):
        """Invalid YAML raises an error."""
        p = tmp_yaml("tables: [not, a, mapping")
        with pytest.raises(Exception):  # yaml.YAMLError or ValueError
            load_annotations(p)

    def test_empty_yaml(self, tmp_yaml):
        """Empty YAML file returns empty annotations."""
        p = tmp_yaml("")
        ann = load_annotations(p)
        assert len(ann.tables) == 0

    def test_string_shorthand(self, tmp_yaml):
        """Table with string value is treated as table annotation."""
        p = tmp_yaml("""\
            tables:
              orders: "Core table"
        """)
        ann = load_annotations(p)
        assert ann.get_table_annotation("orders") == "Core table"
        assert ann.tables["orders"].columns == {}


class TestValidateAnnotations:
    """Tests for validate_annotations()."""

    def test_unknown_table_warning(self, sample_profile):
        """Unknown table name produces a warning."""
        ann = SchemaAnnotations(tables={
            "nonexistent": TableAnnotation(annotation="Some text"),
        })
        warnings = validate_annotations(ann, sample_profile)
        assert any("Unknown table 'nonexistent'" in w for w in warnings)

    def test_unknown_column_warning(self, sample_profile):
        """Unknown column name produces a warning."""
        ann = SchemaAnnotations(tables={
            "orders": TableAnnotation(columns={"nonexistent_col": "Some text"}),
        })
        warnings = validate_annotations(ann, sample_profile)
        assert any("Unknown column 'orders.nonexistent_col'" in w for w in warnings)

    def test_empty_annotation_warning(self, sample_profile):
        """Empty annotation produces a warning."""
        ann = SchemaAnnotations(tables={
            "orders": TableAnnotation(columns={"status": "   "}),
        })
        warnings = validate_annotations(ann, sample_profile)
        assert any("empty or whitespace" in w for w in warnings)

    def test_too_long_annotation_warning(self, sample_profile):
        """Annotation exceeding max length produces a warning."""
        ann = SchemaAnnotations(tables={
            "orders": TableAnnotation(columns={"status": "x" * 201}),
        })
        warnings = validate_annotations(ann, sample_profile)
        assert any("exceeds max length" in w for w in warnings)

    def test_restated_column_name_warning(self, sample_profile):
        """Annotation that just restates the column name produces a warning."""
        ann = SchemaAnnotations(tables={
            "orders": TableAnnotation(columns={"status": "The status value"}),
        })
        warnings = validate_annotations(ann, sample_profile)
        assert any("restate the column name" in w for w in warnings)

    def test_valid_annotations_pass_clean(self, sample_profile):
        """Valid annotations produce no warnings."""
        ann = SchemaAnnotations(tables={
            "orders": TableAnnotation(
                annotation="Core transactional table",
                columns={
                    "status": "NULL = matches all regions",
                    "rate": "Basis points. rate=75 means 0.75%",
                },
            ),
        })
        warnings = validate_annotations(ann, sample_profile)
        assert warnings == []


class TestAnnotationMerge:
    """Tests for annotation merging in SQL generation."""

    def test_table_annotation_appended_to_facts(self, sample_profile):
        """Table annotation is appended to facts with '. ' separator."""
        ann = SchemaAnnotations(tables={
            "orders": TableAnnotation(annotation="Core transactional table"),
        })
        sql = generate_sql_comments(sample_profile, facts_only=True, annotations=ann)

        # Should contain facts + annotation
        assert "Core transactional table" in sql
        # The table comment should have the fact part followed by the annotation
        assert ". Core transactional table" in sql

    def test_column_annotation_appended_to_facts(self, sample_profile):
        """Column annotation is appended to facts with '. ' separator."""
        ann = SchemaAnnotations(tables={
            "orders": TableAnnotation(columns={
                "status": "NULL = matches all regions",
            }),
        })
        sql = generate_sql_comments(sample_profile, facts_only=True, annotations=ann)

        assert "NULL = matches all regions" in sql
        # Should have facts before annotation
        assert ". NULL = matches all regions" in sql

    def test_column_annotation_with_empty_facts(self, sample_profile):
        """Column with no facts but an annotation uses annotation as-is."""
        ann = SchemaAnnotations(tables={
            "orders": TableAnnotation(columns={
                "blob_col": "Binary image data from legacy system",
            }),
        })
        sql = generate_sql_comments(sample_profile, facts_only=True, annotations=ann)

        # blob_col normally has no facts and is skipped; with annotation it appears
        assert "COMMENT ON COLUMN myschema.orders.blob_col" in sql
        assert "Binary image data from legacy system" in sql

    def test_no_annotations_unchanged_output(self, sample_profile):
        """No annotations means output is identical to without annotations."""
        sql_without = generate_sql_comments(sample_profile, facts_only=True)
        sql_with = generate_sql_comments(sample_profile, facts_only=True, annotations=None)
        assert sql_without == sql_with

    def test_annotation_with_single_quotes_escaped(self, sample_profile):
        """Single quotes in annotations are properly escaped in SQL."""
        ann = SchemaAnnotations(tables={
            "orders": TableAnnotation(columns={
                "status": "Status of the order. Use 'active' for live orders",
            }),
        })
        sql = generate_sql_comments(sample_profile, facts_only=True, annotations=ann)

        # Single quotes should be escaped
        assert "''active''" in sql

    def test_description_mode_table_annotation(self, sample_profile):
        """Table annotation works in description (non-facts) mode too."""
        ann = SchemaAnnotations(tables={
            "orders": TableAnnotation(annotation="Core transactional table"),
        })
        sql = generate_sql_comments(sample_profile, facts_only=False, annotations=ann)

        assert ". Core transactional table" in sql

    def test_description_mode_column_annotation(self, sample_profile):
        """Column annotation works in description (non-facts) mode too."""
        ann = SchemaAnnotations(tables={
            "orders": TableAnnotation(columns={
                "rate": "Basis points. rate=75 means 0.75%",
            }),
        })
        sql = generate_sql_comments(sample_profile, facts_only=False, annotations=ann)

        assert "Basis points. rate=75 means 0.75%" in sql


class TestLoadAnnotationsEdgeCases:
    """Edge case tests for load_annotations()."""

    def test_unknown_top_level_key_ignored(self, tmp_yaml):
        """Typo like 'table:' instead of 'tables:' is silently ignored."""
        p = tmp_yaml("""\
            table:
              orders:
                annotation: "Core table"
        """)
        ann = load_annotations(p)
        # 'table' is not 'tables', so nothing is loaded
        assert len(ann.tables) == 0

    def test_extra_top_level_keys_with_valid_tables(self, tmp_yaml):
        """Extra keys alongside valid 'tables' key are ignored; tables still load."""
        p = tmp_yaml("""\
            version: 2
            tables:
              orders:
                annotation: "Core table"
            metadata:
              author: "test"
        """)
        ann = load_annotations(p)
        assert len(ann.tables) == 1
        assert ann.get_table_annotation("orders") == "Core table"

    def test_case_sensitive_table_lookup(self, tmp_yaml, sample_profile):
        """Table names are case-sensitive: 'Orders' != 'orders'."""
        p = tmp_yaml("""\
            tables:
              Orders:
                annotation: "Core table"
        """)
        ann = load_annotations(p)
        # Uppercase 'Orders' does not match lowercase 'orders' in profile
        assert ann.get_table_annotation("Orders") == "Core table"
        assert ann.get_table_annotation("orders") is None

    def test_case_sensitive_column_lookup(self, tmp_yaml):
        """Column names are case-sensitive: 'Status' != 'status'."""
        p = tmp_yaml("""\
            tables:
              orders:
                columns:
                  Status: "Uppercase annotation"
                  status: "Lowercase annotation"
        """)
        ann = load_annotations(p)
        assert ann.get_column_annotation("orders", "Status") == "Uppercase annotation"
        assert ann.get_column_annotation("orders", "status") == "Lowercase annotation"

    def test_numeric_annotation_value_coerced_to_string(self, tmp_yaml):
        """Numeric column annotation values are coerced to strings."""
        p = tmp_yaml("""\
            tables:
              orders:
                annotation: 42
                columns:
                  status: 100
                  rate: 3.14
        """)
        ann = load_annotations(p)
        assert ann.get_table_annotation("orders") == "42"
        assert ann.get_column_annotation("orders", "status") == "100"
        assert ann.get_column_annotation("orders", "rate") == "3.14"

    def test_boolean_annotation_value_coerced_to_string(self, tmp_yaml):
        """Boolean YAML values are coerced to strings."""
        p = tmp_yaml("""\
            tables:
              orders:
                columns:
                  status: true
        """)
        ann = load_annotations(p)
        assert ann.get_column_annotation("orders", "status") == "True"

    def test_null_table_entry(self, tmp_yaml):
        """A table entry with null value creates an empty TableAnnotation."""
        p = tmp_yaml("""\
            tables:
              orders:
        """)
        ann = load_annotations(p)
        assert "orders" in ann.tables
        assert ann.get_table_annotation("orders") is None
        assert ann.tables["orders"].columns == {}

    def test_non_mapping_root_raises_error(self, tmp_yaml):
        """YAML file containing a list instead of mapping raises ValueError."""
        p = tmp_yaml("""\
            - orders
            - customers
        """)
        with pytest.raises(ValueError, match="YAML mapping"):
            load_annotations(p)


class TestValidateAnnotationsEdgeCases:
    """Edge case tests for validate_annotations()."""

    def test_case_mismatch_table_flagged_as_unknown(self, sample_profile):
        """Table name with wrong casing is flagged as unknown."""
        ann = SchemaAnnotations(tables={
            "Orders": TableAnnotation(annotation="Core table"),
        })
        warnings = validate_annotations(ann, sample_profile)
        assert any("Unknown table 'Orders'" in w for w in warnings)

    def test_case_mismatch_column_flagged_as_unknown(self, sample_profile):
        """Column name with wrong casing is flagged as unknown."""
        ann = SchemaAnnotations(tables={
            "orders": TableAnnotation(columns={"Status": "Order status"}),
        })
        warnings = validate_annotations(ann, sample_profile)
        assert any("Unknown column 'orders.Status'" in w for w in warnings)

    def test_numeric_coerced_annotation_validates(self, sample_profile):
        """Numeric values coerced to strings pass validation normally."""
        ann = SchemaAnnotations(tables={
            "orders": TableAnnotation(columns={"status": "100"}),
        })
        warnings = validate_annotations(ann, sample_profile)
        # "100" is a valid non-empty string, should not produce length/empty warnings
        assert not any("empty" in w for w in warnings)
        assert not any("exceeds" in w for w in warnings)
