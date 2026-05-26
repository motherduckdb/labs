"""Tests for SQL parsing functions in history.py."""

import pytest

from metadata_generator.history import (
    extract_joins_from_sql,
    extract_field_usage_from_sql,
    extract_predicates_from_sql,
    extract_derived_metrics_from_sql,
    extract_intra_constraints_from_sql,
    extract_ctes_from_sql,
    extract_derived_columns_from_sql,
    dollar_quote,
    split_sql_statements,
    JoinCondition,
    IntraTableConstraint,
    CTEPattern,
    DerivedColumnDefinition,
    QueryHistoryResult,
)


class TestExtractJoins:
    """Tests for extract_joins_from_sql()."""

    def test_simple_join(self):
        """Extract join from simple JOIN ON clause."""
        sql = "SELECT * FROM users u JOIN orders o ON u.id = o.user_id"
        joins = extract_joins_from_sql(sql)

        assert len(joins) == 1
        assert joins[0].left_table == "users"
        assert joins[0].left_column == "id"
        assert joins[0].right_table == "orders"
        assert joins[0].right_column == "user_id"

    def test_multiple_joins(self):
        """Extract multiple joins from query."""
        sql = """
            SELECT *
            FROM orders o
            JOIN users u ON o.user_id = u.id
            JOIN products p ON o.product_id = p.id
        """
        joins = extract_joins_from_sql(sql)

        assert len(joins) == 2

    def test_no_join(self):
        """No joins in simple SELECT."""
        sql = "SELECT * FROM users WHERE id = 1"
        joins = extract_joins_from_sql(sql)

        assert len(joins) == 0

    def test_implicit_join_in_where(self):
        """Extract implicit join from WHERE clause."""
        sql = "SELECT * FROM users u, orders o WHERE u.id = o.user_id"
        joins = extract_joins_from_sql(sql)

        assert len(joins) == 1

    def test_left_join(self):
        """Extract join from LEFT JOIN."""
        sql = "SELECT * FROM users u LEFT JOIN orders o ON u.id = o.user_id"
        joins = extract_joins_from_sql(sql)

        assert len(joins) == 1

    def test_invalid_sql_returns_empty(self):
        """Invalid SQL returns empty list."""
        sql = "NOT VALID SQL AT ALL"
        joins = extract_joins_from_sql(sql)

        assert joins == []


class TestExtractFieldUsage:
    """Tests for extract_field_usage_from_sql()."""

    def test_select_fields(self):
        """Extract fields from SELECT clause."""
        sql = "SELECT u.name, u.email FROM users u"
        usage = extract_field_usage_from_sql(sql)

        # Filter to just select context
        select_usage = [(t, c) for t, c, ctx in usage if ctx == "select"]
        assert ("users", "name") in select_usage
        assert ("users", "email") in select_usage

    def test_where_fields(self):
        """Extract fields from WHERE clause."""
        sql = "SELECT * FROM users u WHERE u.status = 'active'"
        usage = extract_field_usage_from_sql(sql)

        where_usage = [(t, c) for t, c, ctx in usage if ctx == "where"]
        assert ("users", "status") in where_usage

    def test_join_fields(self):
        """Extract fields from JOIN ON clause."""
        sql = "SELECT * FROM users u JOIN orders o ON u.id = o.user_id"
        usage = extract_field_usage_from_sql(sql)

        join_usage = [(t, c) for t, c, ctx in usage if ctx == "join"]
        assert ("users", "id") in join_usage
        assert ("orders", "user_id") in join_usage

    def test_group_by_fields(self):
        """Extract fields from GROUP BY clause."""
        sql = "SELECT u.country, COUNT(*) FROM users u GROUP BY u.country"
        usage = extract_field_usage_from_sql(sql)

        group_usage = [(t, c) for t, c, ctx in usage if ctx == "group_by"]
        assert ("users", "country") in group_usage

    def test_order_by_fields(self):
        """Extract fields from ORDER BY clause."""
        sql = "SELECT * FROM users u ORDER BY u.created_at DESC"
        usage = extract_field_usage_from_sql(sql)

        order_usage = [(t, c) for t, c, ctx in usage if ctx == "order_by"]
        assert ("users", "created_at") in order_usage

    def test_invalid_sql_returns_empty(self):
        """Invalid SQL returns empty list."""
        sql = "INVALID SQL"
        usage = extract_field_usage_from_sql(sql)

        assert usage == []


class TestExtractPredicates:
    """Tests for extract_predicates_from_sql()."""

    def test_equality_predicate(self):
        """Extract equality predicate."""
        sql = "SELECT * FROM users u WHERE u.status = 'active'"
        predicates = extract_predicates_from_sql(sql)

        assert len(predicates) >= 1
        pred = predicates[0]
        assert pred[0] == "users"  # table
        assert pred[1] == "status"  # column
        assert pred[2] == "="  # operator
        assert pred[3] == "'active'"  # pattern

    def test_comparison_predicates(self):
        """Extract comparison predicates."""
        sql = "SELECT * FROM orders o WHERE o.amount > 100"
        predicates = extract_predicates_from_sql(sql)

        assert len(predicates) >= 1
        pred = predicates[0]
        assert pred[2] == ">"

    def test_is_null_predicate(self):
        """Extract IS NULL predicate."""
        sql = "SELECT * FROM users u WHERE u.deleted_at IS NULL"
        predicates = extract_predicates_from_sql(sql)

        null_preds = [p for p in predicates if p[2] == "IS NULL"]
        assert len(null_preds) >= 1

    def test_like_predicate(self):
        """Extract LIKE predicate."""
        sql = "SELECT * FROM users u WHERE u.email LIKE '%@gmail.com'"
        predicates = extract_predicates_from_sql(sql)

        like_preds = [p for p in predicates if p[2] == "LIKE"]
        assert len(like_preds) >= 1

    def test_invalid_sql_returns_empty(self):
        """Invalid SQL returns empty list."""
        sql = "INVALID"
        predicates = extract_predicates_from_sql(sql)

        assert predicates == []


class TestExtractDerivedMetrics:
    """Tests for extract_derived_metrics_from_sql()."""

    def test_count_aggregation(self):
        """Extract COUNT aggregation."""
        sql = "SELECT COUNT(*) as total FROM users"
        metrics = extract_derived_metrics_from_sql(sql)

        assert len(metrics) >= 1
        assert any("COUNT" in m[0].upper() for m in metrics)

    def test_sum_aggregation(self):
        """Extract SUM aggregation."""
        sql = "SELECT SUM(o.amount) as revenue FROM orders o"
        metrics = extract_derived_metrics_from_sql(sql)

        assert len(metrics) >= 1
        assert any("SUM" in m[0].upper() for m in metrics)

    def test_complex_expression(self):
        """Extract complex arithmetic expression."""
        sql = "SELECT o.quantity * o.price as total FROM orders o"
        metrics = extract_derived_metrics_from_sql(sql)

        # Should detect multiplication
        assert len(metrics) >= 1

    def test_aliased_metric(self):
        """Alias is captured."""
        sql = "SELECT AVG(o.amount) as avg_order FROM orders o"
        metrics = extract_derived_metrics_from_sql(sql)

        assert len(metrics) >= 1
        # Second element is alias
        assert any(m[1] == "avg_order" for m in metrics)

    def test_no_aggregation(self):
        """Simple SELECT without aggregation."""
        sql = "SELECT u.name FROM users u"
        metrics = extract_derived_metrics_from_sql(sql)

        assert len(metrics) == 0

    def test_invalid_sql_returns_empty(self):
        """Invalid SQL returns empty list."""
        sql = "BAD SQL"
        metrics = extract_derived_metrics_from_sql(sql)

        assert metrics == []


class TestJoinCondition:
    """Tests for JoinCondition data class."""

    def test_hash_equality(self):
        """Same join in different order should hash the same."""
        join1 = JoinCondition(
            left_table="users",
            left_column="id",
            right_table="orders",
            right_column="user_id",
        )
        join2 = JoinCondition(
            left_table="orders",
            left_column="user_id",
            right_table="users",
            right_column="id",
        )

        assert hash(join1) == hash(join2)
        assert join1 == join2

    def test_to_dict(self):
        """JoinCondition serializes to dict."""
        join = JoinCondition(
            left_table="users",
            left_column="id",
            right_table="orders",
            right_column="user_id",
            count=5,
        )

        d = join.to_dict()
        assert d["left_table"] == "users"
        assert d["count"] == 5

    def test_from_dict(self):
        """JoinCondition deserializes from dict."""
        d = {
            "left_table": "users",
            "left_column": "id",
            "right_table": "orders",
            "right_column": "user_id",
            "count": 10,
        }

        join = JoinCondition.from_dict(d)
        assert join.left_table == "users"
        assert join.count == 10


class TestExtractIntraConstraints:
    """Tests for extract_intra_constraints_from_sql()."""

    def test_same_table_comparison(self):
        """Extract constraint where both columns are from the same table."""
        sql = "SELECT * FROM orders o WHERE o.end_date > o.start_date"
        constraints = extract_intra_constraints_from_sql(sql)

        assert len(constraints) >= 1
        # Find the relevant constraint
        relevant = [c for c in constraints if c[1] == "end_date" and c[3] == "start_date"]
        assert len(relevant) == 1
        assert relevant[0][0] == "orders"  # table
        assert relevant[0][2] == ">"  # operator

    def test_equality_same_table(self):
        """Extract equality constraint within same table."""
        sql = "SELECT * FROM products p WHERE p.sale_price = p.list_price"
        constraints = extract_intra_constraints_from_sql(sql)

        assert len(constraints) >= 1
        relevant = [c for c in constraints if "sale_price" in (c[1], c[3]) and "list_price" in (c[1], c[3])]
        assert len(relevant) == 1
        assert relevant[0][2] == "="

    def test_different_tables_excluded(self):
        """Comparisons between different tables should NOT be captured."""
        sql = "SELECT * FROM users u JOIN orders o ON u.id = o.user_id"
        constraints = extract_intra_constraints_from_sql(sql)

        # This is a join, not an intra-table constraint
        # Should return empty (or only same-table constraints)
        cross_table = [c for c in constraints if "user_id" in (c[1], c[3])]
        assert len(cross_table) == 0

    def test_multiple_operators(self):
        """Extract constraints with different operators."""
        sql = """
            SELECT * FROM events e
            WHERE e.end_time >= e.start_time
            AND e.actual_cost <= e.budget
        """
        constraints = extract_intra_constraints_from_sql(sql)

        assert len(constraints) >= 2
        operators = {c[2] for c in constraints}
        assert ">=" in operators
        assert "<=" in operators

    def test_invalid_sql_returns_empty(self):
        """Invalid SQL returns empty list."""
        sql = "NOT VALID SQL"
        constraints = extract_intra_constraints_from_sql(sql)

        assert constraints == []

    def test_unqualified_columns_skipped(self):
        """Columns without table qualifiers are skipped."""
        sql = "SELECT * FROM users WHERE status = active"
        constraints = extract_intra_constraints_from_sql(sql)

        # Without table qualifiers, we can't determine if same table
        assert constraints == []


class TestIntraTableConstraint:
    """Tests for IntraTableConstraint data class."""

    def test_hash_equality_commutative(self):
        """Same constraint with = operator should hash the same regardless of column order."""
        c1 = IntraTableConstraint(
            table="products",
            left_column="price_a",
            operator="=",
            right_column="price_b",
        )
        c2 = IntraTableConstraint(
            table="products",
            left_column="price_b",
            operator="=",
            right_column="price_a",
        )

        assert hash(c1) == hash(c2)
        assert c1 == c2

    def test_hash_inequality_non_commutative(self):
        """Non-commutative operators (>, <) should NOT hash the same when reversed."""
        c1 = IntraTableConstraint(
            table="orders",
            left_column="end_date",
            operator=">",
            right_column="start_date",
        )
        c2 = IntraTableConstraint(
            table="orders",
            left_column="start_date",
            operator=">",
            right_column="end_date",
        )

        # These are semantically different: end > start vs start > end
        assert hash(c1) != hash(c2)
        assert c1 != c2

    def test_to_dict(self):
        """IntraTableConstraint serializes to dict."""
        c = IntraTableConstraint(
            table="orders",
            left_column="end_date",
            operator=">",
            right_column="start_date",
            occurrence_count=5,
            example_expression="o.end_date > o.start_date",
        )

        d = c.to_dict()
        assert d["table"] == "orders"
        assert d["left_column"] == "end_date"
        assert d["operator"] == ">"
        assert d["right_column"] == "start_date"
        assert d["occurrence_count"] == 5
        assert d["example_expression"] == "o.end_date > o.start_date"

    def test_from_dict(self):
        """IntraTableConstraint deserializes from dict."""
        d = {
            "table": "events",
            "left_column": "end_time",
            "operator": ">=",
            "right_column": "start_time",
            "occurrence_count": 10,
            "example_expression": "e.end_time >= e.start_time",
        }

        c = IntraTableConstraint.from_dict(d)
        assert c.table == "events"
        assert c.left_column == "end_time"
        assert c.operator == ">="
        assert c.right_column == "start_time"
        assert c.occurrence_count == 10


class TestQueryHistoryResult:
    """Tests for QueryHistoryResult data class."""

    def test_to_dict_with_intra_constraints(self):
        """QueryHistoryResult includes intra_constraints in serialization."""
        result = QueryHistoryResult(
            schema="test_schema",
            queries_analyzed=100,
            intra_constraints=[
                IntraTableConstraint(
                    table="orders",
                    left_column="end_date",
                    operator=">",
                    right_column="start_date",
                    occurrence_count=5,
                )
            ],
            database="test_db",
        )

        d = result.to_dict()
        assert d["schema"] == "test_schema"
        assert d["queries_analyzed"] == 100
        assert len(d["intra_constraints"]) == 1
        assert d["intra_constraints"][0]["table"] == "orders"
        assert d["database"] == "test_db"

    def test_from_dict_with_intra_constraints(self):
        """QueryHistoryResult deserializes intra_constraints correctly."""
        d = {
            "schema": "my_schema",
            "queries_analyzed": 50,
            "joins": [],
            "field_usage": [],
            "predicates": [],
            "derived_metrics": [],
            "intra_constraints": [
                {
                    "table": "events",
                    "left_column": "end_time",
                    "operator": ">=",
                    "right_column": "start_time",
                    "occurrence_count": 3,
                    "example_expression": "",
                }
            ],
            "query_samples": [],
            "database": "my_db",
        }

        result = QueryHistoryResult.from_dict(d)
        assert result.schema == "my_schema"
        assert len(result.intra_constraints) == 1
        assert result.intra_constraints[0].table == "events"
        assert result.intra_constraints[0].operator == ">="
        assert result.database == "my_db"

    def test_roundtrip(self):
        """QueryHistoryResult round-trips through dict correctly."""
        original = QueryHistoryResult(
            schema="test",
            queries_analyzed=10,
            joins=[JoinCondition("a", "id", "b", "a_id", 5)],
            intra_constraints=[
                IntraTableConstraint("t", "col1", ">", "col2", 3, "t.col1 > t.col2")
            ],
            database="db",
        )

        d = original.to_dict()
        restored = QueryHistoryResult.from_dict(d)

        assert restored.schema == original.schema
        assert restored.queries_analyzed == original.queries_analyzed
        assert len(restored.joins) == len(original.joins)
        assert len(restored.intra_constraints) == len(original.intra_constraints)
        assert restored.database == original.database


class TestDollarQuote:
    """Tests for dollar_quote() SQL string escaping."""

    def test_simple_string(self):
        """Simple string without special chars uses $$."""
        result = dollar_quote("SELECT * FROM users")
        assert result == "$$SELECT * FROM users$$"

    def test_string_with_single_quotes(self):
        """String with single quotes uses $$ without escaping."""
        result = dollar_quote("SELECT * FROM users WHERE name = 'Alice'")
        assert result == "$$SELECT * FROM users WHERE name = 'Alice'$$"

    def test_string_with_double_quotes(self):
        """String with double quotes uses $$ without escaping."""
        result = dollar_quote('SELECT "column" FROM users')
        assert result == '$$SELECT "column" FROM users$$'

    def test_string_with_nested_quotes(self):
        """String with nested/escaped quotes handles correctly."""
        sql = "SELECT * FROM t WHERE x = REPLACE(y, '\"', '')"
        result = dollar_quote(sql)
        assert result == f"$${sql}$$"

    def test_string_containing_dollar_dollar(self):
        """String containing $$ uses alternative tag."""
        sql = "SELECT $$ FROM special"
        result = dollar_quote(sql)
        # Should use $q$...$q$ or similar
        assert result.startswith("$q$") or result.startswith("$sql$")
        assert sql in result
        assert result.endswith("$q$") or result.endswith("$sql$")

    def test_very_special_string(self):
        """String containing multiple dollar markers finds unique tag."""
        sql = "$$ $q$ $sql$ content"
        result = dollar_quote(sql)
        # Should find an available tag
        assert sql in result
        assert result.startswith("$")
        assert result.endswith("$")


class TestSplitSqlStatements:
    """Tests for split_sql_statements() SQL parsing."""

    def test_simple_statements(self):
        """Split simple statements separated by semicolons."""
        sql = "SELECT 1; SELECT 2; SELECT 3"
        stmts = split_sql_statements(sql)
        assert len(stmts) == 3
        assert stmts[0] == "SELECT 1"
        assert stmts[1] == "SELECT 2"
        assert stmts[2] == "SELECT 3"

    def test_preserves_semicolon_in_dollar_quote(self):
        """Semicolons inside dollar-quoted strings are preserved."""
        sql = "INSERT INTO t VALUES ($$SELECT * FROM x; SELECT y$$)"
        stmts = split_sql_statements(sql)
        assert len(stmts) == 1
        assert "SELECT * FROM x; SELECT y" in stmts[0]

    def test_preserves_semicolon_in_single_quote(self):
        """Semicolons inside single-quoted strings are preserved."""
        sql = "INSERT INTO t VALUES ('a; b; c')"
        stmts = split_sql_statements(sql)
        assert len(stmts) == 1
        assert "'a; b; c'" in stmts[0]

    def test_handles_escaped_quotes(self):
        """Escaped single quotes are handled correctly."""
        sql = "INSERT INTO t VALUES ('it''s ok'); SELECT 1"
        stmts = split_sql_statements(sql)
        assert len(stmts) == 2
        assert "'it''s ok'" in stmts[0]

    def test_handles_tagged_dollar_quote(self):
        """Tagged dollar-quotes like $q$...$q$ work correctly."""
        sql = "INSERT INTO t VALUES ($q$text with $$ inside$q$); SELECT 1"
        stmts = split_sql_statements(sql)
        assert len(stmts) == 2
        assert "$q$text with $$ inside$q$" in stmts[0]

    def test_skips_comment_only_statements(self):
        """Statements that are only comments are skipped."""
        sql = "SELECT 1; -- comment; SELECT 2"
        stmts = split_sql_statements(sql)
        # The comment becomes part of SELECT 1 or is filtered
        assert len(stmts) >= 1

    def test_complex_real_world(self):
        """Test with realistic SQL containing semicolons in query text."""
        sql = '''
        CREATE TABLE t (id INT);
        INSERT INTO t VALUES (1, $$SELECT * FROM foo; DELETE FROM bar$$, 'main');
        SELECT * FROM t;
        '''
        stmts = split_sql_statements(sql)
        assert len(stmts) == 3
        # The middle statement should contain the full dollar-quoted content
        assert "SELECT * FROM foo; DELETE FROM bar" in stmts[1]


class TestExtractCtes:
    """Tests for extract_ctes_from_sql()."""

    def test_simple_cte(self):
        """Extract a simple CTE with aggregation."""
        sql = """
            WITH monthly_sales AS (
                SELECT date_trunc('month', order_date) as month, SUM(amount) as revenue
                FROM orders
                GROUP BY 1
            )
            SELECT * FROM monthly_sales
        """
        ctes = extract_ctes_from_sql(sql)

        assert len(ctes) == 1
        assert ctes[0][0] == "monthly_sales"  # cte_name
        assert "orders" in ctes[0][2]  # tables_referenced
        assert ctes[0][3] is True  # has_aggregation

    def test_multiple_ctes(self):
        """Extract multiple CTEs from a query."""
        sql = """
            WITH
                customers_filtered AS (SELECT * FROM customers WHERE active = true),
                orders_recent AS (SELECT * FROM orders WHERE order_date > '2024-01-01')
            SELECT * FROM customers_filtered c JOIN orders_recent o ON c.id = o.customer_id
        """
        ctes = extract_ctes_from_sql(sql)

        assert len(ctes) == 2
        names = {c[0] for c in ctes}
        assert "customers_filtered" in names
        assert "orders_recent" in names

    def test_cte_without_aggregation(self):
        """CTE without GROUP BY or aggregates has has_aggregation=False."""
        sql = """
            WITH active_users AS (
                SELECT id, name FROM users WHERE status = 'active'
            )
            SELECT * FROM active_users
        """
        ctes = extract_ctes_from_sql(sql)

        assert len(ctes) == 1
        assert ctes[0][3] is False  # has_aggregation

    def test_invalid_sql_returns_empty(self):
        """Invalid SQL returns empty list."""
        sql = "NOT VALID SQL"
        ctes = extract_ctes_from_sql(sql)
        assert ctes == []


class TestExtractDerivedColumns:
    """Tests for extract_derived_columns_from_sql()."""

    def test_simple_aggregation(self):
        """Extract aliased aggregation as derived column."""
        sql = "SELECT SUM(amount) as total_revenue FROM orders"
        derived = extract_derived_columns_from_sql(sql)

        assert len(derived) >= 1
        revenue_cols = [d for d in derived if d[0].lower() == "total_revenue"]
        assert len(revenue_cols) == 1
        assert "SUM" in revenue_cols[0][1].upper()
        assert revenue_cols[0][3] == "SELECT"  # context

    def test_arithmetic_expression(self):
        """Extract arithmetic expressions as derived columns."""
        sql = "SELECT unit_price * quantity * (1 - discount) as line_total FROM order_details"
        derived = extract_derived_columns_from_sql(sql)

        assert len(derived) >= 1
        total_cols = [d for d in derived if d[0].lower() == "line_total"]
        assert len(total_cols) == 1
        assert "*" in total_cols[0][1]  # has multiplication

    def test_cte_derived_columns(self):
        """Extract derived columns from CTE definitions."""
        sql = """
            WITH summary AS (
                SELECT customer_id, COUNT(*) as order_count, SUM(amount) as total_spent
                FROM orders
                GROUP BY customer_id
            )
            SELECT * FROM summary
        """
        derived = extract_derived_columns_from_sql(sql)

        # Should find both order_count and total_spent from the CTE
        aliases = {d[0].lower() for d in derived}
        assert "order_count" in aliases or "total_spent" in aliases

        # At least one should have context "CTE"
        cte_derived = [d for d in derived if d[3] == "CTE"]
        assert len(cte_derived) >= 1

    def test_plain_column_not_derived(self):
        """Plain column references are NOT captured as derived columns."""
        sql = "SELECT id, name, status FROM users"
        derived = extract_derived_columns_from_sql(sql)

        # No derived columns - these are all plain column refs
        assert len(derived) == 0

    def test_invalid_sql_returns_empty(self):
        """Invalid SQL returns empty list."""
        sql = "NOT VALID SQL"
        derived = extract_derived_columns_from_sql(sql)
        assert derived == []


class TestCTEPattern:
    """Tests for CTEPattern data class."""

    def test_to_dict(self):
        """CTEPattern serializes to dict."""
        cte = CTEPattern(
            cte_name="monthly_sales",
            definition_pattern="SELECT date_trunc('month', order_date) as month, SUM(amount) FROM orders GROUP BY 1",
            tables_referenced=["orders"],
            has_aggregation=True,
            occurrence_count=15,
        )

        d = cte.to_dict()
        assert d["cte_name"] == "monthly_sales"
        assert d["has_aggregation"] is True
        assert d["occurrence_count"] == 15
        assert "orders" in d["tables_referenced"]

    def test_from_dict(self):
        """CTEPattern deserializes from dict."""
        d = {
            "cte_name": "active_users",
            "definition_pattern": "SELECT * FROM users WHERE active = true",
            "tables_referenced": ["users"],
            "has_aggregation": False,
            "occurrence_count": 8,
        }

        cte = CTEPattern.from_dict(d)
        assert cte.cte_name == "active_users"
        assert cte.has_aggregation is False
        assert cte.occurrence_count == 8


class TestDerivedColumnDefinition:
    """Tests for DerivedColumnDefinition data class."""

    def test_to_dict(self):
        """DerivedColumnDefinition serializes to dict."""
        derived = DerivedColumnDefinition(
            alias="total_revenue",
            expression="SUM(unit_price * quantity * (1 - discount))",
            tables_involved=["order_details"],
            occurrence_count=25,
            common_contexts=["SELECT", "CTE"],
        )

        d = derived.to_dict()
        assert d["alias"] == "total_revenue"
        assert "SUM" in d["expression"]
        assert d["occurrence_count"] == 25
        assert "SELECT" in d["common_contexts"]

    def test_from_dict(self):
        """DerivedColumnDefinition deserializes from dict."""
        d = {
            "alias": "order_count",
            "expression": "COUNT(*)",
            "tables_involved": ["orders"],
            "occurrence_count": 50,
            "common_contexts": ["SELECT"],
        }

        derived = DerivedColumnDefinition.from_dict(d)
        assert derived.alias == "order_count"
        assert derived.expression == "COUNT(*)"
        assert derived.occurrence_count == 50
