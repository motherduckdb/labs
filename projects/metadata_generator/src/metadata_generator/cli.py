"""
Command-line interface for metadata-generator.

Generate metadata for MotherDuck databases:
- Profile statistics using DuckDB SUMMARIZE
- LLM-generated semantic descriptions (optional)
- SQL COMMENT statements
"""

import argparse
import json
import sys
from pathlib import Path

from dotenv import load_dotenv

from metadata_generator.profiler import DatabaseProfiler, format_profile_for_prompt
from metadata_generator.generator import (
    MetadataGenerator,
    format_descriptions_for_prompt,
    load_predicate_patterns,
    load_derived_metrics,
    load_derived_columns,
    load_query_samples,
    load_join_patterns,
    load_field_usage,
    generate_use_cases,
)
from metadata_generator.annotations import load_annotations, validate_annotations, SchemaAnnotations
from metadata_generator.sql import generate_sql_comments, save_sql_comments, execute_sql_comments
from metadata_generator.history import (
    QueryHistoryAnalyzer,
    format_joins_for_prompt,
    generate_metadata_schema_sql,
    dollar_quote,
    split_sql_statements,
)
from metadata_generator.translator import (
    translate_query_history,
    save_translations,
    format_translations_for_prompt,
)
from metadata_generator.progress import print_progress


def resolve_schemas(args) -> list[str]:
    """
    Resolve schema argument to list of schemas.

    If schema is "*", lists all schemas in the database.
    Otherwise returns the single schema as a list.
    """
    if args.schema != "*":
        return [args.schema]

    print(f"Resolving all schemas in database '{args.database}'...")
    with DatabaseProfiler(database=args.database) as profiler:
        schemas = profiler.list_schemas()
        print(f"  Found {len(schemas)} schemas: {', '.join(schemas)}")
        return schemas


def cmd_profile(args):
    """Profile a schema and output statistics."""
    load_dotenv()

    print(f"\n{'='*60}")
    print(f"PROFILE: Extracting column statistics for schema '{args.schema}'")
    print(f"{'='*60}")
    print(f"  Database: {args.database}")
    print(f"  Output directory: {args.output or args.output_dir}")
    print()

    progress_cb = print_progress if args.verbose else None
    with DatabaseProfiler(database=args.database) as profiler:
        profile = profiler.profile_schema(args.schema, verbose=args.verbose, on_progress=progress_cb)

        # Summary
        total_cols = sum(len(t.columns) for t in profile.tables)
        total_rows = sum(t.row_count for t in profile.tables)
        print(f"\nProfile complete:")
        print(f"  Tables profiled: {len(profile.tables)}")
        print(f"  Total columns: {total_cols}")
        print(f"  Total rows: {total_rows:,}")

        if args.output:
            output_path = Path(args.output)
            output_path.parent.mkdir(parents=True, exist_ok=True)
            with open(output_path, "w") as f:
                json.dump(profile.to_dict(), f, indent=2)
            print(f"\nSaved profile to: {output_path}")
        else:
            # Save to default location (uses database_schema_profile.json naming)
            output_path = profiler.save_profile(profile, args.output_dir + "/profiles")
            print(f"\nSaved profile to: {output_path}")

        if args.verbose or not args.output:
            print()
            print(format_profile_for_prompt(profile))


def cmd_describe(args):
    """Generate LLM descriptions for a schema."""
    load_dotenv()

    print(f"\n{'='*60}")
    print(f"DESCRIBE: Generating LLM descriptions for schema '{args.schema}'")
    print(f"{'='*60}")
    print(f"  Model: {args.model}")
    print()

    progress_cb = print_progress if args.verbose else None

    # First, get or load profile
    print("Loading schema profile...")
    with DatabaseProfiler(database=args.database) as profiler:
        profile_path = Path(args.profiles_dir) / f"{args.database}_{args.schema}_profile.json"

        if profile_path.exists():
            print(f"  Found cached profile: {profile_path}")
            profile = profiler.load_profile(args.schema, args.profiles_dir, database=args.database)
        else:
            print("  No cached profile found, connecting to MotherDuck to profile schema...")
            profile = profiler.profile_schema(args.schema, verbose=args.verbose, on_progress=progress_cb)
            profiler.save_profile(profile, args.profiles_dir)

    if not profile or not profile.tables:
        print("Error: No tables found in schema")
        sys.exit(1)

    total_cols = sum(len(t.columns) for t in profile.tables)
    print(f"  Profile loaded: {len(profile.tables)} tables, {total_cols} columns")
    print()

    # Load query history context if available
    predicate_patterns = None
    derived_metrics = None
    derived_columns = None
    use_cases = None
    join_patterns = None
    field_usage = None
    if args.with_history:
        print("Loading query history context...")
        predicate_patterns = load_predicate_patterns(args.schema, database=args.database)
        derived_metrics = load_derived_metrics(args.schema, database=args.database)
        derived_columns = load_derived_columns(args.schema, database=args.database)
        join_patterns = load_join_patterns(args.schema, database=args.database)
        field_usage = load_field_usage(args.schema, database=args.database)
        query_samples = load_query_samples(args.schema, database=args.database)
        if predicate_patterns:
            print(f"  Predicate patterns: {len(predicate_patterns)} columns")
        if derived_metrics:
            print(f"  Derived metrics: {len(derived_metrics)} tables")
        if derived_columns:
            print(f"  Derived columns: {len(derived_columns)} tables")
        if join_patterns:
            print(f"  Join patterns: {len(join_patterns)} tables")
        if field_usage:
            print(f"  Field usage: {len(field_usage)} columns")
        if query_samples:
            print(f"  Query samples: {len(query_samples)} queries")
            print("  Translating query samples to use cases...")
            use_cases = generate_use_cases(
                query_samples,
                model=args.model,
                schema=args.schema,
                output_dir=args.output_dir + "/use_cases",
                database=args.database,
                max_workers=args.max_workers,
            )
            if use_cases:
                print(f"  Generated use cases for {len(use_cases)} tables")
                print(f"  Saved to: {args.output_dir}/use_cases/{args.database}_{args.schema}_use_cases.json")
        if not predicate_patterns and not derived_metrics and not derived_columns and not use_cases and not join_patterns and not field_usage:
            print("  No history data found (run 'history -x' first)")
        print()

    # Generate descriptions
    print("Initializing LLM client (OpenRouter)...")
    generator = MetadataGenerator(model=args.model)
    print(f"  Using model: {args.model}")
    print()

    print("Generating semantic descriptions...")
    descriptions = generator.generate_descriptions(
        profile,
        verbose=args.verbose,
        on_progress=progress_cb,
        predicate_patterns=predicate_patterns,
        derived_metrics=derived_metrics,
        use_cases=use_cases,
        join_patterns=join_patterns,
        field_usage=field_usage,
        derived_columns=derived_columns,
        max_workers=args.max_workers,
    )

    print(f"\nDescription generation complete:")
    print(f"  Tables described: {len(descriptions.tables)}")
    total_desc = sum(len(t.columns) for t in descriptions.tables)
    print(f"  Column descriptions: {total_desc}")

    if args.output:
        output_path = Path(args.output)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        with open(output_path, "w") as f:
            json.dump(descriptions.to_dict(), f, indent=2)
        print(f"\nSaved descriptions to: {output_path}")
    else:
        output_path = generator.save_descriptions(descriptions, args.output_dir + "/descriptions")
        print(f"\nSaved descriptions to: {output_path}")

    if args.verbose or not args.output:
        print()
        print(format_descriptions_for_prompt(descriptions))


def cmd_sql(args):
    """Generate SQL COMMENT statements."""
    load_dotenv()

    facts_only = getattr(args, 'facts_only', False)
    mode = "facts-only" if facts_only else "descriptions"

    print(f"\n{'='*60}")
    print(f"SQL: Generating COMMENT statements for schema '{args.schema}'")
    print(f"{'='*60}")
    print(f"  Database: {args.database}")
    print(f"  Mode: {mode}")
    if not facts_only:
        print(f"  Include descriptions: {'Yes' if args.with_descriptions else 'No'}")
    print(f"  Execute on MotherDuck: {'Yes' if args.execute else 'No'}")
    print()

    progress_cb = print_progress if args.verbose else None

    # Load profile
    print("Loading schema profile...")
    with DatabaseProfiler(database=args.database) as profiler:
        profile_path = Path(args.profiles_dir) / f"{args.database}_{args.schema}_profile.json"

        if profile_path.exists():
            print(f"  Found cached profile: {profile_path}")
            profile = profiler.load_profile(args.schema, args.profiles_dir, database=args.database)
        else:
            print("  No cached profile found, connecting to MotherDuck to profile schema...")
            profile = profiler.profile_schema(args.schema, verbose=args.verbose, on_progress=progress_cb)
            profiler.save_profile(profile, args.profiles_dir)

    if not profile or not profile.tables:
        print("Error: No tables found in schema")
        sys.exit(1)

    total_cols = sum(len(t.columns) for t in profile.tables)
    print(f"  Profile loaded: {len(profile.tables)} tables, {total_cols} columns")

    # Load query history for facts-only mode
    history = None
    if facts_only:
        print("\nLoading query history for fact extraction...")
        history_path = Path(args.output_dir) / "history" / f"{args.database}_{args.schema}_history.json"
        if history_path.exists():
            from metadata_generator.history import QueryHistoryResult
            from metadata_generator.persistence import load_json
            history = load_json(QueryHistoryResult, history_path)
            if history:
                print(f"  Loaded history: {len(history.joins)} joins, {len(history.predicates)} predicates")
        else:
            print("  No history found (run 'history' command for join/filter facts)")

    # Optionally load descriptions (not used in facts-only mode)
    descriptions = None
    if not facts_only and args.with_descriptions:
        print("\nLoading LLM descriptions...")
        descriptions = MetadataGenerator.load_descriptions(args.schema, args.descriptions_dir, database=args.database)
        if descriptions:
            print(f"  Found cached descriptions: {args.descriptions_dir}")
        else:
            print("  No cached descriptions found (use 'describe' command first)")

    # Generate SQL
    print("\nGenerating SQL COMMENT statements...")
    sql = generate_sql_comments(profile, descriptions, history, facts_only)

    # Count statements
    stmt_count = len(split_sql_statements(sql))
    print(f"  Generated {stmt_count} COMMENT statements")

    if args.output:
        output_path = Path(args.output)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        with open(output_path, "w") as f:
            f.write(sql)
        print(f"\nSaved SQL to: {output_path}")
    else:
        output_path = save_sql_comments(profile, descriptions, args.output_dir + "/sql", history, facts_only)
        print(f"\nSaved SQL to: {output_path}")

    # Optionally execute
    if args.execute:
        print(f"\nExecuting SQL on MotherDuck...")
        print(f"  Target: md:{args.database}")
        print(f"  File: {output_path}")
        success = execute_sql_comments(
            output_path,
            database=args.database,
            verbose=args.verbose,
            on_progress=progress_cb,
        )
        if success:
            print("\nExecution complete: All statements executed successfully")
        else:
            print("\nExecution failed: Check errors above")
            sys.exit(1)
    elif args.verbose:
        print()
        print(sql)


def cmd_comments(args):
    """
    Generate facts-only SQL comments for a schema.

    Simple workflow:
    - Without --with-history: Profile + generate facts from stats
    - With --with-history: Profile + analyze history + generate facts with usage patterns
    """
    load_dotenv()

    progress_cb = print_progress if args.verbose else None
    schemas = resolve_schemas(args)

    failed = []
    for i, schema in enumerate(schemas, 1):
        if len(schemas) > 1:
            print(f"\n{'#'*60}")
            print(f"# SCHEMA {i}/{len(schemas)}: {schema}")
            print(f"{'#'*60}")

        success = _comments_single_schema(args, schema, progress_cb)
        if not success:
            failed.append(schema)

    if len(schemas) > 1:
        print(f"\n{'='*60}")
        print(f"BATCH COMPLETE: Generated comments for {len(schemas)} schemas")
        print(f"{'='*60}")
        print(f"  Successful: {len(schemas) - len(failed)}")
        if failed:
            print(f"  Failed: {len(failed)} ({', '.join(failed)})")
            sys.exit(1)


def _comments_single_schema(args, schema: str, progress_cb) -> bool:
    """
    Generate facts-only comments for a single schema.

    Returns True if successful.
    """
    with_history = getattr(args, 'with_history', False)
    annotations_path = getattr(args, 'annotations', None)

    print(f"\n{'='*60}")
    print(f"COMMENTS: Generating facts-only metadata for schema '{schema}'")
    print(f"{'='*60}")
    print(f"  Database: {args.database}")
    print(f"  Include history: {'Yes' if with_history else 'No'}")
    print(f"  Annotations: {annotations_path or 'None'}")
    print(f"  Execute SQL: {'Yes' if args.execute else 'No'}")
    print()

    # Step 1: Profile
    print("STEP 1: Profiling schema...")
    with DatabaseProfiler(database=args.database) as profiler:
        profile_path = Path(args.output_dir) / "profiles" / f"{args.database}_{schema}_profile.json"

        if profile_path.exists() and not args.refresh:
            print(f"  Using cached profile: {profile_path}")
            profile = profiler.load_profile(schema, args.output_dir + "/profiles", database=args.database)
        else:
            print("  Connecting to MotherDuck...")
            profile = profiler.profile_schema(schema, verbose=args.verbose, on_progress=progress_cb)
            profiler.save_profile(profile, args.output_dir + "/profiles")
            print(f"  Saved profile to: {profile_path}")

    if not profile or not profile.tables:
        print("Error: No tables found in schema")
        return False

    total_cols = sum(len(t.columns) for t in profile.tables)
    total_rows = sum(t.row_count for t in profile.tables)
    print(f"  Tables: {len(profile.tables)}, Columns: {total_cols}, Rows: {total_rows:,}")

    # Step 2: Optionally analyze query history
    history = None
    if with_history:
        print()
        print("STEP 2: Analyzing query history...")
        history_path = Path(args.output_dir) / "history" / f"{args.database}_{schema}_history.json"

        if history_path.exists() and not args.refresh:
            print(f"  Using cached history: {history_path}")
            from metadata_generator.history import QueryHistoryResult
            from metadata_generator.persistence import load_json
            history = load_json(QueryHistoryResult, history_path)
        else:
            print("  Querying MD_INFORMATION_SCHEMA.QUERY_HISTORY...")
            with QueryHistoryAnalyzer(database=args.database) as analyzer:
                history = analyzer.analyze_schema(
                    schema=schema,
                    days=args.days,
                    limit=args.limit,
                    verbose=args.verbose,
                    on_progress=progress_cb,
                )
                if history.error:
                    print(f"  Warning: {history.error}")
                    print("  Proceeding without history...")
                    history = None
                else:
                    analyzer.save_analysis(history, args.output_dir + "/history")
                    print(f"  Saved history to: {history_path}")

        if history:
            print(f"  Queries analyzed: {history.queries_analyzed}")
            print(f"  Join patterns: {len(history.joins)}")
            print(f"  Predicate patterns: {len(history.predicates)}")
            print(f"  Field usage: {len(history.field_usage)}")
    else:
        print()
        print("STEP 2: Skipping history analysis (use --with-history to include)")

    # Load annotations if provided
    annotations = None
    if annotations_path:
        print()
        print("Loading annotations...")
        try:
            annotations = load_annotations(Path(annotations_path))
            ann_tables = len(annotations.tables)
            ann_cols = sum(len(t.columns) for t in annotations.tables.values())
            print(f"  Loaded: {ann_tables} tables, {ann_cols} column annotations")
            warnings = validate_annotations(annotations, profile)
            for w in warnings:
                print(f"  WARNING: {w}")
        except (FileNotFoundError, ValueError) as e:
            print(f"  ERROR: {e}")
            return False

    # Step 3: Generate SQL
    print()
    print("STEP 3: Generating SQL COMMENT statements...")
    sql = generate_sql_comments(profile, descriptions=None, history=history, facts_only=True, annotations=annotations)
    sql_path = save_sql_comments(profile, descriptions=None, output_dir=args.output_dir + "/sql", history=history, facts_only=True, annotations=annotations)

    stmt_count = len(split_sql_statements(sql))
    print(f"  Generated {stmt_count} statements")
    print(f"  Saved to: {sql_path}")

    # Step 4: Optionally execute
    if args.execute:
        print()
        print("STEP 4: Executing SQL on MotherDuck...")
        print(f"  Target: md:{args.database}")
        success = execute_sql_comments(
            sql_path,
            database=args.database,
            verbose=args.verbose,
            on_progress=progress_cb,
        )
        if not success:
            print("  Execution failed!")
            return False
        print("  Comments applied successfully")
    else:
        print()
        print("STEP 4: Skipping execution (use -x to apply comments)")

    print()
    print(f"Done! Generated facts-only comments for {len(profile.tables)} tables.")
    return True


def cmd_validate_annotations(args):
    """Validate a YAML annotations file against a schema profile."""
    load_dotenv()

    progress_cb = print_progress if args.verbose else None
    schema = args.schema

    print(f"\nValidating annotations: {args.annotations}")
    print(f"  Schema: {schema}")
    print(f"  Database: {args.database}")
    print()

    # Load annotations
    try:
        annotations = load_annotations(Path(args.annotations))
    except (FileNotFoundError, ValueError) as e:
        print(f"ERROR: {e}")
        sys.exit(1)

    ann_tables = len(annotations.tables)
    ann_cols = sum(len(t.columns) for t in annotations.tables.values())
    print(f"Annotations loaded: {ann_tables} tables, {ann_cols} column annotations")

    # Load or generate profile
    print("Loading schema profile...")
    with DatabaseProfiler(database=args.database) as profiler:
        profile_path = Path(args.output_dir) / "profiles" / f"{args.database}_{schema}_profile.json"

        if profile_path.exists() and not args.refresh:
            print(f"  Using cached profile: {profile_path}")
            profile = profiler.load_profile(schema, args.output_dir + "/profiles", database=args.database)
        else:
            print("  Connecting to MotherDuck...")
            profile = profiler.profile_schema(schema, verbose=args.verbose, on_progress=progress_cb)
            profiler.save_profile(profile, args.output_dir + "/profiles")

    if not profile or not profile.tables:
        print("ERROR: No tables found in schema")
        sys.exit(1)

    # Validate
    warnings = validate_annotations(annotations, profile)

    if warnings:
        print(f"\nFound {len(warnings)} warning(s):")
        for w in warnings:
            print(f"  - {w}")
        sys.exit(1)
    else:
        print("\nAll annotations are valid!")


def _generate_single_schema(args, schema: str, progress_cb) -> bool:
    """
    Run the generate pipeline for a single schema.

    Returns True if successful.
    """
    facts_only = getattr(args, 'facts_only', False)
    skip_descriptions = args.skip_descriptions or facts_only
    annotations_path = getattr(args, 'annotations', None)

    print(f"\n{'='*60}")
    print(f"GENERATE: Full metadata pipeline for schema '{schema}'")
    print(f"{'='*60}")
    print(f"  Database: {args.database}")
    print(f"  Output directory: {args.output_dir}")
    print(f"  Mode: {'facts-only' if facts_only else 'descriptions'}")
    if not facts_only:
        print(f"  LLM model: {args.model}")
        print(f"  Skip descriptions: {'Yes' if skip_descriptions else 'No'}")
    print(f"  Annotations: {annotations_path or 'None'}")
    print(f"  Execute SQL: {'Yes' if args.execute else 'No'}")
    print()

    # Step 1: Profile
    print("=" * 40)
    print("STEP 1/4: Profiling schema")
    print("=" * 40)
    with DatabaseProfiler(database=args.database) as profiler:
        profile = profiler.profile_schema(schema, verbose=args.verbose, on_progress=progress_cb)
        profile_path = profiler.save_profile(profile, args.output_dir + "/profiles")

    if not profile.tables:
        print("Warning: No tables found in schema, skipping")
        return True  # Not a failure, just empty

    total_cols = sum(len(t.columns) for t in profile.tables)
    total_rows = sum(t.row_count for t in profile.tables)
    print(f"\n  Profile complete:")
    print(f"    Tables: {len(profile.tables)}")
    print(f"    Columns: {total_cols}")
    print(f"    Total rows: {total_rows:,}")
    print(f"    Saved to: {profile_path}")

    # Load history for facts-only mode
    history = None
    if facts_only:
        print()
        print("=" * 40)
        print("STEP 2/4: Loading query history for facts")
        print("=" * 40)
        history_path = Path(args.output_dir) / "history" / f"{args.database}_{schema}_history.json"
        if history_path.exists():
            from metadata_generator.history import QueryHistoryResult
            from metadata_generator.persistence import load_json
            history = load_json(QueryHistoryResult, history_path)
            if history:
                print(f"  Loaded history: {len(history.joins)} joins, {len(history.predicates)} predicates")
            else:
                print("  Failed to load history file")
        else:
            print("  No history found (run 'history' command first for join/filter facts)")
            print("  Proceeding with profile-only facts")

    # Step 2: Describe (if not skipped)
    descriptions = None
    if not skip_descriptions:
        print()
        print("=" * 40)
        print("STEP 2/4: Generating LLM descriptions")
        print("=" * 40)

        # Load query history context if requested
        predicate_patterns = None
        derived_metrics = None
        derived_columns = None
        use_cases = None
        join_patterns = None
        field_usage = None
        if args.with_history:
            print("  Loading query history context...")
            predicate_patterns = load_predicate_patterns(schema, database=args.database)
            derived_metrics = load_derived_metrics(schema, database=args.database)
            derived_columns = load_derived_columns(schema, database=args.database)
            join_patterns = load_join_patterns(schema, database=args.database)
            field_usage = load_field_usage(schema, database=args.database)
            query_samples = load_query_samples(schema, database=args.database)
            if predicate_patterns:
                print(f"    Predicate patterns: {len(predicate_patterns)} columns")
            if derived_metrics:
                print(f"    Derived metrics: {len(derived_metrics)} tables")
            if derived_columns:
                print(f"    Derived columns: {len(derived_columns)} tables")
            if join_patterns:
                print(f"    Join patterns: {len(join_patterns)} tables")
            if field_usage:
                print(f"    Field usage: {len(field_usage)} columns")
            if query_samples:
                print(f"    Query samples: {len(query_samples)} queries")
                print("    Translating query samples to use cases...")
                use_cases = generate_use_cases(
                    query_samples,
                    model=args.model,
                    schema=schema,
                    output_dir=args.output_dir + "/use_cases",
                    database=args.database,
                    max_workers=args.max_workers,
                )
                if use_cases:
                    print(f"    Generated use cases for {len(use_cases)} tables")
                    print(f"    Saved to: {args.output_dir}/use_cases/{args.database}_{schema}_use_cases.json")
            if not predicate_patterns and not derived_metrics and not derived_columns and not use_cases and not join_patterns and not field_usage:
                print("    No history data found (run 'history -x' first)")

        try:
            print(f"  Initializing LLM client...")
            generator = MetadataGenerator(model=args.model)
            print(f"  Model: {args.model}")
            print(f"  Generating descriptions for {len(profile.tables)} tables, {total_cols} columns...")
            print()
            descriptions = generator.generate_descriptions(
                profile,
                verbose=args.verbose,
                on_progress=progress_cb,
                predicate_patterns=predicate_patterns,
                derived_metrics=derived_metrics,
                use_cases=use_cases,
                join_patterns=join_patterns,
                field_usage=field_usage,
                derived_columns=derived_columns,
                max_workers=args.max_workers,
            )
            desc_path = generator.save_descriptions(descriptions, args.output_dir + "/descriptions")
            print(f"\n  Description generation complete")
            print(f"    Saved to: {desc_path}")
        except ValueError as e:
            print(f"  Skipping descriptions: {e}")
    else:
        if not facts_only:
            print()
            print("=" * 40)
            print("STEP 2/4: Skipping LLM descriptions")
            print("=" * 40)
            print("  --skip-descriptions flag set, generating SQL with statistics only")

    # Load annotations if provided
    annotations = None
    if annotations_path:
        print()
        print("Loading annotations...")
        try:
            annotations = load_annotations(Path(annotations_path))
            ann_tables = len(annotations.tables)
            ann_cols = sum(len(t.columns) for t in annotations.tables.values())
            print(f"  Loaded: {ann_tables} tables, {ann_cols} column annotations")
            warnings = validate_annotations(annotations, profile)
            for w in warnings:
                print(f"  WARNING: {w}")
        except (FileNotFoundError, ValueError) as e:
            print(f"  ERROR: {e}")
            return False

    # Step 3: Generate SQL
    print()
    print("=" * 40)
    print("STEP 3/4: Generating SQL COMMENT statements")
    print("=" * 40)
    if facts_only:
        print("  Mode: facts-only (compact notation)")
    sql = generate_sql_comments(profile, descriptions, history, facts_only, annotations)
    sql_path = save_sql_comments(profile, descriptions, args.output_dir + "/sql", history, facts_only, annotations)

    stmt_count = len(split_sql_statements(sql))
    print(f"  Generated {stmt_count} COMMENT statements")
    print(f"    Table comments: {len(profile.tables)}")
    print(f"    Column comments: {total_cols}")
    print(f"    Saved to: {sql_path}")

    # Step 4: Execute (if requested)
    if args.execute:
        print()
        print("=" * 40)
        print("STEP 4/4: Executing SQL on MotherDuck")
        print("=" * 40)
        print(f"  Target: md:{args.database}")
        print(f"  File: {sql_path}")
        success = execute_sql_comments(
            sql_path,
            database=args.database,
            verbose=args.verbose,
            on_progress=progress_cb,
        )
        if not success:
            print("  Execution failed!")
            return False
    else:
        print()
        print("=" * 40)
        print("STEP 4/4: Skipping SQL execution")
        print("=" * 40)
        print("  Use --execute (-x) flag to apply comments to MotherDuck")

    print()
    print("=" * 60)
    print("COMPLETE: Metadata generation finished")
    print("=" * 60)
    print(f"  Schema: {schema}")
    print(f"  Tables processed: {len(profile.tables)}")
    print(f"  Columns processed: {total_cols}")
    print(f"  SQL statements: {stmt_count}")
    if args.execute:
        print(f"  Applied to: md:{args.database}")

    return True


def cmd_generate(args):
    """Full pipeline: profile -> describe -> SQL."""
    load_dotenv()

    progress_cb = print_progress if args.verbose else None
    schemas = resolve_schemas(args)

    failed = []
    for i, schema in enumerate(schemas, 1):
        if len(schemas) > 1:
            print(f"\n{'#'*60}")
            print(f"# SCHEMA {i}/{len(schemas)}: {schema}")
            print(f"{'#'*60}")

        success = _generate_single_schema(args, schema, progress_cb)
        if not success:
            failed.append(schema)

    if len(schemas) > 1:
        print(f"\n{'='*60}")
        print(f"BATCH COMPLETE: Processed {len(schemas)} schemas")
        print(f"{'='*60}")
        print(f"  Successful: {len(schemas) - len(failed)}")
        if failed:
            print(f"  Failed: {len(failed)} ({', '.join(failed)})")
            sys.exit(1)


def cmd_list(args):
    """List available schemas in the database."""
    load_dotenv()

    print(f"\n{'='*60}")
    print(f"LIST: Available schemas in database '{args.database}'")
    print(f"{'='*60}")
    print()

    print("Connecting to MotherDuck...")
    with DatabaseProfiler(database=args.database) as profiler:
        schemas = profiler.list_schemas()

        print(f"  Connection established: md:{args.database}")
        print(f"\nFound {len(schemas)} user schemas:\n")
        for schema in schemas:
            tables = profiler.get_tables(schema)
            view_count = sum(1 for _, t in tables if t == "VIEW")
            if view_count:
                print(f"  {schema:30} {len(tables):3} tables ({view_count} views)")
            else:
                print(f"  {schema:30} {len(tables):3} tables")


def _history_single_schema(args, schema: str, progress_cb) -> bool:
    """
    Analyze query history for a single schema.

    Returns True if successful.
    """
    print(f"\n{'='*60}")
    print(f"HISTORY: Analyzing query patterns for schema '{schema}'")
    print(f"{'='*60}")
    print(f"  Database: {args.database}")
    print(f"  Time range: Last {args.days} days")
    print(f"  Query limit: {args.limit}")
    if args.user:
        print(f"  Filter by user: {args.user}")
    print()

    print("Connecting to MotherDuck...")
    with QueryHistoryAnalyzer(database=args.database) as analyzer:
        print("  Querying MD_INFORMATION_SCHEMA.QUERY_HISTORY...")
        schema_pattern = f"{args.database}.{schema}" if args.database else schema
        print(f"  Looking for queries referencing '{schema_pattern}.*'...")
        print()

        result = analyzer.analyze_schema(
            schema=schema,
            user_name=args.user,
            days=args.days,
            limit=args.limit,
            verbose=args.verbose,
            on_progress=progress_cb,
        )

        if result.error:
            print(f"Error: {result.error}")
            return False

        print(f"Analysis complete:")
        print(f"  Queries analyzed: {result.queries_analyzed}")
        print(f"  Unique join patterns found: {len(result.joins)}")

        if args.output:
            output_path = Path(args.output)
            output_path.parent.mkdir(parents=True, exist_ok=True)
            with open(output_path, "w") as f:
                json.dump(result.to_dict(), f, indent=2, default=str)
            print(f"\nSaved analysis to: {output_path}")
        else:
            output_path = analyzer.save_analysis(result, args.output_dir + "/history")
            print(f"\nSaved analysis to: {output_path}")

        if result.joins:
            print()
            print(format_joins_for_prompt(result))

        if args.verbose and result.query_samples:
            print()
            print("Sample queries:")
            for i, sample in enumerate(result.query_samples[:5], 1):
                print(f"\n  [{i}] {sample[:200]}...")

        # Execute SQL to store in metadata schema
        if args.execute:
            print()
            print("Storing results in metadata schema...")
            sql = generate_metadata_schema_sql(result, args.database)

            # Save SQL to file
            sql_path = Path(args.output_dir) / "sql" / f"{args.database}_{result.schema}_metadata.sql"
            sql_path.parent.mkdir(parents=True, exist_ok=True)
            with open(sql_path, "w") as f:
                f.write(sql)
            print(f"  SQL saved to: {sql_path}")

            # Execute against default database (my_db)
            # We don't attach the target database since it may be a share
            from metadata_generator.connection import MotherDuckConnection
            with MotherDuckConnection("") as db:
                for statement in split_sql_statements(sql):
                    try:
                        db.conn.execute(statement)
                    except Exception as e:
                        print(f"  Warning: {e}")
            print("  Metadata tables created in 'metadata' schema (in my_db)")

        # Translate query samples to natural language
        if args.translate and result.query_samples:
            print()
            print("Translating query samples to natural language...")
            print(f"  Model: {args.model}")
            print(f"  Queries to translate: {len(result.query_samples)}")

            translations = translate_query_history(
                queries=result.query_samples,
                schema=schema,
                max_queries=len(result.query_samples),
                model=args.model,
                verbose=args.verbose,
                database=args.database,
            )

            # Save translations to JSON
            translations_path = save_translations(translations, args.output_dir + "/translations")
            print(f"  Saved translations to: {translations_path}")

            # Build SQL for use cases table
            use_case_sql_parts = [
                "\n-- Query use cases (natural language translations)",
                """CREATE TABLE IF NOT EXISTS metadata.query_use_cases (
    sample_index INTEGER,
    query_text VARCHAR,
    natural_language VARCHAR,
    tables_referenced VARCHAR[],
    schema_name VARCHAR
);""",
                f"DELETE FROM metadata.query_use_cases WHERE schema_name = '{schema.replace(chr(39), chr(39)*2)}';",
            ]

            # Generate individual INSERT statements to avoid semicolon-splitting issues
            escaped_schema = schema.replace("'", "''")
            for i, t in enumerate(translations.translations):
                nl_escaped = t.natural_language.replace("'", "''")
                tables_array = "[" + ", ".join(f"'{tbl.replace(chr(39), chr(39)*2)}'" for tbl in (t.tables_referenced or [])) + "]"
                use_case_sql_parts.append(
                    f"INSERT INTO metadata.query_use_cases "
                    f"(sample_index, query_text, natural_language, tables_referenced, schema_name) VALUES "
                    f"({i}, {dollar_quote(t.sql)}, '{nl_escaped}', {tables_array}, '{escaped_schema}');"
                )

            use_case_sql = "\n\n".join(use_case_sql_parts)

            # Append to metadata SQL file
            sql_path = Path(args.output_dir) / "sql" / f"{args.database}_{schema}_metadata.sql"
            with open(sql_path, "a") as f:
                f.write("\n" + use_case_sql)
            print(f"  Appended translations SQL to: {sql_path}")

            # Execute if -x was used
            if args.execute:
                print("  Storing translations in metadata.query_use_cases...")
                from metadata_generator.connection import MotherDuckConnection

                with MotherDuckConnection("") as db:
                    for statement in split_sql_statements(use_case_sql):
                        try:
                            db.conn.execute(statement)
                        except Exception as e:
                            print(f"    Warning: {e}")
                print("  Use cases stored in metadata.query_use_cases")

            # Show sample translations
            if args.verbose and translations.translations:
                print()
                print("Sample translations:")
                for i, t in enumerate(translations.translations[:3], 1):
                    print(f"\n  [{i}] {t.natural_language}")
                    print(f"      SQL: {t.sql[:80]}...")

    return True


def cmd_history(args):
    """Analyze query history for a schema to discover join patterns."""
    load_dotenv()

    progress_cb = print_progress if args.verbose else None
    schemas = resolve_schemas(args)

    failed = []
    for i, schema in enumerate(schemas, 1):
        if len(schemas) > 1:
            print(f"\n{'#'*60}")
            print(f"# SCHEMA {i}/{len(schemas)}: {schema}")
            print(f"{'#'*60}")

        success = _history_single_schema(args, schema, progress_cb)
        if not success:
            failed.append(schema)

    if len(schemas) > 1:
        print(f"\n{'='*60}")
        print(f"BATCH COMPLETE: Analyzed {len(schemas)} schemas")
        print(f"{'='*60}")
        print(f"  Successful: {len(schemas) - len(failed)}")
        if failed:
            print(f"  Failed: {len(failed)} ({', '.join(failed)})")
            sys.exit(1)


def cmd_translate(args):
    """Translate SQL queries from history to natural language."""
    load_dotenv()

    print(f"\n{'='*60}")
    print(f"TRANSLATE: Converting SQL queries to natural language")
    print(f"{'='*60}")
    print(f"  Schema: {args.schema}")
    print(f"  Database: {args.database}")
    print(f"  Max queries: {args.max_queries}")
    print(f"  Model: {args.model}")
    print()

    progress_cb = print_progress if args.verbose else None

    # Get queries from history
    print("Fetching query history...")
    with QueryHistoryAnalyzer(database=args.database) as analyzer:
        result = analyzer.analyze_schema(
            schema=args.schema,
            days=args.days,
            limit=args.limit,
            verbose=False,
            on_progress=progress_cb,
        )

        if result.error:
            print(f"Error fetching history: {result.error}")
            print()
            print("You can provide queries via --input-file instead.")
            sys.exit(1)

        queries = result.query_samples
        if not queries:
            print("No queries found in history")
            sys.exit(1)

        print(f"  Found {result.queries_analyzed} queries")

    # Optionally load schema profile for context
    schema_profile = None
    if args.with_context:
        print("\nLoading schema profile for context...")
        with DatabaseProfiler(database=args.database) as profiler:
            profile_path = Path(args.profiles_dir) / f"{args.database}_{args.schema}_profile.json"
            if profile_path.exists():
                schema_profile = profiler.load_profile(args.schema, args.profiles_dir, database=args.database)
                print(f"  Loaded profile: {len(schema_profile.tables)} tables")
            else:
                print("  No cached profile found, profiling schema...")
                schema_profile = profiler.profile_schema(args.schema, verbose=False, on_progress=progress_cb)
                profiler.save_profile(schema_profile, args.profiles_dir)
                print(f"  Profiled: {len(schema_profile.tables)} tables")

    # Translate queries
    print("\nTranslating queries to natural language...")
    translations = translate_query_history(
        queries=queries,
        schema=args.schema,
        schema_profile=schema_profile,
        max_queries=args.max_queries,
        model=args.model,
        verbose=args.verbose,
        database=args.database,
    )

    print(f"\nTranslation complete:")
    print(f"  Queries translated: {len(translations.translations)}")

    # Save results
    if args.output:
        output_path = Path(args.output)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        with open(output_path, "w") as f:
            json.dump(translations.to_dict(), f, indent=2)
        print(f"  Saved to: {output_path}")
    else:
        output_path = save_translations(translations, args.output_dir + "/translations")
        print(f"  Saved to: {output_path}")

    if args.verbose:
        print()
        print(format_translations_for_prompt(translations, max_examples=5))


def main():
    parser = argparse.ArgumentParser(
        prog="metadata-generator",
        description="Generate metadata for MotherDuck databases",
    )
    parser.add_argument(
        "--database", "-d",
        default="bird_bench",
        help="MotherDuck database name (default: bird_bench)",
    )
    parser.add_argument(
        "--output-dir", "-o",
        default="output",
        help="Output directory (default: output)",
    )
    parser.add_argument(
        "--verbose", "-v",
        action="store_true",
        help="Verbose output",
    )

    subparsers = parser.add_subparsers(dest="command", help="Commands")

    # list command
    list_parser = subparsers.add_parser("list", help="List available schemas")

    # profile command
    profile_parser = subparsers.add_parser("profile", help="Profile a schema")
    profile_parser.add_argument("schema", help="Schema name to profile")
    profile_parser.add_argument("--output", help="Output file path (optional)")

    # describe command
    describe_parser = subparsers.add_parser("describe", help="Generate LLM descriptions")
    describe_parser.add_argument("schema", help="Schema name")
    describe_parser.add_argument("--output", help="Output file path (optional)")
    describe_parser.add_argument(
        "--profiles-dir",
        default="output/profiles",
        help="Directory with cached profiles",
    )
    describe_parser.add_argument(
        "--model",
        default="google/gemini-3-flash-preview",
        help="LLM model to use",
    )
    describe_parser.add_argument(
        "--with-history",
        action="store_true",
        help="Use predicate patterns from query history to improve semantic type inference",
    )
    describe_parser.add_argument(
        "--max-workers",
        type=int,
        default=6,
        help="Max parallel workers for LLM calls (default: 6)",
    )

    # sql command
    sql_parser = subparsers.add_parser("sql", help="Generate SQL COMMENT statements")
    sql_parser.add_argument("schema", help="Schema name")
    sql_parser.add_argument("--output", help="Output file path (optional)")
    sql_parser.add_argument(
        "--profiles-dir",
        default="output/profiles",
        help="Directory with cached profiles",
    )
    sql_parser.add_argument(
        "--descriptions-dir",
        default="output/descriptions",
        help="Directory with cached descriptions",
    )
    sql_parser.add_argument(
        "--with-descriptions", "-w",
        action="store_true",
        help="Include LLM descriptions in comments",
    )
    sql_parser.add_argument(
        "--execute", "-x",
        action="store_true",
        help="Execute the SQL statements",
    )
    sql_parser.add_argument(
        "--facts-only", "-f",
        action="store_true",
        help="Use compact fact notation instead of verbose descriptions",
    )

    # comments command (simplified facts-only workflow)
    comments_parser = subparsers.add_parser(
        "comments", help="Generate facts-only SQL comments (simplified workflow)"
    )
    comments_parser.add_argument("schema", help="Schema name (or '*' for all)")
    comments_parser.add_argument(
        "--with-history",
        action="store_true",
        help="Include query history patterns (joins, filters, usage)",
    )
    comments_parser.add_argument(
        "--execute", "-x",
        action="store_true",
        help="Execute the SQL statements on MotherDuck",
    )
    comments_parser.add_argument(
        "--refresh",
        action="store_true",
        help="Refresh cached profile and history instead of using cached",
    )
    comments_parser.add_argument(
        "--days",
        type=int,
        default=30,
        help="Days of history to analyze (default: 30)",
    )
    comments_parser.add_argument(
        "--limit",
        type=int,
        default=1000,
        help="Max queries to analyze (default: 1000)",
    )
    comments_parser.add_argument(
        "--annotations", "-a",
        help="Path to YAML annotations file with domain knowledge",
    )

    # generate command (full pipeline)
    generate_parser = subparsers.add_parser(
        "generate", help="Full pipeline: profile -> describe -> SQL"
    )
    generate_parser.add_argument("schema", help="Schema name")
    generate_parser.add_argument(
        "--skip-descriptions",
        action="store_true",
        help="Skip LLM description generation",
    )
    generate_parser.add_argument(
        "--model",
        default="google/gemini-3-flash-preview",
        help="LLM model to use",
    )
    generate_parser.add_argument(
        "--execute", "-x",
        action="store_true",
        help="Execute the SQL statements",
    )
    generate_parser.add_argument(
        "--with-history",
        action="store_true",
        help="Use predicate patterns from query history to improve semantic type inference",
    )
    generate_parser.add_argument(
        "--max-workers",
        type=int,
        default=6,
        help="Max parallel workers for LLM calls (default: 6)",
    )
    generate_parser.add_argument(
        "--facts-only", "-f",
        action="store_true",
        help="Use compact fact notation (skips LLM descriptions)",
    )
    generate_parser.add_argument(
        "--annotations", "-a",
        help="Path to YAML annotations file with domain knowledge",
    )

    # validate-annotations command
    va_parser = subparsers.add_parser(
        "validate-annotations",
        help="Validate a YAML annotations file against a schema profile",
    )
    va_parser.add_argument("schema", help="Schema name")
    va_parser.add_argument(
        "--annotations", "-a",
        required=True,
        help="Path to YAML annotations file",
    )
    va_parser.add_argument(
        "--refresh",
        action="store_true",
        help="Refresh cached profile instead of using cached",
    )

    # history command
    history_parser = subparsers.add_parser(
        "history", help="Analyze query history to discover join patterns"
    )
    history_parser.add_argument("schema", help="Schema name to analyze")
    history_parser.add_argument("--output", help="Output file path (optional)")
    history_parser.add_argument(
        "--user", "-u",
        help="Filter by user name",
    )
    history_parser.add_argument(
        "--days",
        type=int,
        default=30,
        help="Number of days to look back (default: 30)",
    )
    history_parser.add_argument(
        "--limit",
        type=int,
        default=1000,
        help="Maximum queries to analyze (default: 1000)",
    )
    history_parser.add_argument(
        "--execute", "-x",
        action="store_true",
        help="Execute SQL to store results in metadata schema",
    )
    history_parser.add_argument(
        "--translate", "-t",
        action="store_true",
        help="Translate query samples to natural language descriptions",
    )
    history_parser.add_argument(
        "--model",
        default="google/gemini-3-flash-preview",
        help="LLM model for translation (default: google/gemini-3-flash-preview)",
    )

    # translate command
    translate_parser = subparsers.add_parser(
        "translate", help="Translate SQL queries from history to natural language"
    )
    translate_parser.add_argument("schema", help="Schema name")
    translate_parser.add_argument("--output", help="Output file path (optional)")
    translate_parser.add_argument(
        "--max-queries",
        type=int,
        default=100,
        help="Maximum queries to translate (default: 100)",
    )
    translate_parser.add_argument(
        "--model",
        default="google/gemini-3-flash-preview",
        help="LLM model to use",
    )
    translate_parser.add_argument(
        "--with-context", "-c",
        action="store_true",
        help="Include schema profile as context for better translations",
    )
    translate_parser.add_argument(
        "--profiles-dir",
        default="output/profiles",
        help="Directory with cached profiles",
    )
    translate_parser.add_argument(
        "--days",
        type=int,
        default=30,
        help="Number of days to look back for queries (default: 30)",
    )
    translate_parser.add_argument(
        "--limit",
        type=int,
        default=1000,
        help="Maximum queries to fetch from history (default: 1000)",
    )

    args = parser.parse_args()

    if args.command == "list":
        cmd_list(args)
    elif args.command == "profile":
        cmd_profile(args)
    elif args.command == "describe":
        cmd_describe(args)
    elif args.command == "sql":
        cmd_sql(args)
    elif args.command == "comments":
        cmd_comments(args)
    elif args.command == "generate":
        cmd_generate(args)
    elif args.command == "validate-annotations":
        cmd_validate_annotations(args)
    elif args.command == "history":
        cmd_history(args)
    elif args.command == "translate":
        cmd_translate(args)
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
