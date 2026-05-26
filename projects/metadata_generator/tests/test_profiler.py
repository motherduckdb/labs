"""Tests for view materialization and orphan detection in the profiler."""

import duckdb
import pytest

from metadata_generator.config import ORPHAN_SAMPLE_LIMIT, ORPHAN_MAX_DISTINCT
from metadata_generator.models import ColumnSimilarity
from metadata_generator.profiler import DatabaseProfiler


@pytest.fixture
def conn():
    """Create a local DuckDB connection with a schema, table, and view."""
    c = duckdb.connect(":memory:")
    c.execute("CREATE SCHEMA test_schema")
    c.execute("""
        CREATE TABLE test_schema.base_table (
            id INTEGER,
            name VARCHAR,
            amount DOUBLE
        )
    """)
    c.execute("""
        INSERT INTO test_schema.base_table VALUES
        (1, 'alice', 10.5),
        (2, 'bob', 20.0),
        (3, 'charlie', 30.75)
    """)
    c.execute("""
        CREATE VIEW test_schema.my_view AS
        SELECT id, name, amount * 2 AS doubled_amount
        FROM test_schema.base_table
    """)
    yield c
    c.close()


class TestViewMaterialization:
    """Test the create-table / summarize / drop pattern for views."""

    def test_materialize_summarize_and_minhash_then_drop(self, conn):
        """Temp table persists across SUMMARIZE and MinHash queries, then is dropped."""
        schema = "test_schema"
        view = "my_view"
        temp_name = f"{view}_TEMP"

        # Step 1: Materialize the view
        conn.execute(
            f'CREATE TABLE {schema}."{temp_name}" AS SELECT * FROM {schema}."{view}"'
        )

        # Step 2: SUMMARIZE against the temp table
        summary_df = conn.execute(f'SUMMARIZE {schema}."{temp_name}"').fetchdf()
        assert len(summary_df) == 3
        assert set(summary_df["column_name"]) == {"id", "name", "doubled_amount"}

        # Step 3: MinHash-style distinct value query against the temp table
        result = conn.execute(f"""
            SELECT DISTINCT CAST("name" AS VARCHAR) as val
            FROM {schema}."{temp_name}"
            WHERE "name" IS NOT NULL
        """).fetchall()
        assert len(result) == 3
        assert set(r[0] for r in result) == {"alice", "bob", "charlie"}

        # Step 4: Drop the temp table
        conn.execute(f'DROP TABLE IF EXISTS {schema}."{temp_name}"')

        # Verify cleanup
        tables = conn.execute("""
            SELECT table_name FROM information_schema.tables
            WHERE table_schema = 'test_schema' AND table_name = 'my_view_TEMP'
        """).fetchall()
        assert tables == []

        # Original view still works
        result = conn.execute(f'SELECT * FROM {schema}."{view}"').fetchall()
        assert len(result) == 3

    def test_temp_table_cleaned_up_on_failure(self, conn):
        """Temp table is dropped even if a query fails mid-pipeline."""
        schema = "test_schema"
        view = "my_view"
        temp_name = f"{view}_TEMP"

        conn.execute(
            f'CREATE TABLE {schema}."{temp_name}" AS SELECT * FROM {schema}."{view}"'
        )

        try:
            conn.execute("SUMMARIZE test_schema.nonexistent_table")
        except duckdb.Error:
            pass
        finally:
            conn.execute(f'DROP TABLE IF EXISTS {schema}."{temp_name}"')

        tables = conn.execute("""
            SELECT table_name FROM information_schema.tables
            WHERE table_schema = 'test_schema' AND table_name = 'my_view_TEMP'
        """).fetchall()
        assert tables == []

    def test_base_table_not_materialized(self, conn):
        """Regular tables go through SUMMARIZE directly without materialization."""
        schema = "test_schema"
        table = "base_table"

        summary_df = conn.execute(f'SUMMARIZE {schema}."{table}"').fetchdf()
        assert len(summary_df) == 3
        assert set(summary_df["column_name"]) == {"id", "name", "amount"}

        # No _TEMP table was created
        tables = conn.execute("""
            SELECT table_name FROM information_schema.tables
            WHERE table_schema = 'test_schema' AND table_name = 'base_table_TEMP'
        """).fetchall()
        assert tables == []


def _make_profiler_with_conn(conn):
    """Create a DatabaseProfiler that uses an existing DuckDB connection.

    Avoids needing a MotherDuck token for unit tests.
    """
    profiler = object.__new__(DatabaseProfiler)
    profiler.database = "test"

    class _FakeDb:
        pass

    db = _FakeDb()
    db.conn = conn
    profiler._db = db
    return profiler


@pytest.fixture
def orphan_conn():
    """Create a DuckDB connection with two tables having overlapping but non-identical values.

    Both tables use the same column name ('aci') since orphan detection
    only runs on exact column-name matches.
    """
    c = duckdb.connect(":memory:")
    c.execute("CREATE SCHEMA s")
    c.execute("CREATE TABLE s.orders (aci VARCHAR)")
    c.execute("INSERT INTO s.orders VALUES ('A'), ('B'), ('C'), ('D')")
    c.execute("CREATE TABLE s.ref_statuses (aci VARCHAR)")
    c.execute("INSERT INTO s.ref_statuses VALUES ('B'), ('C'), ('D'), ('E'), ('F')")
    yield c
    c.close()


class TestOrphanDetection:
    """Tests for _compute_orphaned_values called on DatabaseProfiler."""

    def test_computes_orphans_correctly(self, orphan_conn):
        """Detects orphaned values on both sides of a join pair."""
        profiler = _make_profiler_with_conn(orphan_conn)
        sim = ColumnSimilarity(
            source_table="orders",
            source_column="aci",
            target_table="ref_statuses",
            target_column="aci",
            jaccard_similarity=0.75,
            likely_relationship="shared_dimension",
        )
        cardinality = {
            ("orders", "aci"): 4,
            ("ref_statuses", "aci"): 5,
        }

        profiler._compute_orphaned_values([sim], "s", {}, cardinality)

        # orders has A that ref_statuses doesn't
        assert sim.source_only_count == 1
        assert set(sim.source_only_values) == {"A"}

        # ref_statuses has E, F that orders doesn't
        assert sim.target_only_count == 2
        assert set(sim.target_only_values) == {"E", "F"}

    def test_no_orphans_when_perfect_overlap(self, orphan_conn):
        """No orphans when both sides have identical value sets."""
        orphan_conn.execute("CREATE TABLE s.t1 (val VARCHAR)")
        orphan_conn.execute("CREATE TABLE s.t2 (val VARCHAR)")
        orphan_conn.execute("INSERT INTO s.t1 VALUES ('X'), ('Y'), ('Z')")
        orphan_conn.execute("INSERT INTO s.t2 VALUES ('X'), ('Y'), ('Z')")

        profiler = _make_profiler_with_conn(orphan_conn)
        sim = ColumnSimilarity(
            source_table="t1",
            source_column="val",
            target_table="t2",
            target_column="val",
            jaccard_similarity=0.99,
            likely_relationship="foreign_key",
        )
        cardinality = {("t1", "val"): 3, ("t2", "val"): 3}

        profiler._compute_orphaned_values([sim], "s", {}, cardinality)

        assert sim.source_only_count == 0
        assert sim.source_only_values == []
        assert sim.target_only_count == 0
        assert sim.target_only_values == []

    def test_respects_view_temp_tables_mapping(self, orphan_conn):
        """Uses view_temp_tables mapping to query the materialized table name."""
        # Create a "temp" table that mirrors orders under a different name
        orphan_conn.execute("CREATE TABLE s.orders_TEMP AS SELECT * FROM s.orders")

        profiler = _make_profiler_with_conn(orphan_conn)
        sim = ColumnSimilarity(
            source_table="orders",
            source_column="aci",
            target_table="ref_statuses",
            target_column="aci",
            jaccard_similarity=0.75,
            likely_relationship="shared_dimension",
        )
        cardinality = {("orders", "aci"): 4, ("ref_statuses", "aci"): 5}
        view_temp_tables = {"orders": "orders_TEMP"}

        profiler._compute_orphaned_values([sim], "s", view_temp_tables, cardinality)

        # Should still compute correct orphans via the temp table
        assert sim.source_only_count == 1
        assert set(sim.source_only_values) == {"A"}

    def test_skips_high_cardinality_pairs(self, orphan_conn):
        """Pairs where either side exceeds ORPHAN_MAX_DISTINCT are skipped."""
        profiler = _make_profiler_with_conn(orphan_conn)
        sim = ColumnSimilarity(
            source_table="orders",
            source_column="aci",
            target_table="ref_statuses",
            target_column="aci",
            jaccard_similarity=0.75,
            likely_relationship="shared_dimension",
        )
        cardinality = {
            ("orders", "aci"): ORPHAN_MAX_DISTINCT + 1,
            ("ref_statuses", "aci"): 5,
        }

        profiler._compute_orphaned_values([sim], "s", {}, cardinality)

        # Should remain at defaults — skipped entirely
        assert sim.source_only_count == 0
        assert sim.source_only_values == []
        assert sim.target_only_count == 0
        assert sim.target_only_values == []

    def test_skips_high_cardinality_target(self, orphan_conn):
        """Skips when target side exceeds ORPHAN_MAX_DISTINCT."""
        profiler = _make_profiler_with_conn(orphan_conn)
        sim = ColumnSimilarity(
            source_table="orders",
            source_column="aci",
            target_table="ref_statuses",
            target_column="aci",
            jaccard_similarity=0.75,
            likely_relationship="shared_dimension",
        )
        cardinality = {
            ("orders", "aci"): 4,
            ("ref_statuses", "aci"): ORPHAN_MAX_DISTINCT + 1,
        }

        profiler._compute_orphaned_values([sim], "s", {}, cardinality)

        assert sim.source_only_count == 0
        assert sim.target_only_count == 0

    def test_skips_different_column_names(self, orphan_conn):
        """Pairs with different column names are skipped (likely false positives)."""
        profiler = _make_profiler_with_conn(orphan_conn)
        sim = ColumnSimilarity(
            source_table="orders",
            source_column="aci",
            target_table="ref_statuses",
            target_column="other_col",
            jaccard_similarity=0.75,
            likely_relationship="shared_dimension",
        )
        cardinality = {("orders", "aci"): 4, ("ref_statuses", "other_col"): 5}

        profiler._compute_orphaned_values([sim], "s", {}, cardinality)

        assert sim.source_only_count == 0
        assert sim.target_only_count == 0

    def test_handles_duckdb_error_gracefully(self, orphan_conn):
        """DuckDB errors are logged and don't crash; similarity is left at defaults."""
        profiler = _make_profiler_with_conn(orphan_conn)
        sim = ColumnSimilarity(
            source_table="orders",
            source_column="nonexistent_col",
            target_table="ref_statuses",
            target_column="nonexistent_col",
            jaccard_similarity=0.75,
            likely_relationship="shared_dimension",
        )
        cardinality = {("orders", "nonexistent_col"): 4, ("ref_statuses", "nonexistent_col"): 5}

        # Should not raise
        profiler._compute_orphaned_values([sim], "s", {}, cardinality)

        assert sim.source_only_count == 0
        assert sim.target_only_count == 0
