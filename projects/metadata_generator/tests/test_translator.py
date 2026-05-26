"""Tests for SQL translation functions in translator.py."""

import pytest
from pathlib import Path
from unittest.mock import patch, MagicMock

from metadata_generator.translator import (
    extract_tables_from_sql,
    normalize_sql,
    format_translations_for_prompt,
    save_translations,
)
from metadata_generator.models import (
    QueryTranslation,
    TranslatedQueryHistory,
)
from metadata_generator.persistence import InMemoryFileSystem


class TestExtractTablesFromSql:
    """Tests for extract_tables_from_sql()."""

    def test_single_table(self):
        """Extract single table from simple query."""
        sql = "SELECT * FROM users"
        tables = extract_tables_from_sql(sql)

        assert "users" in tables

    def test_multiple_tables_join(self):
        """Extract multiple tables from JOIN query."""
        sql = "SELECT * FROM users u JOIN orders o ON u.id = o.user_id"
        tables = extract_tables_from_sql(sql)

        assert "users" in tables
        assert "orders" in tables

    def test_subquery_tables(self):
        """Extract tables from subquery."""
        sql = """
            SELECT * FROM orders o
            WHERE o.user_id IN (SELECT id FROM users WHERE status = 'active')
        """
        tables = extract_tables_from_sql(sql)

        assert "orders" in tables
        assert "users" in tables

    def test_no_tables(self):
        """Query with no tables (e.g., SELECT 1)."""
        sql = "SELECT 1 + 1 AS result"
        tables = extract_tables_from_sql(sql)

        # May return empty or contain something depending on parser
        assert isinstance(tables, list)

    def test_invalid_sql(self):
        """Invalid SQL returns empty list."""
        sql = "THIS IS NOT SQL"
        tables = extract_tables_from_sql(sql)

        assert tables == []

    def test_returns_sorted_list(self):
        """Tables are returned sorted."""
        sql = "SELECT * FROM zebra, apple, mango"
        tables = extract_tables_from_sql(sql)

        assert tables == sorted(tables)


class TestNormalizeSql:
    """Tests for normalize_sql()."""

    def test_removes_extra_whitespace(self):
        """Extra whitespace is normalized."""
        sql = "SELECT    *   FROM   users"
        normalized = normalize_sql(sql)

        assert "    " not in normalized  # No quadruple spaces

    def test_lowercase(self):
        """SQL is lowercased."""
        sql = "SELECT * FROM USERS"
        normalized = normalize_sql(sql)

        assert normalized == normalized.lower()

    def test_equivalent_queries_normalize_same(self):
        """Semantically equivalent queries normalize to same value."""
        sql1 = "SELECT * FROM users WHERE id = 1"
        sql2 = "SELECT  *  FROM  users  WHERE  id  =  1"

        norm1 = normalize_sql(sql1)
        norm2 = normalize_sql(sql2)

        assert norm1 == norm2

    def test_invalid_sql_fallback(self):
        """Invalid SQL falls back to basic normalization."""
        sql = "NOT VALID SQL AT ALL"
        normalized = normalize_sql(sql)

        # Should still return something (basic whitespace normalization)
        assert normalized == "not valid sql at all"

    def test_handles_newlines(self):
        """Newlines are normalized."""
        sql = """
            SELECT *
            FROM users
            WHERE id = 1
        """
        normalized = normalize_sql(sql)

        # Should not contain literal newlines after normalization
        assert "\n" not in normalized


class TestFormatTranslationsForPrompt:
    """Tests for format_translations_for_prompt()."""

    def _make_history(self, n=3) -> TranslatedQueryHistory:
        translations = []
        for i in range(n):
            translations.append(
                QueryTranslation(
                    sql=f"SELECT * FROM table_{i}",
                    natural_language=f"Get all from table {i}",
                    tables_referenced=[f"table_{i}"],
                    short_question=f"All table {i} rows",
                    long_question=f"What are all the rows in table {i}?",
                )
            )
        return TranslatedQueryHistory(
            schema="test_schema",
            generated_at="2026-01-01T00:00:00",
            translations=translations,
        )

    def test_includes_schema_header(self):
        """Output includes the schema name in the header."""
        history = self._make_history()
        result = format_translations_for_prompt(history)

        assert "test_schema" in result

    def test_includes_short_questions_by_default(self):
        """By default, short questions are used."""
        history = self._make_history()
        result = format_translations_for_prompt(history)

        assert "All table 0 rows" in result
        assert "All table 1 rows" in result

    def test_use_long_questions(self):
        """use_long=True includes long questions."""
        history = self._make_history()
        result = format_translations_for_prompt(history, use_long=True)

        assert "What are all the rows in table 0?" in result

    def test_max_examples_limits_output(self):
        """max_examples limits the number of translations shown."""
        history = self._make_history(n=5)
        result = format_translations_for_prompt(history, max_examples=2)

        assert "Question 1:" in result
        assert "Question 2:" in result
        assert "Question 3:" not in result

    def test_includes_sql(self):
        """Output includes the SQL for each translation."""
        history = self._make_history(n=1)
        result = format_translations_for_prompt(history)

        assert "SELECT * FROM table_0" in result

    def test_includes_tables_referenced(self):
        """Output includes tables referenced."""
        history = self._make_history(n=1)
        result = format_translations_for_prompt(history)

        assert "Tables: table_0" in result

    def test_falls_back_to_natural_language(self):
        """Falls back to natural_language when short_question is None."""
        history = TranslatedQueryHistory(
            schema="s",
            generated_at="2026-01-01",
            translations=[
                QueryTranslation(
                    sql="SELECT 1",
                    natural_language="Fallback text",
                    short_question=None,
                    long_question=None,
                ),
            ],
        )
        result = format_translations_for_prompt(history)

        assert "Fallback text" in result


class TestSaveTranslations:
    """Tests for save_translations()."""

    def test_saves_with_database_prefix(self):
        """File is named {database}_{schema}_translations.json when database is set."""
        history = TranslatedQueryHistory(
            schema="my_schema",
            generated_at="2026-01-01",
            translations=[],
            database="my_db",
        )
        fs = InMemoryFileSystem()

        with patch("metadata_generator.translator.save_json") as mock_save:
            mock_save.return_value = Path("output/translations/my_db_my_schema_translations.json")
            result = save_translations(history, output_dir="output/translations")

        mock_save.assert_called_once_with(
            history, "output/translations", "my_db_my_schema_translations.json"
        )
        assert "my_db_my_schema_translations.json" in str(result)

    def test_saves_without_database_prefix(self):
        """File is named {schema}_translations.json when database is None."""
        history = TranslatedQueryHistory(
            schema="my_schema",
            generated_at="2026-01-01",
            translations=[],
            database=None,
        )

        with patch("metadata_generator.translator.save_json") as mock_save:
            mock_save.return_value = Path("output/translations/my_schema_translations.json")
            result = save_translations(history, output_dir="output/translations")

        mock_save.assert_called_once_with(
            history, "output/translations", "my_schema_translations.json"
        )
