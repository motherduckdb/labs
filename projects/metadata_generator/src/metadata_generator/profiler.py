"""
Database Profiler for MotherDuck

Uses DuckDB's SUMMARIZE function to extract rich column statistics
for database introspection and metadata generation.
"""

import json
import logging
import os
from pathlib import Path

import duckdb

logger = logging.getLogger(__name__)

from metadata_generator.config import (
    CATEGORICAL_THRESHOLD,
    MINHASH_NUM_PERM,
    MINHASH_MAX_CARDINALITY,
    MINHASH_SAMPLE_SIZE,
    SIMILARITY_THRESHOLD,
    STRING_SHAPE_SAMPLE_SIZE,
    CATEGORICAL_SAMPLE_LIMIT,
    PATTERN_DETECTION_SAMPLE_SIZE,
    PATTERN_MATCH_THRESHOLD,
    ORPHAN_SAMPLE_LIMIT,
    ORPHAN_MAX_DISTINCT,
)
from metadata_generator.connection import MotherDuckConnection
from metadata_generator.models import ColumnProfile, ColumnSimilarity, TableProfile, SchemaProfile
from metadata_generator.persistence import save_json, load_json
from metadata_generator.progress import ProgressCallback, ProgressReporter


def _quote_ident(name: str) -> str:
    """Quote a SQL identifier, escaping any embedded double quotes."""
    return '"' + name.replace('"', '""') + '"'


class DatabaseProfiler:
    """Profiles database schemas using DuckDB's SUMMARIZE function."""

    def __init__(
        self,
        motherduck_token: str | None = None,
        database: str = "bird_bench",
    ):
        """
        Initialize the profiler.

        Args:
            motherduck_token: MotherDuck API token. Falls back to MOTHERDUCK_TOKEN env var.
            database: MotherDuck database name to connect to.
        """
        self._db = MotherDuckConnection(database, motherduck_token)
        self.database = database

    @property
    def conn(self) -> duckdb.DuckDBPyConnection:
        """Get database connection."""
        return self._db.conn

    def close(self):
        """Close database connection."""
        self._db.close()

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.close()

    def list_schemas(self) -> list[str]:
        """List all user schemas (excluding system schemas)."""
        result = self.conn.execute("""
            SELECT DISTINCT table_schema
            FROM information_schema.tables
            WHERE table_catalog = ?
              AND table_schema NOT IN ('information_schema', 'pg_catalog', 'main')
            ORDER BY table_schema
        """, [self.database]).fetchall()
        return [row[0] for row in result]

    def get_tables(self, schema: str) -> list[tuple[str, str]]:
        """Get list of tables in a schema with their types.

        Returns:
            List of (table_name, table_type) tuples where table_type is
            'BASE TABLE' or 'VIEW'.
        """
        result = self.conn.execute("""
            SELECT table_name, table_type
            FROM information_schema.tables
            WHERE table_catalog = ?
              AND table_schema = ?
            ORDER BY table_name
        """, [self.database, schema]).fetchall()
        return [(row[0], row[1]) for row in result]

    def get_sample_values(
        self, schema: str, table: str, column: str, limit: int = 5
    ) -> list[str]:
        """Get sample distinct values for a column."""
        try:
            result = self.conn.execute(f"""
                SELECT DISTINCT "{column}"
                FROM {schema}."{table}"
                WHERE "{column}" IS NOT NULL
                LIMIT {limit}
            """).fetchall()
            return [str(row[0]) for row in result]
        except duckdb.Error as e:
            logger.warning(f"Failed to get sample values for {schema}.{table}.{column}: {e}")
            return []

    def _safe_float(self, value) -> float | None:
        """Safely convert a value to float, handling NA types and non-numeric values."""
        import pandas as pd

        # Handle None and pandas NA types
        if value is None or pd.isna(value):
            return None

        # Try to convert to float
        try:
            return float(value)
        except (ValueError, TypeError):
            # Can't convert (e.g., datetime strings)
            return None

    def _safe_int(self, value) -> int | None:
        """Safely convert a value to int, handling NA types."""
        import pandas as pd

        if value is None or pd.isna(value):
            return None

        try:
            return int(value)
        except (ValueError, TypeError):
            return None

    def _safe_str(self, value) -> str | None:
        """Safely convert a value to string, handling NA types."""
        import pandas as pd

        if value is None or pd.isna(value):
            return None

        return str(value)

    def _is_string_type(self, dtype: str) -> bool:
        """Check if a column type is a string/text type."""
        dtype_upper = dtype.upper()
        return any(t in dtype_upper for t in ["VARCHAR", "TEXT", "STRING", "CHAR"])

    def _analyze_string_shape(
        self, schema: str, table: str, column: str
    ) -> tuple[int | None, int | None, float | None, dict | None]:
        """
        Analyze string shape: length statistics and character composition.

        Returns:
            Tuple of (min_length, max_length, avg_length, char_composition)
        """
        try:
            result = self.conn.execute(f"""
                SELECT
                    MIN(LENGTH(CAST("{column}" AS VARCHAR))) as min_len,
                    MAX(LENGTH(CAST("{column}" AS VARCHAR))) as max_len,
                    AVG(LENGTH(CAST("{column}" AS VARCHAR))) as avg_len,
                    SUM(LENGTH(REGEXP_REPLACE(CAST("{column}" AS VARCHAR), '[^a-zA-Z]', '', 'g')))::DOUBLE /
                        NULLIF(SUM(LENGTH(CAST("{column}" AS VARCHAR))), 0) as alpha_ratio,
                    SUM(LENGTH(REGEXP_REPLACE(CAST("{column}" AS VARCHAR), '[^0-9]', '', 'g')))::DOUBLE /
                        NULLIF(SUM(LENGTH(CAST("{column}" AS VARCHAR))), 0) as numeric_ratio
                FROM (
                    SELECT "{column}"
                    FROM {schema}."{table}"
                    WHERE "{column}" IS NOT NULL
                    LIMIT {STRING_SHAPE_SAMPLE_SIZE}
                ) sample
            """).fetchone()

            if not result:
                return None, None, None, None

            min_len = self._safe_int(result[0])
            max_len = self._safe_int(result[1])
            avg_len = self._safe_float(result[2])
            alpha_ratio = self._safe_float(result[3]) or 0.0
            numeric_ratio = self._safe_float(result[4]) or 0.0

            # Calculate special character ratio
            special_ratio = max(0.0, 1.0 - alpha_ratio - numeric_ratio)

            char_composition = {
                "alpha": round(alpha_ratio, 2),
                "numeric": round(numeric_ratio, 2),
                "special": round(special_ratio, 2),
            }

            return min_len, max_len, avg_len, char_composition
        except duckdb.Error as e:
            logger.warning(f"Failed to analyze string shape for {schema}.{table}.{column}: {e}")
            return None, None, None, None

    def _detect_pattern(self, sample_values: list[str] | None) -> str | None:
        """
        Detect common patterns in sample values.

        Returns pattern name if 80%+ of values match, else None.
        """
        import re

        if not sample_values or len(sample_values) == 0:
            return None

        patterns = {
            "email": re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", re.IGNORECASE),
            "uuid": re.compile(
                r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
                re.IGNORECASE,
            ),
            "url": re.compile(r"^https?://", re.IGNORECASE),
            "phone": re.compile(
                r"^[\+]?[(]?[0-9]{1,3}[)]?[-\s\.]?[0-9]{3}[-\s\.]?[0-9]{4,6}$"
            ),
            "date_string": re.compile(
                r"^(\d{4}[-/]\d{2}[-/]\d{2}|\d{2}[-/]\d{2}[-/]\d{4}|\d{2}[-/]\d{2}[-/]\d{2})$"
            ),
        }

        total = len(sample_values)

        for pattern_name, regex in patterns.items():
            matches = sum(1 for v in sample_values if regex.match(str(v)))
            if matches / total >= PATTERN_MATCH_THRESHOLD:
                return pattern_name

        return None

    def _get_column_values_for_minhash(
        self, schema: str, table: str, column: str
    ) -> list[str]:
        """Get distinct column values for MinHash computation."""
        try:
            result = self.conn.execute(f"""
                SELECT DISTINCT CAST("{column}" AS VARCHAR) as val
                FROM {schema}."{table}"
                WHERE "{column}" IS NOT NULL
                LIMIT {MINHASH_SAMPLE_SIZE}
            """).fetchall()
            return [row[0] for row in result if row[0] is not None]
        except duckdb.Error as e:
            logger.warning(f"Failed to get MinHash values for {schema}.{table}.{column}: {e}")
            return []

    def _compute_minhash(self, values: list[str]) -> "MinHash | None":
        """Compute MinHash signature for a set of values."""
        from datasketch import MinHash

        if not values:
            return None

        m = MinHash(num_perm=MINHASH_NUM_PERM)
        for val in values:
            m.update(str(val).encode("utf8"))
        return m

    def _classify_relationship(
        self, similarity: float, source_unique: int | None, target_unique: int | None
    ) -> str:
        """Classify the likely relationship type based on similarity and cardinality.

        Requires N:1 or 1:N cardinality for foreign_key classification.
        N:N relationships (both sides non-unique with similar cardinality)
        are classified as shared_dimension since the overlap is likely
        coincidental (e.g., integer stat columns sharing a value range).
        """
        if similarity >= 0.9:
            if source_unique and target_unique:
                # Check for N:1 or 1:N pattern (one side has significantly more unique values)
                ratio = min(source_unique, target_unique) / max(source_unique, target_unique)
                if ratio < 0.5:
                    # Clear cardinality asymmetry -> likely FK
                    return "foreign_key"
                else:
                    # Similar cardinality on both sides -> likely coincidental overlap
                    # (e.g., two stat columns both containing 0-30)
                    return "shared_dimension"
            return "foreign_key"
        elif similarity >= 0.7:
            return "shared_dimension"
        else:
            return "partial_overlap"

    def _compute_column_similarities(
        self, table_profiles: list[TableProfile], schema: str, verbose: bool = False,
        view_temp_tables: dict[str, str] | None = None,
    ) -> list[ColumnSimilarity]:
        """
        Compute MinHash similarities between all eligible column pairs.

        Args:
            table_profiles: List of profiled tables
            schema: Schema name
            verbose: Print progress
            view_temp_tables: Mapping of view name -> temp table name for
                              materialized views

        Returns:
            List of detected column similarities
        """
        from datasketch import MinHash

        view_temp_tables = view_temp_tables or {}

        # Build list of (table, column, approx_unique) for eligible columns
        eligible_columns: list[tuple[str, str, int | None]] = []
        for table in table_profiles:
            for col in table.columns:
                # Only include columns with reasonable cardinality
                if (
                    col.approx_unique is not None
                    and col.approx_unique > 1  # Skip single-value columns
                    and col.approx_unique <= MINHASH_MAX_CARDINALITY
                ):
                    eligible_columns.append((table.name, col.name, col.approx_unique))

        if len(eligible_columns) < 2:
            return []

        if verbose:
            print(f"\n  Computing MinHash for {len(eligible_columns)} columns...")

        # Compute MinHash for each eligible column
        minhashes: dict[tuple[str, str], MinHash] = {}
        for i, (table_name, col_name, _) in enumerate(eligible_columns):
            if verbose:
                print(f"    [{i+1}/{len(eligible_columns)}] {table_name}.{col_name}", end="", flush=True)

            query_table = view_temp_tables.get(table_name, table_name)
            values = self._get_column_values_for_minhash(schema, query_table, col_name)
            mh = self._compute_minhash(values)
            if mh:
                minhashes[(table_name, col_name)] = mh

            if verbose:
                print(f" ({len(values)} values)")

        if verbose:
            print(f"  Comparing {len(minhashes)} column pairs...")

        # Compare all pairs
        similarities: list[ColumnSimilarity] = []
        keys = list(minhashes.keys())

        for i, (table1, col1) in enumerate(keys):
            for table2, col2 in keys[i + 1 :]:
                # Skip same-table comparisons (optional, can be useful)
                if table1 == table2:
                    continue

                mh1 = minhashes[(table1, col1)]
                mh2 = minhashes[(table2, col2)]

                jaccard = mh1.jaccard(mh2)

                if jaccard >= SIMILARITY_THRESHOLD:
                    # Get cardinalities for classification
                    source_unique = next(
                        (u for t, c, u in eligible_columns if t == table1 and c == col1),
                        None,
                    )
                    target_unique = next(
                        (u for t, c, u in eligible_columns if t == table2 and c == col2),
                        None,
                    )

                    relationship = self._classify_relationship(
                        jaccard, source_unique, target_unique
                    )

                    similarities.append(
                        ColumnSimilarity(
                            source_table=table1,
                            source_column=col1,
                            target_table=table2,
                            target_column=col2,
                            jaccard_similarity=round(jaccard, 3),
                            likely_relationship=relationship,
                        )
                    )

        # Sort by similarity descending
        similarities.sort(key=lambda x: x.jaccard_similarity, reverse=True)

        # Compute orphaned values for detected pairs
        if similarities:
            # Build cardinality lookup for skip check
            cardinality: dict[tuple[str, str], int] = {
                (t, c): u for t, c, u in eligible_columns if u is not None
            }
            self._compute_orphaned_values(
                similarities, schema, view_temp_tables, cardinality, verbose,
            )

        if verbose and similarities:
            print(f"  Found {len(similarities)} column pairs with similarity >= {SIMILARITY_THRESHOLD}")

        return similarities

    def _compute_orphaned_values(
        self,
        similarities: list[ColumnSimilarity],
        schema: str,
        view_temp_tables: dict[str, str],
        cardinality: dict[tuple[str, str], int],
        verbose: bool = False,
    ) -> None:
        """Compute orphaned values for each detected similarity pair via DuckDB EXCEPT.

        Skips pairs where either side has more than ORPHAN_MAX_DISTINCT
        distinct values — orphan detection matters most for smaller, sparse
        join keys.

        Mutates each ColumnSimilarity in place, populating source_only_values,
        target_only_values, source_only_count, and target_only_count.
        """
        # Pre-filter to same-name pairs only
        eligible = [
            sim for sim in similarities
            if sim.source_column.lower() == sim.target_column.lower()
            and cardinality.get((sim.source_table, sim.source_column), 0) <= ORPHAN_MAX_DISTINCT
            and cardinality.get((sim.target_table, sim.target_column), 0) <= ORPHAN_MAX_DISTINCT
        ]

        if verbose:
            print(f"  Computing orphaned values for {len(eligible)} of {len(similarities)} pairs...")

        for sim in eligible:
            src_table = _quote_ident(view_temp_tables.get(sim.source_table, sim.source_table))
            tgt_table = _quote_ident(view_temp_tables.get(sim.target_table, sim.target_table))
            src_col = _quote_ident(sim.source_column)
            tgt_col = _quote_ident(sim.target_column)

            try:
                # Source-only: values in source but not target
                # CTE + window gets both samples and total count in one query
                rows = self.conn.execute(f"""
                    WITH orphans AS (
                        SELECT DISTINCT CAST({src_col} AS VARCHAR) AS val
                        FROM {schema}.{src_table} WHERE {src_col} IS NOT NULL
                        EXCEPT
                        SELECT DISTINCT CAST({tgt_col} AS VARCHAR) AS val
                        FROM {schema}.{tgt_table} WHERE {tgt_col} IS NOT NULL
                    )
                    SELECT val, COUNT(*) OVER () AS total_count
                    FROM orphans
                    LIMIT {ORPHAN_SAMPLE_LIMIT}
                """).fetchall()
                sim.source_only_values = [r[0] for r in rows if r[0] is not None]
                sim.source_only_count = rows[0][1] if rows else 0

                # Target-only: values in target but not source
                rows = self.conn.execute(f"""
                    WITH orphans AS (
                        SELECT DISTINCT CAST({tgt_col} AS VARCHAR) AS val
                        FROM {schema}.{tgt_table} WHERE {tgt_col} IS NOT NULL
                        EXCEPT
                        SELECT DISTINCT CAST({src_col} AS VARCHAR) AS val
                        FROM {schema}.{src_table} WHERE {src_col} IS NOT NULL
                    )
                    SELECT val, COUNT(*) OVER () AS total_count
                    FROM orphans
                    LIMIT {ORPHAN_SAMPLE_LIMIT}
                """).fetchall()
                sim.target_only_values = [r[0] for r in rows if r[0] is not None]
                sim.target_only_count = rows[0][1] if rows else 0

            except duckdb.Error as e:
                logger.warning(
                    f"Failed to compute orphans for "
                    f"{sim.source_table}.{sim.source_column} <-> "
                    f"{sim.target_table}.{sim.target_column}: {e}"
                )

    def _create_view_temp_table(self, schema: str, view: str) -> str:
        """Materialize a view into a _TEMP table for fast profiling.

        SUMMARIZE and MinHash queries on views can be extremely slow on
        MotherDuck. We materialize into a regular table (not a DuckDB temp
        table, as those don't run server-side) and return the temp table name.

        Args:
            schema: Schema name
            view: View name

        Returns:
            The unquoted temp table name (e.g., 'my_view_TEMP')
        """
        temp_name = f"{view}_TEMP"
        self.conn.execute(
            f'CREATE TABLE {schema}."{temp_name}" AS SELECT * FROM {schema}."{view}"'
        )
        return temp_name

    def _drop_view_temp_table(self, schema: str, temp_name: str) -> None:
        """Drop a materialized view temp table."""
        self.conn.execute(f'DROP TABLE IF EXISTS {schema}."{temp_name}"')

    def profile_table(
        self, schema: str, table: str, is_view: bool = False, query_table: str | None = None
    ) -> TableProfile:
        """
        Profile a single table using SUMMARIZE.

        Args:
            schema: Schema name (e.g., 'california_schools')
            table: Table name
            is_view: Whether this is a VIEW (vs BASE TABLE)
            query_table: If set, query this table instead of `table` (used for
                         materialized view temp tables). The returned profile
                         still uses the original `table` name.

        Returns:
            TableProfile with column statistics
        """
        effective_table = query_table or table

        # Get summary statistics
        summary_df = self.conn.execute(f'SUMMARIZE {schema}."{effective_table}"').fetchdf()

        # Get row count
        row_count_result = self.conn.execute(
            f'SELECT COUNT(*) FROM {schema}."{effective_table}"'
        ).fetchone()
        row_count = row_count_result[0] if row_count_result else 0

        columns = []
        for _, row in summary_df.iterrows():
            col_name = row["column_name"]
            col_type = row["column_type"]
            approx_unique = self._safe_int(row["approx_unique"])
            is_categorical = (
                approx_unique is not None
                and approx_unique <= CATEGORICAL_THRESHOLD
            )

            # Don't treat integer columns as categorical when their values
            # form a contiguous range starting at 0 (e.g., a count column
            # with values 0-10). These are numeric measures, not enums.
            if is_categorical and not self._is_string_type(col_type):
                min_val = self._safe_float(row["min"])
                max_val = self._safe_float(row["max"])
                if (
                    min_val is not None
                    and max_val is not None
                    and min_val == 0
                    and max_val > 1  # Exclude booleans (0/1)
                    and approx_unique is not None
                    and approx_unique >= (max_val + 1) * 0.6
                ):
                    is_categorical = False
            is_string = self._is_string_type(col_type)

            # Get sample values for categorical columns or string columns (for pattern detection)
            sample_values = None
            if is_categorical and approx_unique and approx_unique > 0:
                sample_values = self.get_sample_values(
                    schema, effective_table, col_name, limit=min(approx_unique, CATEGORICAL_SAMPLE_LIMIT)
                )
            elif is_string:
                # Get sample values for pattern detection
                sample_values = self.get_sample_values(
                    schema, effective_table, col_name, limit=PATTERN_DETECTION_SAMPLE_SIZE
                )

            # Analyze string shape for string columns
            min_length = None
            max_length = None
            avg_length = None
            char_composition = None
            detected_pattern = None

            if is_string:
                min_length, max_length, avg_length, char_composition = (
                    self._analyze_string_shape(schema, effective_table, col_name)
                )
                detected_pattern = self._detect_pattern(sample_values)

            col_profile = ColumnProfile(
                name=col_name,
                dtype=col_type,
                min_value=self._safe_str(row["min"]),
                max_value=self._safe_str(row["max"]),
                approx_unique=approx_unique,
                avg=self._safe_float(row["avg"]),
                std=self._safe_float(row["std"]),
                q25=self._safe_float(row["q25"]),
                q50=self._safe_float(row["q50"]),
                q75=self._safe_float(row["q75"]),
                count=self._safe_int(row["count"]) or 0,
                null_percentage=self._safe_float(row["null_percentage"]) or 0.0,
                is_categorical=is_categorical,
                sample_values=sample_values,
                min_length=min_length,
                max_length=max_length,
                avg_length=avg_length,
                detected_pattern=detected_pattern,
                char_composition=char_composition,
            )
            columns.append(col_profile)

        return TableProfile(name=table, row_count=row_count, columns=columns, is_view=is_view)

    def profile_schema(
        self,
        schema: str,
        verbose: bool = False,
        compute_similarities: bool = True,
        on_progress: ProgressCallback | None = None,
    ) -> SchemaProfile:
        """
        Profile all tables in a schema.

        Args:
            schema: Schema name to profile
            verbose: Print progress (detailed stats per table)
            compute_similarities: Whether to compute MinHash column similarities
            on_progress: Optional callback for progress reporting

        Returns:
            SchemaProfile with all table profiles
        """
        progress = ProgressReporter(on_progress, enabled=on_progress is not None)

        tables = self.get_tables(schema)
        table_profiles = []

        progress(f"Found {len(tables)} tables in schema '{schema}'")

        # Materialize views into _TEMP tables. These are kept around for
        # both SUMMARIZE (in profile_table) and MinHash (in
        # _compute_column_similarities), then dropped at the end.
        # Maps original view name -> temp table name.
        view_temp_tables: dict[str, str] = {}
        for table_name, table_type in tables:
            if table_type == "VIEW":
                try:
                    temp_name = self._create_view_temp_table(schema, table_name)
                    view_temp_tables[table_name] = temp_name
                except Exception as e:
                    progress(f"Failed to materialize view {table_name}: {e}")

        try:
            for i, (table_name, table_type) in enumerate(tables, 1):
                is_view = table_type == "VIEW"
                query_table = view_temp_tables.get(table_name)
                try:
                    profile = self.profile_table(
                        schema, table_name, is_view=is_view, query_table=query_table
                    )
                    table_profiles.append(profile)
                    if verbose:
                        categorical_cols = sum(1 for c in profile.columns if c.is_categorical)
                        kind = "view" if is_view else "table"
                        progress(f"[{i}/{len(tables)}] Profiling: {table_name} ({kind}) -> {profile.row_count:,} rows, {len(profile.columns)} cols ({categorical_cols} categorical)")
                    else:
                        progress(f"[{i}/{len(tables)}] Profiling: {table_name}")
                except Exception as e:
                    progress(f"[{i}/{len(tables)}] Profiling: {table_name} -> FAILED: {e}")
                    continue

            # Compute column similarities using MinHash
            column_similarities = []
            if compute_similarities and len(table_profiles) > 1:
                progress("Computing column similarities...")
                column_similarities = self._compute_column_similarities(
                    table_profiles, schema, verbose=verbose,
                    view_temp_tables=view_temp_tables,
                )
                progress(f"Found {len(column_similarities)} similar column pairs")
        finally:
            # Drop all materialized view temp tables
            for view_name, temp_name in view_temp_tables.items():
                try:
                    self._drop_view_temp_table(schema, temp_name)
                except Exception as e:
                    logger.warning(f"Failed to drop temp table for {view_name}: {e}")

        return SchemaProfile(
            db_id=schema,
            database=self.database,
            tables=table_profiles,
            column_similarities=column_similarities,
        )

    def save_profile(
        self, profile: SchemaProfile, output_dir: str = "output/profiles"
    ) -> Path:
        """Save profile to JSON file."""
        filename = f"{profile.database}_{profile.db_id}_profile.json"
        return save_json(profile, output_dir, filename)

    def load_profile(
        self, schema: str, profiles_dir: str = "output/profiles", database: str | None = None
    ) -> SchemaProfile | None:
        """Load cached profile from JSON file."""
        db = database or self.database
        filename = f"{db}_{schema}_profile.json"
        return load_json(SchemaProfile, Path(profiles_dir) / filename)


def format_profile_for_prompt(
    profile: SchemaProfile, tables_filter: list[str] | None = None
) -> str:
    """
    Format profile statistics as natural language for inclusion in prompts.

    Args:
        profile: The schema profile
        tables_filter: Optional list of table names to include

    Returns:
        Formatted string describing the schema with statistics
    """
    lines = [f"DATABASE PROFILE: {profile.db_id}"]
    lines.append("=" * 50)

    for table in profile.tables:
        if tables_filter and table.name not in tables_filter:
            continue

        kind = "VIEW" if table.is_view else "TABLE"
        lines.append(f"\n{kind}: {table.name} ({table.row_count:,} rows)")
        lines.append("-" * 40)

        for col in table.columns:
            col_desc = f"  {col.name}: {col.dtype}"

            stats = []
            if col.null_percentage > 0:
                stats.append(f"{col.null_percentage:.1f}% NULL")

            if col.approx_unique is not None:
                if col.is_categorical:
                    stats.append(f"{col.approx_unique} distinct values")
                else:
                    stats.append(f"~{col.approx_unique:,} unique")

            if col.avg is not None:
                stats.append(f"avg={col.avg:.2f}")

            if col.min_value is not None and col.max_value is not None:
                if not col.is_categorical:
                    stats.append(f"range=[{col.min_value}, {col.max_value}]")

            # Add shape info for string columns
            if col.detected_pattern:
                stats.append(f"pattern: {col.detected_pattern}")
            if col.avg_length is not None:
                stats.append(f"avg {col.avg_length:.0f} chars")

            if stats:
                col_desc += f" ({', '.join(stats)})"

            lines.append(col_desc)

            if col.is_categorical and col.sample_values:
                values_str = ", ".join(f"'{v}'" for v in col.sample_values[:5])
                lines.append(f"    Values: {values_str}")

            # Add character composition for string columns
            if col.char_composition:
                comp = col.char_composition
                lines.append(f"    Char mix: {comp['alpha']*100:.0f}% alpha, {comp['numeric']*100:.0f}% numeric, {comp['special']*100:.0f}% special")

    # Add column similarities section
    if profile.column_similarities:
        lines.append("\n" + "=" * 50)
        lines.append("DETECTED COLUMN RELATIONSHIPS")
        lines.append("-" * 40)
        for sim in profile.column_similarities:
            lines.append(
                f"  {sim.source_table}.{sim.source_column} <-> "
                f"{sim.target_table}.{sim.target_column}"
            )
            lines.append(
                f"    Similarity: {sim.jaccard_similarity:.1%}, "
                f"Type: {sim.likely_relationship}"
            )

    return "\n".join(lines)
