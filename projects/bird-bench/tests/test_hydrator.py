"""Tests for the gold SQL hydrator."""

import pytest
from eval.hydrator import translate_sqlite_to_duckdb, GoldSQLHydrator


class TestTranslation:
    def test_simple_select(self):
        sql = "SELECT * FROM customers WHERE id = 1"
        result = translate_sqlite_to_duckdb(sql, schema="retail")
        assert "retail.customers" in result

    def test_join(self):
        sql = """
        SELECT c.name, o.total
        FROM customers c
        JOIN orders o ON c.id = o.customer_id
        """
        result = translate_sqlite_to_duckdb(sql, schema="retail")
        assert "retail.customers" in result
        assert "retail.orders" in result

    def test_strftime_arg_swap(self):
        sql = "SELECT strftime('%Y', order_date) FROM orders"
        result = translate_sqlite_to_duckdb(sql, schema="retail")
        # DuckDB expects (date, format) order
        assert "order_date" in result
        assert "'%Y'" in result

    def test_aggregation(self):
        sql = "SELECT customer_id, SUM(amount) FROM orders GROUP BY customer_id"
        result = translate_sqlite_to_duckdb(sql, schema="retail")
        assert "retail.orders" in result
        assert "SUM" in result

    def test_subquery(self):
        sql = """
        SELECT * FROM customers
        WHERE id IN (SELECT customer_id FROM orders WHERE total > 100)
        """
        result = translate_sqlite_to_duckdb(sql, schema="store")
        assert "store.customers" in result
        assert "store.orders" in result

    def test_multiple_tables(self):
        sql = """
        SELECT a.name, b.value, c.status
        FROM table_a a
        JOIN table_b b ON a.id = b.a_id
        LEFT JOIN table_c c ON b.id = c.b_id
        """
        result = translate_sqlite_to_duckdb(sql, schema="test_schema")
        assert "test_schema.table_a" in result
        assert "test_schema.table_b" in result
        assert "test_schema.table_c" in result


class TestHydrator:
    def test_dry_run_success(self):
        hydrator = GoldSQLHydrator("test_db")
        questions = [
            {"question_id": 1, "db_id": "test", "SQL": "SELECT 1"}
        ]
        summary = hydrator.hydrate(questions, dry_run=True)
        assert summary.successful == 1
        assert summary.failed == 0
        assert summary.total == 1

    def test_dry_run_multiple(self):
        hydrator = GoldSQLHydrator("test_db")
        questions = [
            {"question_id": 1, "db_id": "retail", "SQL": "SELECT * FROM customers"},
            {"question_id": 2, "db_id": "retail", "SQL": "SELECT COUNT(*) FROM orders"},
            {"question_id": 3, "db_id": "retail", "SQL": "SELECT id FROM products WHERE price > 10"},
        ]
        summary = hydrator.hydrate(questions, dry_run=True)
        assert summary.successful == 3
        assert summary.failed == 0

    def test_translation_error(self):
        hydrator = GoldSQLHydrator("test_db")
        questions = [
            {"question_id": 1, "db_id": "test", "SQL": "INVALID SQL !!!"}
        ]
        summary = hydrator.hydrate(questions, dry_run=True)
        assert summary.failed == 1
        assert summary.successful == 0
        assert len(summary.errors) == 1

    def test_mixed_success_failure(self):
        hydrator = GoldSQLHydrator("test_db")
        questions = [
            {"question_id": 1, "db_id": "test", "SQL": "SELECT 1"},
            {"question_id": 2, "db_id": "test", "SQL": "NOT VALID SQL @@@@"},
            {"question_id": 3, "db_id": "test", "SQL": "SELECT 2"},
        ]
        summary = hydrator.hydrate(questions, dry_run=True)
        assert summary.successful == 2
        assert summary.failed == 1
        assert summary.total == 3

    def test_progress_callback(self):
        hydrator = GoldSQLHydrator("test_db")
        questions = [
            {"question_id": i, "db_id": "test", "SQL": f"SELECT {i}"}
            for i in range(5)
        ]

        progress_calls = []

        def on_progress(current, total, message):
            progress_calls.append((current, total, message))

        summary = hydrator.hydrate(questions, dry_run=True, on_progress=on_progress)

        assert len(progress_calls) == 5
        assert progress_calls[0] == (1, 5, "Translating test")
        assert progress_calls[-1] == (5, 5, "Translating test")

    def test_result_contains_translated_sql(self):
        hydrator = GoldSQLHydrator("test_db")
        questions = [
            {"question_id": 1, "db_id": "retail", "SQL": "SELECT * FROM customers"}
        ]
        summary = hydrator.hydrate(questions, dry_run=True)

        assert summary.results[0].translated_sql is not None
        assert "retail.customers" in summary.results[0].translated_sql
        assert summary.results[0].original_sql == "SELECT * FROM customers"
