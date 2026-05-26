"""Tests for SQL generation functions in sql.py."""

import pytest
from pathlib import Path
from unittest.mock import patch, MagicMock

from metadata_generator.sql import (
    escape_sql_string,
    quote_identifier,
    generate_sql_comments,
    save_sql_comments,
    execute_sql_comments,
)
from metadata_generator.models import (
    ColumnProfile,
    TableProfile,
    SchemaProfile,
    ColumnDescription,
    TableDescription,
    SchemaDescription,
)
from metadata_generator.persistence import InMemoryFileSystem
from metadata_generator.history import QueryHistoryResult, JoinCondition


class TestEscapeSqlString:
    """Tests for escape_sql_string()."""

    def test_no_quotes(self):
        """String without quotes is unchanged."""
        s = "Hello World"
        assert escape_sql_string(s) == "Hello World"

    def test_single_quote(self):
        """Single quote is escaped."""
        s = "It's a test"
        assert escape_sql_string(s) == "It''s a test"

    def test_multiple_quotes(self):
        """Multiple single quotes are escaped."""
        s = "It's John's test"
        assert escape_sql_string(s) == "It''s John''s test"

    def test_empty_string(self):
        """Empty string is unchanged."""
        assert escape_sql_string("") == ""

    def test_only_quotes(self):
        """String of only quotes is escaped."""
        s = "'''"
        assert escape_sql_string(s) == "''''''"


class TestQuoteIdentifier:
    """Tests for quote_identifier()."""

    def test_simple_name(self):
        """Simple name is not quoted."""
        assert quote_identifier("users") == "users"

    def test_name_with_space(self):
        """Name with space is quoted."""
        assert quote_identifier("user name") == '"user name"'

    def test_name_with_parentheses(self):
        """Name with parentheses is quoted."""
        assert quote_identifier("count(*)") == '"count(*)"'

    def test_name_with_dash(self):
        """Name with dash is quoted."""
        assert quote_identifier("user-id") == '"user-id"'

    def test_name_with_percent(self):
        """Name with percent is quoted."""
        assert quote_identifier("null%") == '"null%"'

    def test_name_with_slash(self):
        """Name with slash is quoted."""
        assert quote_identifier("path/to") == '"path/to"'


class TestGenerateSqlComments:
    """Tests for generate_sql_comments()."""

    def test_generates_header(self):
        """Generated SQL includes header comments."""
        profile = SchemaProfile(
            db_id="test_schema",
            database="test_db",
            tables=[],
        )

        sql = generate_sql_comments(profile)

        assert "-- COMMENT ON statements for schema: test_schema" in sql
        assert "-- Database: test_db" in sql

    def test_generates_table_comment(self):
        """Generated SQL includes table COMMENT statement."""
        profile = SchemaProfile(
            db_id="myschema",
            database="mydb",
            tables=[
                TableProfile(
                    name="users",
                    row_count=1000,
                    columns=[],
                )
            ],
        )

        sql = generate_sql_comments(profile)

        assert "COMMENT ON TABLE myschema.users IS" in sql
        assert "(1,000 rows)" in sql

    def test_generates_column_comment(self):
        """Generated SQL includes column COMMENT statement."""
        profile = SchemaProfile(
            db_id="myschema",
            database="mydb",
            tables=[
                TableProfile(
                    name="users",
                    row_count=100,
                    columns=[
                        ColumnProfile(
                            name="id",
                            dtype="BIGINT",
                            approx_unique=100,
                        )
                    ],
                )
            ],
        )

        sql = generate_sql_comments(profile)

        assert "COMMENT ON COLUMN myschema.users.id IS" in sql
        assert "BIGINT" in sql
        assert "100 distinct" in sql

    def test_includes_descriptions_if_provided(self):
        """Generated SQL includes LLM descriptions when provided."""
        profile = SchemaProfile(
            db_id="myschema",
            database="mydb",
            tables=[
                TableProfile(
                    name="users",
                    row_count=100,
                    columns=[
                        ColumnProfile(name="email", dtype="VARCHAR"),
                    ],
                )
            ],
        )

        descriptions = SchemaDescription(
            db_id="myschema",
            tables=[
                TableDescription(
                    table_name="users",
                    description="User account information",
                    columns=[
                        ColumnDescription(
                            column_name="email",
                            table_name="users",
                            description="User email address for login",
                            semantic_type="text",
                        )
                    ],
                )
            ],
        )

        sql = generate_sql_comments(profile, descriptions)

        assert "User account information" in sql
        assert "User email address for login" in sql
        assert "[text]" in sql

    def test_escapes_single_quotes(self):
        """Single quotes in descriptions are escaped."""
        profile = SchemaProfile(
            db_id="myschema",
            database="mydb",
            tables=[
                TableProfile(
                    name="notes",
                    row_count=50,
                    columns=[],
                )
            ],
        )

        descriptions = SchemaDescription(
            db_id="myschema",
            tables=[
                TableDescription(
                    table_name="notes",
                    description="User's personal notes",
                    columns=[],
                )
            ],
        )

        sql = generate_sql_comments(profile, descriptions)

        assert "User''s personal notes" in sql

    def test_quotes_special_identifiers(self):
        """Special characters in identifiers are quoted."""
        profile = SchemaProfile(
            db_id="myschema",
            database="mydb",
            tables=[
                TableProfile(
                    name="user data",
                    row_count=100,
                    columns=[
                        ColumnProfile(name="null%", dtype="DECIMAL"),
                    ],
                )
            ],
        )

        sql = generate_sql_comments(profile)

        assert '"user data"' in sql
        assert '"null%"' in sql

    def test_includes_null_percentage(self):
        """Column with null percentage includes it in comment."""
        profile = SchemaProfile(
            db_id="myschema",
            database="mydb",
            tables=[
                TableProfile(
                    name="users",
                    row_count=100,
                    columns=[
                        ColumnProfile(
                            name="phone",
                            dtype="VARCHAR",
                            null_percentage=25.0,
                        ),
                    ],
                )
            ],
        )

        sql = generate_sql_comments(profile)

        assert "25% null" in sql

    def test_includes_value_range(self):
        """Column with min/max values includes range in comment."""
        profile = SchemaProfile(
            db_id="myschema",
            database="mydb",
            tables=[
                TableProfile(
                    name="products",
                    row_count=500,
                    columns=[
                        ColumnProfile(
                            name="price",
                            dtype="DECIMAL",
                            min_value="0.99",
                            max_value="999.99",
                        ),
                    ],
                )
            ],
        )

        sql = generate_sql_comments(profile)

        assert "range: 0.99..999.99" in sql

    def test_includes_detected_pattern(self):
        """Column with detected pattern includes it in comment."""
        profile = SchemaProfile(
            db_id="myschema",
            database="mydb",
            tables=[
                TableProfile(
                    name="users",
                    row_count=100,
                    columns=[
                        ColumnProfile(
                            name="email",
                            dtype="VARCHAR",
                            detected_pattern="email",
                        ),
                    ],
                )
            ],
        )

        sql = generate_sql_comments(profile)

        assert "pattern: email" in sql

    def test_includes_avg_length(self):
        """Column with avg_length includes it in comment."""
        profile = SchemaProfile(
            db_id="myschema",
            database="mydb",
            tables=[
                TableProfile(
                    name="users",
                    row_count=100,
                    columns=[
                        ColumnProfile(
                            name="name",
                            dtype="VARCHAR",
                            avg_length=15.5,
                        ),
                    ],
                )
            ],
        )

        sql = generate_sql_comments(profile)

        assert "avg 16 chars" in sql  # 15.5 rounds to 16

    def test_facts_only_mode(self):
        """Facts-only mode generates compact notation."""
        profile = SchemaProfile(
            db_id="myschema",
            database="mydb",
            tables=[
                TableProfile(
                    name="orders",
                    row_count=1000,
                    columns=[
                        ColumnProfile(
                            name="status",
                            dtype="VARCHAR",
                            approx_unique=3,
                            is_categorical=True,
                            sample_values=["pending", "shipped", "delivered"],
                        ),
                        ColumnProfile(
                            name="id",
                            dtype="BIGINT",
                            approx_unique=1000,
                        ),
                    ],
                )
            ],
        )

        sql = generate_sql_comments(profile, facts_only=True)

        # Should use compact notation
        assert "facts-only mode" in sql
        assert "[pending,shipped,delivered]" in sql
        # ID column now gets role:pk since it's detected as primary key
        assert "COMMENT ON COLUMN myschema.orders.id" in sql
        assert "role:pk" in sql

    def test_facts_only_skips_empty_facts(self):
        """Facts-only mode skips columns with no useful facts."""
        profile = SchemaProfile(
            db_id="myschema",
            database="mydb",
            tables=[
                TableProfile(
                    name="data",
                    row_count=100,
                    columns=[
                        ColumnProfile(name="blob_col", dtype="BLOB"),
                    ],
                )
            ],
        )

        sql = generate_sql_comments(profile, facts_only=True)

        # Table comment should exist
        assert "COMMENT ON TABLE myschema.data" in sql
        # But column with no facts should be skipped
        assert "COMMENT ON COLUMN" not in sql

    def test_view_uses_comment_on_view(self):
        """Views emit COMMENT ON VIEW instead of COMMENT ON TABLE."""
        profile = SchemaProfile(
            db_id="myschema",
            database="mydb",
            tables=[
                TableProfile(
                    name="team_stats",
                    row_count=30,
                    is_view=True,
                    columns=[
                        ColumnProfile(
                            name="team_name",
                            dtype="VARCHAR",
                            approx_unique=30,
                            is_categorical=True,
                            sample_values=["Lakers", "Celtics"],
                        ),
                    ],
                )
            ],
        )

        sql = generate_sql_comments(profile)

        assert "COMMENT ON VIEW myschema.team_stats IS" in sql
        assert "COMMENT ON TABLE" not in sql

    def test_view_facts_only_mode(self):
        """Views emit COMMENT ON VIEW in facts-only mode."""
        profile = SchemaProfile(
            db_id="myschema",
            database="mydb",
            tables=[
                TableProfile(
                    name="player_stats",
                    row_count=100,
                    is_view=True,
                    columns=[
                        ColumnProfile(
                            name="points",
                            dtype="DOUBLE",
                            min_value="0.0",
                            max_value="50.0",
                        ),
                    ],
                )
            ],
        )

        sql = generate_sql_comments(profile, facts_only=True)

        assert "COMMENT ON VIEW myschema.player_stats IS" in sql
        assert "COMMENT ON TABLE" not in sql

    def test_mixed_tables_and_views(self):
        """Schema with both tables and views uses correct keywords."""
        profile = SchemaProfile(
            db_id="myschema",
            database="mydb",
            tables=[
                TableProfile(name="games", row_count=1000, columns=[]),
                TableProfile(name="team_stats", row_count=30, is_view=True, columns=[]),
            ],
        )

        sql = generate_sql_comments(profile)

        assert "COMMENT ON TABLE myschema.games IS" in sql
        assert "COMMENT ON VIEW myschema.team_stats IS" in sql


class TestSaveSqlComments:
    """Tests for save_sql_comments()."""

    def _make_profile(self) -> SchemaProfile:
        return SchemaProfile(
            db_id="myschema",
            database="mydb",
            tables=[
                TableProfile(
                    name="users",
                    row_count=100,
                    columns=[
                        ColumnProfile(name="id", dtype="BIGINT", approx_unique=100),
                    ],
                )
            ],
        )

    def test_writes_to_correct_path(self):
        """save_sql_comments writes SQL to the expected file path."""
        fs = InMemoryFileSystem()
        profile = self._make_profile()

        result_path = save_sql_comments(profile, output_dir="output/sql", fs=fs)

        assert result_path == Path("output/sql/mydb_myschema_comments.sql")
        assert fs.exists(result_path)

    def test_written_content_is_valid_sql(self):
        """Written file contains the generated SQL comments."""
        fs = InMemoryFileSystem()
        profile = self._make_profile()

        result_path = save_sql_comments(profile, output_dir="output/sql", fs=fs)

        content = fs.files[result_path]
        assert "COMMENT ON" in content
        assert "myschema" in content

    def test_ensures_output_directory(self):
        """save_sql_comments creates the output directory."""
        fs = InMemoryFileSystem()
        profile = self._make_profile()

        save_sql_comments(profile, output_dir="output/sql", fs=fs)

        assert Path("output/sql") in fs.directories

    def test_facts_only_mode(self):
        """save_sql_comments passes facts_only through to generation."""
        fs = InMemoryFileSystem()
        profile = self._make_profile()

        result_path = save_sql_comments(
            profile, output_dir="output/sql", facts_only=True, fs=fs
        )

        content = fs.files[result_path]
        assert "facts-only mode" in content

    def test_defaults_to_real_filesystem(self):
        """When fs is not provided, defaults to RealFileSystem."""
        profile = self._make_profile()

        with patch("metadata_generator.sql.RealFileSystem") as MockFS:
            mock_instance = MagicMock()
            MockFS.return_value = mock_instance
            save_sql_comments(profile, output_dir="/tmp/test_sql")

            mock_instance.ensure_dir.assert_called_once()
            mock_instance.write_text.assert_called_once()


class TestExecuteSqlComments:
    """Tests for execute_sql_comments()."""

    def test_executes_statements_successfully(self, tmp_path):
        """execute_sql_comments runs SQL statements against the connection."""
        sql_file = tmp_path / "comments.sql"
        sql_file.write_text(
            "COMMENT ON TABLE schema1.t1 IS 'table one';\n"
            "COMMENT ON COLUMN schema1.t1.col1 IS 'column one';\n"
        )

        mock_conn = MagicMock()
        with patch("metadata_generator.connection.MotherDuckConnection") as MockMDC:
            MockMDC.return_value.__enter__ = MagicMock(return_value=MagicMock(conn=mock_conn))
            MockMDC.return_value.__exit__ = MagicMock(return_value=False)

            result = execute_sql_comments(sql_file, database="testdb")

        assert result is True
        assert mock_conn.execute.call_count == 2

    def test_returns_false_for_missing_file(self, tmp_path):
        """execute_sql_comments returns False if SQL file doesn't exist."""
        missing_file = tmp_path / "nonexistent.sql"
        messages = []

        result = execute_sql_comments(
            missing_file, on_progress=lambda msg: messages.append(msg)
        )

        assert result is False
        assert any("not found" in m for m in messages)

    def test_returns_false_on_execution_error(self, tmp_path):
        """execute_sql_comments returns False when statements fail."""
        sql_file = tmp_path / "bad.sql"
        sql_file.write_text("COMMENT ON TABLE bad.t IS 'test';")

        mock_conn = MagicMock()
        mock_conn.execute.side_effect = Exception("permission denied")

        with patch("metadata_generator.connection.MotherDuckConnection") as MockMDC:
            MockMDC.return_value.__enter__ = MagicMock(return_value=MagicMock(conn=mock_conn))
            MockMDC.return_value.__exit__ = MagicMock(return_value=False)

            result = execute_sql_comments(sql_file, database="testdb")

        assert result is False

    def test_verbose_prints_table_names(self, tmp_path):
        """Verbose mode reports table names being processed."""
        sql_file = tmp_path / "comments.sql"
        sql_file.write_text("COMMENT ON TABLE schema1.users IS 'Users table';")

        mock_conn = MagicMock()
        messages = []

        with patch("metadata_generator.connection.MotherDuckConnection") as MockMDC:
            MockMDC.return_value.__enter__ = MagicMock(return_value=MagicMock(conn=mock_conn))
            MockMDC.return_value.__exit__ = MagicMock(return_value=False)

            execute_sql_comments(
                sql_file,
                database="testdb",
                verbose=True,
                on_progress=lambda msg: messages.append(msg),
            )

        assert any("schema1.users" in m for m in messages)


class TestGenerateSqlCommentsWithHistory:
    """Tests for generate_sql_comments() with history parameter."""

    def test_history_joins_appear_in_output(self):
        """Join patterns from history appear in facts-only SQL output."""
        profile = SchemaProfile(
            db_id="myschema",
            database="mydb",
            tables=[
                TableProfile(
                    name="orders",
                    row_count=1000,
                    columns=[
                        ColumnProfile(
                            name="customer_id",
                            dtype="BIGINT",
                            approx_unique=200,
                        ),
                    ],
                ),
                TableProfile(
                    name="customers",
                    row_count=200,
                    columns=[
                        ColumnProfile(
                            name="customer_id",
                            dtype="BIGINT",
                            approx_unique=200,
                        ),
                    ],
                ),
            ],
        )

        history = QueryHistoryResult(
            schema="myschema",
            queries_analyzed=50,
            joins=[
                JoinCondition(
                    left_table="orders",
                    left_column="customer_id",
                    right_table="customers",
                    right_column="customer_id",
                    count=25,
                ),
            ],
        )

        sql = generate_sql_comments(profile, history=history, facts_only=True)

        # The join info should influence the column facts (e.g., fk or joins_to)
        assert "customers.customer_id" in sql

    def test_history_none_works_in_facts_mode(self):
        """facts_only mode works fine without history."""
        profile = SchemaProfile(
            db_id="myschema",
            database="mydb",
            tables=[
                TableProfile(
                    name="t1",
                    row_count=10,
                    columns=[
                        ColumnProfile(name="col1", dtype="VARCHAR", approx_unique=5,
                                      is_categorical=True, sample_values=["a", "b"]),
                    ],
                )
            ],
        )

        sql = generate_sql_comments(profile, history=None, facts_only=True)

        assert "COMMENT ON TABLE myschema.t1" in sql
        assert "facts-only mode" in sql
