"""Tests for data models in models.py."""

import pytest

from metadata_generator.models import (
    ColumnProfile,
    TableProfile,
    SchemaProfile,
    ColumnDescription,
    TableDescription,
    SchemaDescription,
    ColumnSimilarity,
    QueryTranslation,
    TranslatedQueryHistory,
)


class TestColumnProfile:
    """Tests for ColumnProfile data class."""

    def test_to_dict_minimal(self):
        """ColumnProfile with minimal fields serializes correctly."""
        col = ColumnProfile(
            name="id",
            dtype="BIGINT",
        )

        d = col.to_dict()
        assert d["name"] == "id"
        assert d["dtype"] == "BIGINT"
        assert d["null_percentage"] == 0.0
        assert d["is_categorical"] is False

    def test_to_dict_full(self):
        """ColumnProfile with all fields serializes correctly."""
        col = ColumnProfile(
            name="status",
            dtype="VARCHAR",
            min_value="active",
            max_value="pending",
            approx_unique=3,
            avg=None,
            std=None,
            q25=None,
            q50=None,
            q75=None,
            count=100,
            null_percentage=5.0,
            is_categorical=True,
            sample_values=["active", "pending", "inactive"],
            min_length=6,
            max_length=8,
            avg_length=7.0,
            detected_pattern=None,
            char_composition={"alpha": 1.0, "numeric": 0.0, "special": 0.0},
        )

        d = col.to_dict()
        assert d["sample_values"] == ["active", "pending", "inactive"]
        assert d["is_categorical"] is True
        assert d["char_composition"]["alpha"] == 1.0

    def test_from_dict_roundtrip(self):
        """ColumnProfile round-trips through dict correctly."""
        original = ColumnProfile(
            name="amount",
            dtype="DECIMAL(10,2)",
            min_value="0.00",
            max_value="9999.99",
            approx_unique=500,
            avg=150.50,
            count=1000,
            null_percentage=2.5,
        )

        d = original.to_dict()
        restored = ColumnProfile.from_dict(d)

        assert restored.name == original.name
        assert restored.dtype == original.dtype
        assert restored.avg == original.avg
        assert restored.null_percentage == original.null_percentage


class TestTableProfile:
    """Tests for TableProfile data class."""

    def test_to_dict(self):
        """TableProfile serializes correctly."""
        col1 = ColumnProfile(name="id", dtype="BIGINT")
        col2 = ColumnProfile(name="name", dtype="VARCHAR")

        table = TableProfile(
            name="users",
            row_count=1000,
            columns=[col1, col2],
        )

        d = table.to_dict()
        assert d["name"] == "users"
        assert d["row_count"] == 1000
        assert len(d["columns"]) == 2
        assert d["columns"][0]["name"] == "id"

    def test_from_dict_roundtrip(self):
        """TableProfile round-trips through dict correctly."""
        original = TableProfile(
            name="orders",
            row_count=5000,
            columns=[
                ColumnProfile(name="id", dtype="BIGINT"),
                ColumnProfile(name="amount", dtype="DECIMAL"),
            ],
        )

        d = original.to_dict()
        restored = TableProfile.from_dict(d)

        assert restored.name == original.name
        assert restored.row_count == original.row_count
        assert len(restored.columns) == len(original.columns)


class TestSchemaProfile:
    """Tests for SchemaProfile data class."""

    def test_to_dict(self):
        """SchemaProfile serializes correctly."""
        profile = SchemaProfile(
            db_id="test_schema",
            database="test_db",
            tables=[
                TableProfile(
                    name="users",
                    row_count=100,
                    columns=[ColumnProfile(name="id", dtype="BIGINT")],
                )
            ],
            column_similarities=[
                ColumnSimilarity(
                    source_table="users",
                    source_column="id",
                    target_table="orders",
                    target_column="user_id",
                    jaccard_similarity=0.95,
                    likely_relationship="foreign_key",
                )
            ],
        )

        d = profile.to_dict()
        assert d["db_id"] == "test_schema"
        assert d["database"] == "test_db"
        assert len(d["tables"]) == 1
        assert len(d["column_similarities"]) == 1

    def test_from_dict_roundtrip(self):
        """SchemaProfile round-trips through dict correctly."""
        original = SchemaProfile(
            db_id="formula_1",
            database="bird_bench",
            tables=[
                TableProfile(
                    name="races",
                    row_count=1000,
                    columns=[
                        ColumnProfile(name="raceId", dtype="BIGINT"),
                        ColumnProfile(name="name", dtype="VARCHAR"),
                    ],
                )
            ],
        )

        d = original.to_dict()
        restored = SchemaProfile.from_dict(d)

        assert restored.db_id == original.db_id
        assert restored.database == original.database
        assert len(restored.tables) == len(original.tables)
        assert restored.tables[0].name == original.tables[0].name


class TestTableProfileIsView:
    """Tests for TableProfile.is_view field."""

    def test_default_is_false(self):
        """TableProfile defaults is_view to False."""
        table = TableProfile(name="users", row_count=100)
        assert table.is_view is False

    def test_to_dict_omits_when_false(self):
        """is_view is omitted from dict when False (compact output)."""
        table = TableProfile(name="users", row_count=100)
        d = table.to_dict()
        assert "is_view" not in d

    def test_to_dict_includes_when_true(self):
        """is_view is included in dict when True."""
        table = TableProfile(name="team_stats", row_count=50, is_view=True)
        d = table.to_dict()
        assert d["is_view"] is True

    def test_from_dict_without_is_view(self):
        """Backward-compatible: from_dict works without is_view key."""
        d = {"name": "users", "row_count": 100, "columns": []}
        table = TableProfile.from_dict(d)
        assert table.is_view is False

    def test_roundtrip_view(self):
        """TableProfile with is_view=True round-trips correctly."""
        original = TableProfile(
            name="player_stats",
            row_count=200,
            columns=[ColumnProfile(name="id", dtype="BIGINT")],
            is_view=True,
        )
        d = original.to_dict()
        restored = TableProfile.from_dict(d)
        assert restored.is_view is True
        assert restored.name == "player_stats"

    def test_roundtrip_table(self):
        """TableProfile with is_view=False round-trips correctly."""
        original = TableProfile(
            name="games",
            row_count=500,
            columns=[ColumnProfile(name="id", dtype="BIGINT")],
            is_view=False,
        )
        d = original.to_dict()
        restored = TableProfile.from_dict(d)
        assert restored.is_view is False


class TestColumnDescription:
    """Tests for ColumnDescription data class."""

    def test_to_dict(self):
        """ColumnDescription serializes correctly."""
        desc = ColumnDescription(
            column_name="user_id",
            table_name="orders",
            description="Foreign key to users table",
            semantic_type="foreign_key",
        )

        d = desc.to_dict()
        assert d["column_name"] == "user_id"
        assert d["semantic_type"] == "foreign_key"

    def test_from_dict_roundtrip(self):
        """ColumnDescription round-trips through dict correctly."""
        original = ColumnDescription(
            column_name="email",
            table_name="users",
            description="User email address",
            semantic_type="text",
        )

        d = original.to_dict()
        restored = ColumnDescription.from_dict(d)

        assert restored.column_name == original.column_name
        assert restored.description == original.description


class TestTableDescription:
    """Tests for TableDescription data class."""

    def test_to_dict(self):
        """TableDescription serializes correctly."""
        desc = TableDescription(
            table_name="users",
            description="User account information",
            columns=[
                ColumnDescription(
                    column_name="id",
                    table_name="users",
                    description="Primary key",
                    semantic_type="identifier",
                )
            ],
        )

        d = desc.to_dict()
        assert d["table_name"] == "users"
        assert len(d["columns"]) == 1

    def test_from_dict_roundtrip(self):
        """TableDescription round-trips through dict correctly."""
        original = TableDescription(
            table_name="orders",
            description="Customer orders",
            columns=[
                ColumnDescription(
                    column_name="id",
                    table_name="orders",
                    description="Order ID",
                    semantic_type="identifier",
                ),
                ColumnDescription(
                    column_name="amount",
                    table_name="orders",
                    description="Order total",
                    semantic_type="measure",
                ),
            ],
        )

        d = original.to_dict()
        restored = TableDescription.from_dict(d)

        assert restored.table_name == original.table_name
        assert len(restored.columns) == len(original.columns)


class TestSchemaDescription:
    """Tests for SchemaDescription data class."""

    def test_to_dict(self):
        """SchemaDescription serializes correctly."""
        desc = SchemaDescription(
            db_id="test_schema",
            tables=[
                TableDescription(
                    table_name="users",
                    description="Users table",
                    columns=[],
                )
            ],
        )

        d = desc.to_dict()
        assert d["db_id"] == "test_schema"
        assert len(d["tables"]) == 1

    def test_from_dict_roundtrip(self):
        """SchemaDescription round-trips through dict correctly."""
        original = SchemaDescription(
            db_id="ecommerce",
            tables=[
                TableDescription(
                    table_name="products",
                    description="Product catalog",
                    columns=[
                        ColumnDescription(
                            column_name="sku",
                            table_name="products",
                            description="Stock keeping unit",
                            semantic_type="identifier",
                        )
                    ],
                )
            ],
        )

        d = original.to_dict()
        restored = SchemaDescription.from_dict(d)

        assert restored.db_id == original.db_id
        assert restored.tables[0].columns[0].column_name == "sku"


class TestColumnSimilarity:
    """Tests for ColumnSimilarity data class."""

    def test_to_dict(self):
        """ColumnSimilarity serializes correctly."""
        sim = ColumnSimilarity(
            source_table="users",
            source_column="id",
            target_table="orders",
            target_column="user_id",
            jaccard_similarity=0.92,
            likely_relationship="foreign_key",
        )

        d = sim.to_dict()
        assert d["source_table"] == "users"
        assert d["jaccard_similarity"] == 0.92
        assert d["likely_relationship"] == "foreign_key"

    def test_from_dict_roundtrip(self):
        """ColumnSimilarity round-trips through dict correctly."""
        original = ColumnSimilarity(
            source_table="products",
            source_column="category_id",
            target_table="categories",
            target_column="id",
            jaccard_similarity=0.85,
            likely_relationship="foreign_key",
        )

        d = original.to_dict()
        restored = ColumnSimilarity.from_dict(d)

        assert restored.source_table == original.source_table
        assert restored.jaccard_similarity == original.jaccard_similarity

    def test_orphan_fields_roundtrip(self):
        """ColumnSimilarity with orphan fields round-trips correctly."""
        original = ColumnSimilarity(
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
        )

        d = original.to_dict()
        assert d["source_only_values"] == ["G", "X", "Z"]
        assert d["target_only_values"] == ["Q"]
        assert d["source_only_count"] == 3
        assert d["target_only_count"] == 1

        restored = ColumnSimilarity.from_dict(d)
        assert restored.source_only_values == ["G", "X", "Z"]
        assert restored.target_only_values == ["Q"]
        assert restored.source_only_count == 3
        assert restored.target_only_count == 1

    def test_orphan_fields_default(self):
        """ColumnSimilarity defaults orphan fields to empty/zero."""
        sim = ColumnSimilarity(
            source_table="a",
            source_column="x",
            target_table="b",
            target_column="y",
            jaccard_similarity=0.9,
            likely_relationship="foreign_key",
        )
        assert sim.source_only_values == []
        assert sim.target_only_values == []
        assert sim.source_only_count == 0
        assert sim.target_only_count == 0

    def test_backward_compat_from_dict_without_orphan_fields(self):
        """ColumnSimilarity.from_dict handles old JSON without orphan fields."""
        d = {
            "source_table": "users",
            "source_column": "id",
            "target_table": "orders",
            "target_column": "user_id",
            "jaccard_similarity": 0.92,
            "likely_relationship": "foreign_key",
        }
        restored = ColumnSimilarity.from_dict(d)
        assert restored.source_only_values == []
        assert restored.target_only_values == []
        assert restored.source_only_count == 0
        assert restored.target_only_count == 0


class TestQueryTranslation:
    """Tests for QueryTranslation data class."""

    def test_to_dict_minimal(self):
        """QueryTranslation with only required fields serializes correctly."""
        qt = QueryTranslation(
            sql="SELECT * FROM users",
            natural_language="Get all users",
        )

        d = qt.to_dict()
        assert d["sql"] == "SELECT * FROM users"
        assert d["natural_language"] == "Get all users"
        assert d["tables_referenced"] == []
        # short_question and long_question should not be in output if None
        assert "short_question" not in d
        assert "long_question" not in d

    def test_to_dict_with_questions(self):
        """QueryTranslation with short/long questions serializes correctly."""
        qt = QueryTranslation(
            sql="SELECT country, SUM(revenue) FROM orders GROUP BY country",
            natural_language="Revenue by country",
            tables_referenced=["orders"],
            short_question="Revenue by country",
            long_question="What is the total revenue for each country from all orders?",
        )

        d = qt.to_dict()
        assert d["sql"].startswith("SELECT")
        assert d["natural_language"] == "Revenue by country"
        assert d["tables_referenced"] == ["orders"]
        assert d["short_question"] == "Revenue by country"
        assert d["long_question"] == "What is the total revenue for each country from all orders?"

    def test_from_dict_minimal(self):
        """QueryTranslation deserializes correctly without optional fields."""
        d = {
            "sql": "SELECT * FROM products",
            "natural_language": "All products",
        }

        qt = QueryTranslation.from_dict(d)
        assert qt.sql == "SELECT * FROM products"
        assert qt.natural_language == "All products"
        assert qt.tables_referenced == []
        assert qt.short_question is None
        assert qt.long_question is None

    def test_from_dict_full(self):
        """QueryTranslation deserializes correctly with all fields."""
        d = {
            "sql": "SELECT c.name, COUNT(*) FROM customers c JOIN orders o ON c.id = o.customer_id GROUP BY 1",
            "natural_language": "Customer order counts",
            "tables_referenced": ["customers", "orders"],
            "short_question": "Orders per customer",
            "long_question": "How many orders has each customer placed, showing customer names?",
        }

        qt = QueryTranslation.from_dict(d)
        assert qt.sql.startswith("SELECT")
        assert qt.natural_language == "Customer order counts"
        assert qt.tables_referenced == ["customers", "orders"]
        assert qt.short_question == "Orders per customer"
        assert qt.long_question == "How many orders has each customer placed, showing customer names?"

    def test_roundtrip(self):
        """QueryTranslation round-trips through dict correctly."""
        original = QueryTranslation(
            sql="SELECT AVG(price) FROM products WHERE category = 'electronics'",
            natural_language="Average electronics price",
            tables_referenced=["products"],
            short_question="Avg electronics price",
            long_question="What is the average price of products in the electronics category?",
        )

        d = original.to_dict()
        restored = QueryTranslation.from_dict(d)

        assert restored.sql == original.sql
        assert restored.natural_language == original.natural_language
        assert restored.tables_referenced == original.tables_referenced
        assert restored.short_question == original.short_question
        assert restored.long_question == original.long_question


class TestTranslatedQueryHistory:
    """Tests for TranslatedQueryHistory data class."""

    def test_to_dict(self):
        """TranslatedQueryHistory serializes correctly."""
        history = TranslatedQueryHistory(
            schema="main",
            generated_at="2025-01-28T10:00:00",
            translations=[
                QueryTranslation(
                    sql="SELECT * FROM users",
                    natural_language="All users",
                    short_question="All users",
                    long_question="Get a list of all users in the system",
                )
            ],
            database="mydb",
        )

        d = history.to_dict()
        assert d["schema"] == "main"
        assert d["generated_at"] == "2025-01-28T10:00:00"
        assert len(d["translations"]) == 1
        assert d["translations"][0]["short_question"] == "All users"
        assert d["database"] == "mydb"

    def test_from_dict(self):
        """TranslatedQueryHistory deserializes correctly."""
        d = {
            "schema": "test_schema",
            "generated_at": "2025-01-28T12:00:00",
            "translations": [
                {
                    "sql": "SELECT COUNT(*) FROM orders",
                    "natural_language": "Order count",
                    "tables_referenced": ["orders"],
                    "short_question": "Total orders",
                    "long_question": "How many orders are there in total?",
                }
            ],
            "database": "test_db",
        }

        history = TranslatedQueryHistory.from_dict(d)
        assert history.schema == "test_schema"
        assert history.database == "test_db"
        assert len(history.translations) == 1
        assert history.translations[0].short_question == "Total orders"
        assert history.translations[0].long_question == "How many orders are there in total?"

    def test_roundtrip(self):
        """TranslatedQueryHistory round-trips through dict correctly."""
        original = TranslatedQueryHistory(
            schema="ecommerce",
            generated_at="2025-01-28T15:30:00",
            translations=[
                QueryTranslation(
                    sql="SELECT * FROM products",
                    natural_language="Products",
                    tables_referenced=["products"],
                    short_question="All products",
                    long_question="List all products in the catalog",
                ),
                QueryTranslation(
                    sql="SELECT * FROM categories",
                    natural_language="Categories",
                    tables_referenced=["categories"],
                ),
            ],
            database="shop_db",
        )

        d = original.to_dict()
        restored = TranslatedQueryHistory.from_dict(d)

        assert restored.schema == original.schema
        assert restored.database == original.database
        assert restored.generated_at == original.generated_at
        assert len(restored.translations) == len(original.translations)
        assert restored.translations[0].short_question == original.translations[0].short_question
        assert restored.translations[1].short_question is None  # Second one had no short_question
