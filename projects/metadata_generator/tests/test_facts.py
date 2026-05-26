"""Tests for facts-only metadata generation in facts.py."""

import pytest

from metadata_generator.facts import (
    ColumnFacts,
    TableFacts,
    SchemaFacts,
    extract_column_facts,
    extract_schema_facts,
    format_column_facts,
    format_table_facts,
    _format_enum,
    _format_range,
    _detect_date_granularity,
    _detect_join_cardinality,
    _extract_usage_patterns,
    _extract_aggregations,
    _extract_orphan_info,
)
from metadata_generator.models import ColumnProfile, TableProfile, SchemaProfile, ColumnSimilarity
from metadata_generator.history import (
    QueryHistoryResult,
    JoinCondition,
    FieldUsage,
    PredicatePattern,
    DerivedMetric,
)


class TestColumnFacts:
    """Tests for ColumnFacts data class."""

    def test_to_dict_minimal(self):
        """ColumnFacts with minimal fields serializes correctly."""
        facts = ColumnFacts(
            table_name="users",
            column_name="id",
            dtype="BIGINT",
        )

        d = facts.to_dict()
        assert d["table_name"] == "users"
        assert d["column_name"] == "id"
        assert d["dtype"] == "BIGINT"
        assert d["null_percentage"] == 0.0
        assert d["join_targets"] == []
        assert d["filter_patterns"] == []

    def test_to_dict_full(self):
        """ColumnFacts with all fields serializes correctly."""
        facts = ColumnFacts(
            table_name="orders",
            column_name="status",
            dtype="VARCHAR",
            approx_unique=5,
            is_categorical=True,
            sample_values=["pending", "shipped", "delivered"],
            null_percentage=2.5,
            min_value="cancelled",
            max_value="shipped",
            detected_pattern=None,
            join_targets=[("order_status", "code", 100)],
            filter_patterns=[("=", 500), ("IN", 50)],
            importance_score=150.0,
        )

        d = facts.to_dict()
        assert d["is_categorical"] is True
        assert d["sample_values"] == ["pending", "shipped", "delivered"]
        assert d["join_targets"] == [("order_status", "code", 100)]
        assert d["filter_patterns"] == [("=", 500), ("IN", 50)]

    def test_from_dict_roundtrip(self):
        """ColumnFacts round-trips through dict correctly."""
        original = ColumnFacts(
            table_name="products",
            column_name="price",
            dtype="DECIMAL",
            approx_unique=500,
            null_percentage=0.0,
            min_value="0.99",
            max_value="9999.99",
        )

        d = original.to_dict()
        restored = ColumnFacts.from_dict(d)

        assert restored.table_name == original.table_name
        assert restored.column_name == original.column_name
        assert restored.dtype == original.dtype
        assert restored.min_value == original.min_value


class TestTableFacts:
    """Tests for TableFacts data class."""

    def test_to_dict(self):
        """TableFacts serializes correctly."""
        facts = TableFacts(
            table_name="users",
            row_count=1000,
            columns=[
                ColumnFacts(table_name="users", column_name="id", dtype="BIGINT"),
                ColumnFacts(table_name="users", column_name="email", dtype="VARCHAR"),
            ],
        )

        d = facts.to_dict()
        assert d["table_name"] == "users"
        assert d["row_count"] == 1000
        assert len(d["columns"]) == 2

    def test_from_dict_roundtrip(self):
        """TableFacts round-trips through dict correctly."""
        original = TableFacts(
            table_name="orders",
            row_count=5000,
            columns=[
                ColumnFacts(table_name="orders", column_name="id", dtype="BIGINT"),
            ],
        )

        d = original.to_dict()
        restored = TableFacts.from_dict(d)

        assert restored.table_name == original.table_name
        assert restored.row_count == original.row_count
        assert len(restored.columns) == 1


class TestTableFactsIsView:
    """Tests for TableFacts.is_view field."""

    def test_default_is_false(self):
        """TableFacts defaults is_view to False."""
        facts = TableFacts(table_name="users", row_count=100)
        assert facts.is_view is False

    def test_to_dict_omits_when_false(self):
        """is_view is omitted from dict when False."""
        facts = TableFacts(table_name="users", row_count=100)
        d = facts.to_dict()
        assert "is_view" not in d

    def test_to_dict_includes_when_true(self):
        """is_view is included in dict when True."""
        facts = TableFacts(table_name="team_stats", row_count=30, is_view=True)
        d = facts.to_dict()
        assert d["is_view"] is True

    def test_from_dict_without_is_view(self):
        """Backward-compatible: from_dict works without is_view key."""
        d = {"table_name": "users", "row_count": 100, "columns": []}
        facts = TableFacts.from_dict(d)
        assert facts.is_view is False

    def test_roundtrip_view(self):
        """TableFacts with is_view=True round-trips correctly."""
        original = TableFacts(table_name="stats_view", row_count=50, is_view=True)
        d = original.to_dict()
        restored = TableFacts.from_dict(d)
        assert restored.is_view is True

    def test_extract_schema_facts_passes_is_view(self):
        """extract_schema_facts propagates is_view from TableProfile."""
        profile = SchemaProfile(
            db_id="test",
            database="mydb",
            tables=[
                TableProfile(name="games", row_count=100, columns=[], is_view=False),
                TableProfile(name="team_stats", row_count=30, columns=[], is_view=True),
            ],
        )
        facts = extract_schema_facts(profile)
        assert facts.tables[0].is_view is False
        assert facts.tables[1].is_view is True


class TestSchemaFacts:
    """Tests for SchemaFacts data class."""

    def test_to_dict(self):
        """SchemaFacts serializes correctly."""
        facts = SchemaFacts(
            db_id="test_schema",
            database="test_db",
            tables=[
                TableFacts(table_name="users", row_count=100, columns=[]),
            ],
        )

        d = facts.to_dict()
        assert d["db_id"] == "test_schema"
        assert d["database"] == "test_db"
        assert len(d["tables"]) == 1

    def test_from_dict_roundtrip(self):
        """SchemaFacts round-trips through dict correctly."""
        original = SchemaFacts(
            db_id="ecommerce",
            database="mydb",
            tables=[
                TableFacts(table_name="orders", row_count=1000, columns=[]),
            ],
        )

        d = original.to_dict()
        restored = SchemaFacts.from_dict(d)

        assert restored.db_id == original.db_id
        assert restored.database == original.database


class TestDetectSemanticRole:
    """Tests for _detect_semantic_role — issues #30, #31, #32."""

    def test_contiguous_integer_range_is_measure(self):
        """Integer column with contiguous 0..N range is measure, not dimension (#32)."""
        col = ColumnProfile(
            name="error_count",
            dtype="INTEGER",
            approx_unique=15,
            is_categorical=True,
            min_value="0",
            max_value="20",
        )
        facts = extract_column_facts(col, "events", row_count=5000)
        assert facts.semantic_role == "fact"

    def test_low_cardinality_integer_range_is_measure(self):
        """Low-cardinality integer with 0..N range should be measure (#32)."""
        col = ColumnProfile(
            name="retries",
            dtype="INTEGER",
            approx_unique=11,
            is_categorical=True,
            min_value="0",
            max_value="10",
        )
        facts = extract_column_facts(col, "jobs", row_count=5000)
        assert facts.semantic_role == "fact"

    def test_another_contiguous_integer_is_measure(self):
        """Another contiguous integer range column is measure (#32)."""
        col = ColumnProfile(
            name="failures",
            dtype="INTEGER",
            approx_unique=12,
            is_categorical=True,
            min_value="0",
            max_value="12",
        )
        facts = extract_column_facts(col, "runs", row_count=5000)
        assert facts.semantic_role == "fact"

    def test_varchar_categorical_still_dimension(self):
        """String categorical columns should remain dimension."""
        col = ColumnProfile(
            name="status",
            dtype="VARCHAR",
            approx_unique=3,
            is_categorical=True,
            sample_values=["active", "pending", "closed"],
        )
        facts = extract_column_facts(col, "tasks", row_count=1000)
        assert facts.semantic_role == "dimension"

    def test_speculative_join_does_not_override_contiguous_measure(self):
        """Speculative FK from MinHash should not override measure for contiguous integer (#30)."""
        col = ColumnProfile(
            name="daily_count",
            dtype="INTEGER",
            approx_unique=15,
            is_categorical=True,
            min_value="0",
            max_value="20",
        )
        similarities = [
            ColumnSimilarity(
                source_table="metrics",
                source_column="daily_count",
                target_table="other_metrics",
                target_column="weekly_count",
                jaccard_similarity=0.95,
                likely_relationship="foreign_key",
            ),
        ]
        facts = extract_column_facts(
            col, "metrics", row_count=5000, column_similarities=similarities
        )
        assert facts.semantic_role == "fact"

    def test_confirmed_join_still_makes_fk(self):
        """Confirmed join from query history should still classify as FK."""
        col = ColumnProfile(
            name="customer_id",
            dtype="BIGINT",
            approx_unique=500,
        )
        history = QueryHistoryResult(
            schema="orders",
            queries_analyzed=100,
            joins=[
                JoinCondition(
                    left_table="orders",
                    left_column="customer_id",
                    right_table="customers",
                    right_column="id",
                    count=50,
                ),
            ],
        )
        facts = extract_column_facts(col, "orders", row_count=1000, history=history)
        assert facts.semantic_role == "fk"

    def test_id_suffix_still_fk(self):
        """Columns ending with _id should still be classified as FK."""
        col = ColumnProfile(
            name="category_id",
            dtype="INTEGER",
            approx_unique=20,
            is_categorical=True,
        )
        facts = extract_column_facts(col, "products", row_count=1000)
        assert facts.semantic_role == "fk"

    def test_non_contiguous_integer_categorical_is_dimension(self):
        """Integer column that's NOT a contiguous 0..N range stays as dimension."""
        col = ColumnProfile(
            name="priority_level",
            dtype="INTEGER",
            approx_unique=5,
            is_categorical=True,
            min_value="1",
            max_value="5",
            sample_values=["1", "2", "3", "4", "5"],
        )
        facts = extract_column_facts(col, "tickets", row_count=1000)
        # min != 0, so not contiguous range; no measure name pattern -> dimension
        assert facts.semantic_role == "dimension"

    def test_boolean_flag_is_dimension_not_measure(self):
        """Integer 0/1 boolean flag should be dimension, not measure."""
        col = ColumnProfile(
            name="is_active",
            dtype="INTEGER",
            approx_unique=2,
            is_categorical=True,
            min_value="0",
            max_value="1",
            sample_values=["0", "1"],
        )
        facts = extract_column_facts(col, "users", row_count=1000)
        assert facts.semantic_role == "dimension"

    def test_sparse_integer_codes_are_dimension(self):
        """Sparse integer codes (e.g., HTTP status codes) should be dimension."""
        col = ColumnProfile(
            name="response_code",
            dtype="INTEGER",
            approx_unique=5,
            is_categorical=True,
            min_value="200",
            max_value="500",
            sample_values=["200", "301", "404", "500"],
        )
        facts = extract_column_facts(col, "requests", row_count=10000)
        assert facts.semantic_role == "dimension"


class TestExtractColumnFacts:
    """Tests for extract_column_facts function."""

    def test_basic_extraction(self):
        """Extracts basic facts from column profile."""
        col = ColumnProfile(
            name="user_id",
            dtype="BIGINT",
            approx_unique=1000,
            null_percentage=0.0,
        )

        facts = extract_column_facts(col, "orders")

        assert facts.column_name == "user_id"
        assert facts.table_name == "orders"
        assert facts.dtype == "BIGINT"
        assert facts.approx_unique == 1000
        assert facts.null_percentage == 0.0

    def test_categorical_extraction(self):
        """Extracts categorical facts correctly."""
        col = ColumnProfile(
            name="status",
            dtype="VARCHAR",
            approx_unique=5,
            is_categorical=True,
            sample_values=["pending", "shipped", "delivered", "cancelled", "returned"],
        )

        facts = extract_column_facts(col, "orders")

        assert facts.is_categorical is True
        assert facts.sample_values == ["pending", "shipped", "delivered", "cancelled", "returned"]

    def test_extraction_with_history(self):
        """Extracts facts including query history patterns."""
        col = ColumnProfile(
            name="customer_id",
            dtype="BIGINT",
            approx_unique=500,
        )

        history = QueryHistoryResult(
            schema="orders",
            queries_analyzed=100,
            joins=[
                JoinCondition(
                    left_table="orders",
                    left_column="customer_id",
                    right_table="customers",
                    right_column="id",
                    count=50,
                ),
            ],
            predicates=[
                PredicatePattern(
                    table="orders",
                    column="customer_id",
                    operator="=",
                    value_pattern="<number>",
                    occurrence_count=30,
                ),
            ],
            field_usage=[
                FieldUsage(
                    table="orders",
                    column="customer_id",
                    select_count=20,
                    where_count=30,
                    join_count=50,
                    total_count=100,
                ),
            ],
        )

        facts = extract_column_facts(col, "orders", row_count=1000, history=history)

        assert len(facts.join_targets) == 1
        assert facts.join_targets[0] == ("customers", "id", 50)
        assert len(facts.filter_patterns) == 1
        assert facts.filter_patterns[0] == ("=", 30)
        assert facts.importance_score > 0

    def test_extraction_with_speculative_joins(self):
        """Extracts speculative joins from column similarities."""
        col = ColumnProfile(
            name="category_id",
            dtype="BIGINT",
            approx_unique=20,
        )

        similarities = [
            ColumnSimilarity(
                source_table="products",
                source_column="category_id",
                target_table="categories",
                target_column="id",
                jaccard_similarity=0.95,
                likely_relationship="foreign_key",
            ),
        ]

        facts = extract_column_facts(col, "products", history=None, column_similarities=similarities)

        assert len(facts.speculative_joins) == 1
        assert facts.speculative_joins[0][0] == "categories"
        assert facts.speculative_joins[0][1] == "id"
        assert facts.speculative_joins[0][2] == 0.95

    def test_speculative_joins_excluded_when_confirmed(self):
        """Speculative joins are excluded when already confirmed by history."""
        col = ColumnProfile(
            name="customer_id",
            dtype="BIGINT",
            approx_unique=500,
        )

        history = QueryHistoryResult(
            schema="orders",
            queries_analyzed=100,
            joins=[
                JoinCondition(
                    left_table="orders",
                    left_column="customer_id",
                    right_table="customers",
                    right_column="id",
                    count=50,
                ),
            ],
        )

        similarities = [
            ColumnSimilarity(
                source_table="orders",
                source_column="customer_id",
                target_table="customers",
                target_column="id",
                jaccard_similarity=0.92,
                likely_relationship="foreign_key",
            ),
        ]

        facts = extract_column_facts(col, "orders", row_count=1000, history=history, column_similarities=similarities)

        # Should have confirmed join but not duplicate as speculative
        assert len(facts.join_targets) == 1
        assert len(facts.speculative_joins) == 0


class TestFormatColumnFacts:
    """Tests for format_column_facts function."""

    def test_categorical_format(self):
        """Formats categorical column with values notation."""
        facts = ColumnFacts(
            table_name="orders",
            column_name="status",
            dtype="VARCHAR",
            approx_unique=5,
            is_categorical=True,
            sample_values=["pending", "shipped", "delivered", "cancelled", "returned"],
        )

        formatted = format_column_facts(facts)

        # When showing all values, no count prefix
        assert formatted.startswith("[")
        assert "pending" in formatted

    def test_null_percentage_shown_when_high(self):
        """Shows null percentage when >= threshold."""
        facts = ColumnFacts(
            table_name="users",
            column_name="phone",
            dtype="VARCHAR",
            null_percentage=15.0,
        )

        formatted = format_column_facts(facts)

        assert "null:15%" in formatted

    def test_null_percentage_hidden_when_low(self):
        """Hides null percentage when < threshold."""
        facts = ColumnFacts(
            table_name="users",
            column_name="email",
            dtype="VARCHAR",
            null_percentage=2.0,  # Below 5% threshold
        )

        formatted = format_column_facts(facts)

        assert "null:" not in formatted

    def test_join_target_format(self):
        """Formats confirmed join target with fk notation."""
        facts = ColumnFacts(
            table_name="orders",
            column_name="customer_id",
            dtype="BIGINT",
            join_targets=[("customers", "id", 500)],
        )

        formatted = format_column_facts(facts)

        assert "fk->customers.id" in formatted

    def test_speculative_join_format(self):
        """Formats speculative join with fk? notation."""
        facts = ColumnFacts(
            table_name="products",
            column_name="category_id",
            dtype="BIGINT",
            speculative_joins=[("categories", "id", 0.95)],
        )

        formatted = format_column_facts(facts)

        assert "fk?->categories.id" in formatted

    def test_confirmed_join_preferred_over_speculative(self):
        """Confirmed join is used instead of speculative when both exist."""
        facts = ColumnFacts(
            table_name="orders",
            column_name="customer_id",
            dtype="BIGINT",
            join_targets=[("customers", "id", 500)],
            speculative_joins=[("users", "id", 0.85)],
        )

        formatted = format_column_facts(facts)

        assert "fk->customers.id" in formatted
        assert "fk?->" not in formatted

    def test_filter_pattern_format(self):
        """Formats filter patterns."""
        facts = ColumnFacts(
            table_name="orders",
            column_name="status",
            dtype="VARCHAR",
            approx_unique=5,
            is_categorical=True,
            sample_values=["pending"],
            filter_patterns=[("=", 100), ("IN", 50)],
        )

        formatted = format_column_facts(facts)

        assert "filter:[=,IN]" in formatted

    def test_detected_pattern_format(self):
        """Formats detected pattern type."""
        facts = ColumnFacts(
            table_name="users",
            column_name="email",
            dtype="VARCHAR",
            detected_pattern="email",
        )

        formatted = format_column_facts(facts)

        assert "pattern:email" in formatted

    def test_range_format(self):
        """Formats value range for non-categorical columns."""
        facts = ColumnFacts(
            table_name="products",
            column_name="price",
            dtype="DECIMAL",
            min_value="0.99",
            max_value="999.99",
            is_categorical=False,
        )

        formatted = format_column_facts(facts)

        assert "range:" in formatted
        assert "0.99" in formatted
        assert "999.99" in formatted

    def test_high_cardinality_no_output(self):
        """High cardinality columns with no other facts return empty."""
        facts = ColumnFacts(
            table_name="users",
            column_name="id",
            dtype="BIGINT",
            approx_unique=50000,
            is_categorical=False,
        )

        formatted = format_column_facts(facts)

        # High cardinality doesn't help SQL generation, so skip it
        assert formatted == ""

    def test_no_facts_returns_empty(self):
        """Returns empty string when no facts available."""
        facts = ColumnFacts(
            table_name="misc",
            column_name="data",
            dtype="BLOB",
        )

        formatted = format_column_facts(facts)

        assert formatted == ""


class TestFormatHelpers:
    """Tests for formatting helper functions."""

    def test_format_enum_few_values(self):
        """Formats enum with few values showing all (no count)."""
        result = _format_enum(3, ["a", "b", "c"])
        assert result == "[a,b,c]"

    def test_format_enum_many_values(self):
        """Formats enum with many values using ellipsis."""
        values = ["a", "b", "c", "d", "e", "f", "g"]
        result = _format_enum(7, values)
        assert result == "enum(7):[a,b,c,d,e,...]"

    def test_format_enum_no_values(self):
        """Formats enum with count only when no values."""
        result = _format_enum(10, [])
        assert result == "enum(10)"

    def test_format_range_short(self):
        """Formats short range values as-is."""
        result = _format_range("0", "100")
        assert result == "range:[0,100]"

    def test_format_range_truncates_long(self):
        """Truncates long range values."""
        result = _format_range("2020-01-01 00:00:00.000", "2024-12-31 23:59:59.999")
        assert "..." in result
        assert len(result) < 50


class TestExtractSchemaFacts:
    """Tests for extract_schema_facts function."""

    def test_extracts_all_tables(self):
        """Extracts facts for all tables in schema."""
        profile = SchemaProfile(
            db_id="test",
            database="mydb",
            tables=[
                TableProfile(
                    name="users",
                    row_count=100,
                    columns=[
                        ColumnProfile(name="id", dtype="BIGINT"),
                        ColumnProfile(name="name", dtype="VARCHAR"),
                    ],
                ),
                TableProfile(
                    name="orders",
                    row_count=500,
                    columns=[
                        ColumnProfile(name="id", dtype="BIGINT"),
                    ],
                ),
            ],
        )

        facts = extract_schema_facts(profile)

        assert facts.db_id == "test"
        assert facts.database == "mydb"
        assert len(facts.tables) == 2
        assert facts.tables[0].table_name == "users"
        assert facts.tables[0].row_count == 100
        assert len(facts.tables[0].columns) == 2
        assert facts.tables[1].table_name == "orders"


class TestFormatTableFacts:
    """Tests for format_table_facts function."""

    def test_formats_table_summary(self):
        """Formats table summary with row count, pk, and joins."""
        facts = TableFacts(
            table_name="orders",
            row_count=12345,
            columns=[],
        )

        result = format_table_facts(facts)

        assert result == "12,345 rows"

    def test_formats_table_with_pk_and_joins(self):
        """Formats table summary with primary key and join targets."""
        facts = TableFacts(
            table_name="orders",
            row_count=1000,
            columns=[],
            primary_key="order_id",
            joins_to=["customers", "products"],
        )

        result = format_table_facts(facts)

        assert "1,000 rows" in result
        assert "pk:order_id" in result
        assert "joins:customers,products" in result


class TestDetectDateGranularity:
    """Tests for _detect_date_granularity."""

    def test_date_type_returns_day(self):
        """DATE type always returns day granularity."""
        col = ColumnProfile(name="created_date", dtype="DATE")
        assert _detect_date_granularity(col) == "day"

    def test_midnight_timestamps_return_day(self):
        """Timestamps with only 00:00:00 time components return day."""
        col = ColumnProfile(
            name="created_at",
            dtype="TIMESTAMP",
            sample_values=[
                "2024-01-15 00:00:00",
                "2024-02-20 00:00:00",
                "2024-03-10 00:00:00",
            ],
        )
        assert _detect_date_granularity(col) == "day"

    def test_varying_hours_returns_hour(self):
        """Timestamps with varying hours but same minutes/seconds return hour."""
        col = ColumnProfile(
            name="event_time",
            dtype="TIMESTAMP",
            sample_values=[
                "2024-01-15 08:00:00",
                "2024-01-15 14:00:00",
                "2024-01-15 22:00:00",
            ],
        )
        assert _detect_date_granularity(col) == "hour"

    def test_varying_minutes_returns_minute(self):
        """Timestamps with varying minutes return minute."""
        col = ColumnProfile(
            name="log_time",
            dtype="TIMESTAMP",
            sample_values=[
                "2024-01-15 08:15:00",
                "2024-01-15 08:30:00",
                "2024-01-15 08:45:00",
            ],
        )
        assert _detect_date_granularity(col) == "minute"

    def test_varying_seconds_returns_second(self):
        """Timestamps with varying seconds return second."""
        col = ColumnProfile(
            name="precise_time",
            dtype="TIMESTAMP",
            sample_values=[
                "2024-01-15 08:15:30",
                "2024-01-15 08:15:45",
                "2024-01-15 08:16:10",
            ],
        )
        assert _detect_date_granularity(col) == "second"

    def test_timestamp_without_samples_defaults_to_second(self):
        """TIMESTAMP without sample values defaults to second."""
        col = ColumnProfile(name="ts", dtype="TIMESTAMP")
        assert _detect_date_granularity(col) == "second"

    def test_non_datetime_type_returns_none(self):
        """Non-date/time types return None."""
        col = ColumnProfile(name="name", dtype="VARCHAR")
        assert _detect_date_granularity(col) is None


class TestDetectJoinCardinality:
    """Tests for _detect_join_cardinality."""

    def _make_table(self, name, row_count, col_name, approx_unique):
        return TableProfile(
            name=name,
            row_count=row_count,
            columns=[
                ColumnProfile(name=col_name, dtype="BIGINT", approx_unique=approx_unique),
            ],
        )

    def test_one_to_many(self):
        """Unique source joining to non-unique target is 1:N."""
        source_col = ColumnProfile(name="id", dtype="BIGINT", approx_unique=100)
        target_table = self._make_table("orders", 1000, "customer_id", 100)
        result = _detect_join_cardinality(
            source_col, 100, ("orders", "customer_id", 50), [target_table]
        )
        assert result == "1:N"

    def test_many_to_one(self):
        """Non-unique source joining to unique target is N:1."""
        source_col = ColumnProfile(name="customer_id", dtype="BIGINT", approx_unique=100)
        target_table = self._make_table("customers", 100, "id", 100)
        result = _detect_join_cardinality(
            source_col, 1000, ("customers", "id", 50), [target_table]
        )
        assert result == "N:1"

    def test_one_to_one(self):
        """Both sides unique is 1:1."""
        source_col = ColumnProfile(name="user_id", dtype="BIGINT", approx_unique=100)
        target_table = self._make_table("profiles", 100, "user_id", 100)
        result = _detect_join_cardinality(
            source_col, 100, ("profiles", "user_id", 50), [target_table]
        )
        assert result == "1:1"

    def test_many_to_many(self):
        """Neither side unique is N:N."""
        source_col = ColumnProfile(name="tag_id", dtype="BIGINT", approx_unique=50)
        target_table = self._make_table("articles", 500, "tag_id", 50)
        result = _detect_join_cardinality(
            source_col, 1000, ("articles", "tag_id", 50), [target_table]
        )
        assert result == "N:N"

    def test_target_table_not_found(self):
        """Returns None when target table is not in all_tables."""
        source_col = ColumnProfile(name="id", dtype="BIGINT", approx_unique=100)
        result = _detect_join_cardinality(
            source_col, 100, ("missing_table", "id", 50), []
        )
        assert result is None

    def test_target_column_not_found(self):
        """Returns None when target column is not in target table."""
        source_col = ColumnProfile(name="id", dtype="BIGINT", approx_unique=100)
        target_table = TableProfile(
            name="orders",
            row_count=1000,
            columns=[ColumnProfile(name="other_col", dtype="BIGINT", approx_unique=500)],
        )
        result = _detect_join_cardinality(
            source_col, 100, ("orders", "missing_col", 50), [target_table]
        )
        assert result is None


class TestExtractUsagePatterns:
    """Tests for _extract_usage_patterns."""

    def test_extracts_all_patterns(self):
        """Extracts where, groupby, orderby flags when counts are above threshold."""
        field_usage = [
            FieldUsage(
                table="orders",
                column="status",
                select_count=100,
                where_count=50,
                join_count=0,
                group_by_count=30,
                order_by_count=10,
                total_count=190,
            ),
        ]
        where, groupby, orderby = _extract_usage_patterns("orders", "status", field_usage)
        assert where is True
        assert groupby is True
        assert orderby is True

    def test_below_threshold_returns_false(self):
        """Returns False for counts below the min_count threshold."""
        field_usage = [
            FieldUsage(
                table="orders",
                column="status",
                select_count=10,
                where_count=3,
                join_count=0,
                group_by_count=2,
                order_by_count=1,
                total_count=16,
            ),
        ]
        where, groupby, orderby = _extract_usage_patterns("orders", "status", field_usage)
        assert where is False
        assert groupby is False
        assert orderby is False

    def test_column_not_found_returns_all_false(self):
        """Returns all False when column is not in field usage."""
        field_usage = [
            FieldUsage(
                table="orders",
                column="other_col",
                select_count=100,
                where_count=50,
                total_count=150,
            ),
        ]
        where, groupby, orderby = _extract_usage_patterns("orders", "status", field_usage)
        assert where is False
        assert groupby is False
        assert orderby is False

    def test_case_insensitive_matching(self):
        """Matches table and column names case-insensitively."""
        field_usage = [
            FieldUsage(
                table="Orders",
                column="Status",
                select_count=100,
                where_count=50,
                total_count=150,
            ),
        ]
        where, groupby, orderby = _extract_usage_patterns("orders", "status", field_usage)
        assert where is True


class TestExtractAggregations:
    """Tests for _extract_aggregations."""

    def test_extracts_sum_and_avg(self):
        """Extracts SUM and AVG aggregations from derived metrics."""
        metrics = [
            DerivedMetric(
                expression="SUM(amount)",
                alias_names=["total_amount"],
                occurrence_count=20,
            ),
            DerivedMetric(
                expression="AVG(amount)",
                alias_names=["avg_amount"],
                occurrence_count=10,
            ),
        ]
        result = _extract_aggregations("orders", "amount", metrics)
        assert "SUM" in result
        assert "AVG" in result

    def test_no_matching_aggregations(self):
        """Returns empty list when no aggregations match the column."""
        metrics = [
            DerivedMetric(
                expression="SUM(quantity)",
                alias_names=["total_qty"],
                occurrence_count=20,
            ),
        ]
        result = _extract_aggregations("orders", "amount", metrics)
        assert result == []

    def test_sorts_by_frequency(self):
        """Returns aggregations sorted by frequency descending."""
        metrics = [
            DerivedMetric(expression="AVG(price)", occurrence_count=5),
            DerivedMetric(expression="SUM(price)", occurrence_count=50),
            DerivedMetric(expression="COUNT(price)", occurrence_count=20),
        ]
        result = _extract_aggregations("products", "price", metrics)
        assert result == ["SUM", "COUNT", "AVG"]

    def test_limits_to_top_three(self):
        """Returns at most 3 aggregation types."""
        metrics = [
            DerivedMetric(expression="SUM(val)", occurrence_count=40),
            DerivedMetric(expression="AVG(val)", occurrence_count=30),
            DerivedMetric(expression="COUNT(val)", occurrence_count=20),
            DerivedMetric(expression="MIN(val)", occurrence_count=10),
            DerivedMetric(expression="MAX(val)", occurrence_count=5),
        ]
        result = _extract_aggregations("t", "val", metrics)
        assert len(result) == 3


class TestFormatColumnFactsWithSemanticRole:
    """Tests for format_column_facts when semantic_role is set."""

    def test_role_prefix_appears_first(self):
        """Semantic role appears as first element in formatted output."""
        facts = ColumnFacts(
            table_name="orders",
            column_name="total",
            dtype="DECIMAL",
            semantic_role="fact",
            min_value="0.00",
            max_value="9999.99",
        )
        formatted = format_column_facts(facts)
        assert formatted.startswith("role:fact")

    def test_role_pk(self):
        """Primary key role is formatted correctly."""
        facts = ColumnFacts(
            table_name="users",
            column_name="id",
            dtype="BIGINT",
            semantic_role="pk",
        )
        formatted = format_column_facts(facts)
        assert "role:pk" in formatted

    def test_role_fk_with_join(self):
        """FK role combined with join target."""
        facts = ColumnFacts(
            table_name="orders",
            column_name="customer_id",
            dtype="BIGINT",
            semantic_role="fk",
            join_targets=[("customers", "id", 50)],
            join_cardinality="N:1",
        )
        formatted = format_column_facts(facts)
        assert "role:fk" in formatted
        assert "fk(N:1)->customers.id" in formatted

    def test_role_timestamp_with_granularity(self):
        """Timestamp role combined with granularity."""
        facts = ColumnFacts(
            table_name="events",
            column_name="created_at",
            dtype="TIMESTAMP",
            semantic_role="timestamp",
            date_granularity="day",
        )
        formatted = format_column_facts(facts)
        assert "role:timestamp" in formatted
        assert "granularity:day" in formatted

    def test_role_dimension_with_enum(self):
        """Dimension role combined with categorical values."""
        facts = ColumnFacts(
            table_name="orders",
            column_name="status",
            dtype="VARCHAR",
            semantic_role="dimension",
            is_categorical=True,
            approx_unique=3,
            sample_values=["pending", "shipped", "delivered"],
        )
        formatted = format_column_facts(facts)
        assert "role:dimension" in formatted
        assert "[pending,shipped,delivered]" in formatted


class TestTokenBudgetEnforcement:
    """Tests for token budget enforcement in format_column_facts."""

    def test_very_small_budget_only_high_priority(self):
        """With a tiny budget, medium-priority facts are dropped."""
        facts = ColumnFacts(
            table_name="orders",
            column_name="amount",
            dtype="DECIMAL",
            semantic_role="fact",
            null_percentage=15.0,
            min_value="0.00",
            max_value="99999.99",
            filter_patterns=[("=", 100), (">", 50)],
            detected_pattern=None,
        )
        # Budget of 3 tokens = ~12 chars — only role:fact (9 chars) fits
        formatted = format_column_facts(facts, token_budget=3)
        assert "role:fact" in formatted
        # Medium-priority items should be dropped due to budget
        assert "null:" not in formatted
        assert "range:" not in formatted
        assert "filter:" not in formatted

    def test_large_budget_includes_everything(self):
        """With a large budget, all facts are included."""
        facts = ColumnFacts(
            table_name="orders",
            column_name="amount",
            dtype="DECIMAL",
            semantic_role="fact",
            null_percentage=15.0,
            min_value="0.00",
            max_value="999.99",
            filter_patterns=[("=", 100)],
            detected_pattern="email",
        )
        formatted = format_column_facts(facts, token_budget=200)
        assert "role:fact" in formatted
        assert "null:15%" in formatted
        assert "range:" in formatted
        assert "filter:" in formatted
        assert "pattern:email" in formatted

    def test_default_budget_drops_lower_priority_when_full(self):
        """Default budget drops low-priority facts when higher ones fill it."""
        facts = ColumnFacts(
            table_name="orders",
            column_name="customer_id",
            dtype="BIGINT",
            semantic_role="fk",
            join_targets=[("customers", "id", 500)],
            join_cardinality="N:1",
            common_aggregations=["COUNT"],
            null_percentage=25.0,
            min_value="1",
            max_value="100000",
            filter_patterns=[("=", 100), ("IN", 50), (">", 20)],
            used_in_where=True,
            used_in_groupby=True,
            detected_pattern="uuid",
        )
        # With default budget (30 tokens = ~120 chars), some things will be dropped
        formatted = format_column_facts(facts)
        # High priority items always included
        assert "role:fk" in formatted
        assert "fk(N:1)->customers.id" in formatted
        assert "agg:[COUNT]" in formatted


class TestExtractOrphanInfo:
    """Tests for _extract_orphan_info."""

    def test_source_side_orphans(self):
        """Extracts orphan info when column is on source side."""
        similarities = [
            ColumnSimilarity(
                source_table="transactions",
                source_column="aci",
                target_table="fees",
                target_column="aci",
                jaccard_similarity=0.85,
                likely_relationship="shared_dimension",
                source_only_values=["G", "X", "Z"],
                target_only_values=["Q"],
                source_only_count=3,
                target_only_count=1,
            ),
        ]
        values, count, target = _extract_orphan_info("transactions", "aci", similarities)
        assert values == ["G", "X", "Z"]
        assert count == 3
        assert target == "fees.aci"

    def test_target_side_orphans(self):
        """Extracts orphan info when column is on target side."""
        similarities = [
            ColumnSimilarity(
                source_table="transactions",
                source_column="aci",
                target_table="fees",
                target_column="aci",
                jaccard_similarity=0.85,
                likely_relationship="shared_dimension",
                source_only_values=["G", "X", "Z"],
                target_only_values=["Q"],
                source_only_count=3,
                target_only_count=1,
            ),
        ]
        values, count, target = _extract_orphan_info("fees", "aci", similarities)
        assert values == ["Q"]
        assert count == 1
        assert target == "transactions.aci"

    def test_no_orphans(self):
        """Returns empty when no orphans exist."""
        similarities = [
            ColumnSimilarity(
                source_table="a",
                source_column="id",
                target_table="b",
                target_column="a_id",
                jaccard_similarity=0.95,
                likely_relationship="foreign_key",
                source_only_count=0,
                target_only_count=0,
            ),
        ]
        values, count, target = _extract_orphan_info("a", "id", similarities)
        assert values == []
        assert count == 0
        assert target is None

    def test_no_matching_similarity(self):
        """Returns empty when column not in any similarity."""
        similarities = [
            ColumnSimilarity(
                source_table="x",
                source_column="y",
                target_table="z",
                target_column="w",
                jaccard_similarity=0.9,
                likely_relationship="foreign_key",
            ),
        ]
        values, count, target = _extract_orphan_info("a", "id", similarities)
        assert values == []
        assert count == 0
        assert target is None

    def test_picks_highest_similarity(self):
        """When column appears in multiple similarities, picks highest."""
        similarities = [
            ColumnSimilarity(
                source_table="orders",
                source_column="status",
                target_table="statuses",
                target_column="code",
                jaccard_similarity=0.7,
                likely_relationship="shared_dimension",
                source_only_values=["X"],
                source_only_count=1,
            ),
            ColumnSimilarity(
                source_table="orders",
                source_column="status",
                target_table="ref_statuses",
                target_column="status_code",
                jaccard_similarity=0.9,
                likely_relationship="foreign_key",
                source_only_values=["A", "B"],
                source_only_count=2,
            ),
        ]
        values, count, target = _extract_orphan_info("orders", "status", similarities)
        assert count == 2
        assert target == "ref_statuses.status_code"


class TestFormatColumnFactsWithOrphans:
    """Tests for orphan notation in format_column_facts."""

    def test_orphans_in_output(self):
        """Orphan values appear in formatted output."""
        facts = ColumnFacts(
            table_name="transactions",
            column_name="aci",
            dtype="VARCHAR",
            semantic_role="fk",
            speculative_joins=[("fees", "aci", 0.85)],
            orphan_values=["G", "X", "Z"],
            orphan_count=3,
            orphan_target="fees.aci",
        )
        formatted = format_column_facts(facts, token_budget=200)
        assert "orphans(3):[G,X,Z]->fees.aci" in formatted

    def test_orphans_without_values(self):
        """Orphan count without example values."""
        facts = ColumnFacts(
            table_name="t",
            column_name="c",
            dtype="VARCHAR",
            orphan_values=[],
            orphan_count=5,
            orphan_target="other.c",
        )
        formatted = format_column_facts(facts, token_budget=200)
        assert "orphans(5)->other.c" in formatted

    def test_no_orphans_no_output(self):
        """No orphan notation when count is 0."""
        facts = ColumnFacts(
            table_name="t",
            column_name="c",
            dtype="VARCHAR",
            orphan_count=0,
            orphan_target=None,
        )
        formatted = format_column_facts(facts, token_budget=200)
        assert "orphan" not in formatted

    def test_orphan_values_truncated_to_display_limit(self):
        """Only FACT_ORPHAN_DISPLAY_VALUES values shown in notation."""
        facts = ColumnFacts(
            table_name="t",
            column_name="c",
            dtype="VARCHAR",
            orphan_values=["A", "B", "C", "D", "E"],
            orphan_count=5,
            orphan_target="other.c",
        )
        formatted = format_column_facts(facts, token_budget=200)
        # Should only show first 3 (FACT_ORPHAN_DISPLAY_VALUES)
        assert "orphans(5):[A,B,C]->other.c" in formatted


class TestColumnFactsOrphanSerialization:
    """Tests for orphan fields in ColumnFacts to_dict/from_dict."""

    def test_to_dict_includes_orphan_fields(self):
        """ColumnFacts.to_dict includes orphan fields."""
        facts = ColumnFacts(
            table_name="t",
            column_name="c",
            dtype="VARCHAR",
            orphan_values=["X", "Y"],
            orphan_count=2,
            orphan_target="other.c",
        )
        d = facts.to_dict()
        assert d["orphan_values"] == ["X", "Y"]
        assert d["orphan_count"] == 2
        assert d["orphan_target"] == "other.c"

    def test_from_dict_roundtrip(self):
        """ColumnFacts orphan fields round-trip correctly."""
        original = ColumnFacts(
            table_name="t",
            column_name="c",
            dtype="VARCHAR",
            orphan_values=["A"],
            orphan_count=1,
            orphan_target="ref.c",
        )
        d = original.to_dict()
        restored = ColumnFacts.from_dict(d)
        assert restored.orphan_values == ["A"]
        assert restored.orphan_count == 1
        assert restored.orphan_target == "ref.c"

    def test_from_dict_backward_compat(self):
        """ColumnFacts.from_dict handles old data without orphan fields."""
        d = {
            "table_name": "t",
            "column_name": "c",
            "dtype": "VARCHAR",
        }
        facts = ColumnFacts.from_dict(d)
        assert facts.orphan_values == []
        assert facts.orphan_count == 0
        assert facts.orphan_target is None
