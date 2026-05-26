"""
CLI entry point for BIRD-Bench evaluation.

Usage:
    uv run python -m eval.cli <command> [options]

Commands:
    setup       Set up all database configurations
    sample      Generate train/test split
    train       Run train phase only
    test        Run test phase only
    full        Run complete evaluation (train → history → test)
    report      Generate report from latest evaluation
    errors      Generate Bloomberg-style error analysis report
    cleanup     Delete local logs after uploading to MotherDuck
    upload      Upload controllog to MotherDuck and clean up
    inspect     Run truth-seeking analysis on error logs
    hydrate     Hydrate Config C with gold SQL query history
"""

import argparse
import asyncio
import sys
from collections import defaultdict
from pathlib import Path

from dotenv import load_dotenv


def print_run_summary(results: list) -> None:
    """
    Print a summary table of evaluation results by model and config.

    Shows: total questions, correct, judge, partial, incorrect, hit_limit, error, cost
    """
    if not results:
        return

    # Aggregate stats by (model, config)
    stats = defaultdict(lambda: {
        "total": 0,
        "correct": 0,         # Gold + platinum (not judge)
        "judge": 0,           # Judge approved
        "partial_ok": 0,      # Partial with credit (extra columns)
        "partial_bad": 0,     # Partial without credit (missing cols, extra rows, etc.)
        "incorrect": 0,
        "hit_limit": 0,
        "error": 0,
        "cost": 0.0,
    })

    for r in results:
        key = (r.model, r.config_type.value)
        stats[key]["total"] += r.stats.total
        # correct property includes judge, so subtract it out for the base correct column
        stats[key]["correct"] += r.stats.correct_gold + r.stats.correct_platinum
        stats[key]["judge"] += r.stats.correct_judge
        stats[key]["partial_ok"] += r.stats.partial_accepted
        stats[key]["partial_bad"] += r.stats.partial_unaccepted
        stats[key]["incorrect"] += r.stats.incorrect
        stats[key]["hit_limit"] += r.stats.hit_limit
        stats[key]["error"] += r.stats.error
        # Sum costs from individual results
        for eval_result in r.results:
            stats[key]["cost"] += eval_result.cost_usd

    # Print summary table
    print("\n" + "=" * 115)
    print("RUN SUMMARY")
    print("=" * 115)
    print(f"{'Model':<25} {'Config':<8} {'Total':>5} {'Correct':>7} {'Judge':>6} {'Part+':>6} {'Part-':>6} {'Wrong':>6} {'Limit':>5} {'Error':>5} {'Cost':>10}")
    print("-" * 115)

    # Sort by model, then config
    total_cost = 0.0
    total_questions = 0
    total_correct = 0
    total_judge = 0
    total_partial_ok = 0
    total_partial_bad = 0
    total_incorrect = 0
    total_hit_limit = 0
    total_error = 0

    for (model, config), s in sorted(stats.items()):
        model_short = model.split("/")[-1] if "/" in model else model
        print(f"{model_short:<25} {config:<8} {s['total']:>5} {s['correct']:>7} {s['judge']:>6} {s['partial_ok']:>6} {s['partial_bad']:>6} {s['incorrect']:>6} {s['hit_limit']:>5} {s['error']:>5} ${s['cost']:>9.4f}")
        total_cost += s["cost"]
        total_questions += s["total"]
        total_correct += s["correct"]
        total_judge += s["judge"]
        total_partial_ok += s["partial_ok"]
        total_partial_bad += s["partial_bad"]
        total_incorrect += s["incorrect"]
        total_hit_limit += s["hit_limit"]
        total_error += s["error"]

    print("-" * 115)
    print(f"{'TOTAL':<25} {'':<8} {total_questions:>5} {total_correct:>7} {total_judge:>6} {total_partial_ok:>6} {total_partial_bad:>6} {total_incorrect:>6} {total_hit_limit:>5} {total_error:>5} ${total_cost:>9.4f}")
    print("=" * 115)


def print_judge_report(judge_results: list, model_config_map: dict | None = None, save_markdown: bool = True) -> Path | None:
    """
    Print a readable report of all LLM judge decisions.

    Shows each judgment with full question and reasoning.

    Args:
        judge_results: List of TruthSeekingResult objects
        model_config_map: Optional dict mapping question_id to (model, config) tuple
        save_markdown: Whether to save detailed markdown file

    Returns:
        Path to saved markdown file if save_markdown=True, else None
    """
    if not judge_results:
        return None

    approved = [r for r in judge_results if r.verdict in ("PREDICTED_CORRECT", "BOTH_CORRECT")]
    rejected = [r for r in judge_results if r.verdict not in ("PREDICTED_CORRECT", "BOTH_CORRECT")]

    print("\n" + "=" * 80)
    print("LLM JUDGE REPORT")
    print(f"Judged: {len(judge_results)} | Approved: {len(approved)} | Rejected: {len(rejected)}")
    print("=" * 80)

    for r in judge_results:
        # Status marker
        mark = "✓" if r.verdict in ("PREDICTED_CORRECT", "BOTH_CORRECT") else "✗"
        # Low confidence flag
        conf_flag = " [LOW CONF]" if r.confidence and r.confidence.lower() == "low" else ""
        # Model/config info if available
        model_info = ""
        if model_config_map and r.question_id in model_config_map:
            model, config = model_config_map[r.question_id]
            model_short = model.split("/")[-1] if "/" in model else model
            model_info = f" | {model_short}; {config}"

        print(f"\n{mark} Q{r.question_id} ({r.db_id}){model_info}{conf_flag}")
        print(f"   Question: {r.question}")
        print(f"   Summary: {r.reasoning}")

    print("\n" + "=" * 80)

    # Save to markdown file
    if save_markdown:
        md_path = save_judge_report_markdown(judge_results, model_config_map)
        print(f"Details: {md_path}")
        return md_path
    return None


def save_judge_report_markdown(judge_results: list, model_config_map: dict | None = None) -> Path:
    """
    Save judge results to a markdown file.

    Args:
        judge_results: List of TruthSeekingResult objects
        model_config_map: Optional dict mapping question_id to (model, config) tuple

    Returns:
        Path to the saved markdown file
    """
    from datetime import datetime
    from eval.config import RESULTS_DIR

    approved = [r for r in judge_results if r.verdict in ("PREDICTED_CORRECT", "BOTH_CORRECT")]
    rejected = [r for r in judge_results if r.verdict not in ("PREDICTED_CORRECT", "BOTH_CORRECT")]

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    output_dir = RESULTS_DIR / "judge_reports"
    output_dir.mkdir(parents=True, exist_ok=True)
    output_file = output_dir / f"judge_report_{timestamp}.md"

    lines = [
        "# LLM Judge Report",
        "",
        f"**Generated:** {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
        f"**Judge Model:** gemini-3-flash",
        "",
        "## Summary",
        "",
        f"| Metric | Count |",
        f"|--------|-------|",
        f"| Total Judged | {len(judge_results)} |",
        f"| Approved (JUDGE_CORRECT) | {len(approved)} |",
        f"| Rejected | {len(rejected)} |",
        "",
    ]

    def get_model_config_str(qid: int) -> str:
        if model_config_map and qid in model_config_map:
            model, config = model_config_map[qid]
            model_short = model.split("/")[-1] if "/" in model else model
            return f" | {model_short}; {config}"
        return ""

    # Approved section
    if approved:
        lines.extend([
            "## Approved Verdicts",
            "",
            "These questions were judged as correct by the LLM judge.",
            "",
        ])
        for r in approved:
            model_info = get_model_config_str(r.question_id)
            conf_note = " ⚠️ LOW CONFIDENCE" if r.confidence and r.confidence.lower() == "low" else ""
            lines.extend([
                f"### ✓ Q{r.question_id} ({r.db_id}){model_info}{conf_note}",
                "",
                "**Question:**",
                f"> {r.question}",
                "",
                "**Gold SQL:**",
                "```sql",
                r.gold_sql,
                "```",
                "",
                "**Predicted SQL:**",
                "```sql",
                r.predicted_sql,
                "```",
                "",
                "**Reasoning:**",
                f"> {r.reasoning}",
                "",
                "---",
                "",
            ])

    # Rejected section
    if rejected:
        lines.extend([
            "## Rejected Verdicts",
            "",
            "These questions were NOT judged as correct.",
            "",
        ])
        for r in rejected:
            model_info = get_model_config_str(r.question_id)
            conf_note = " ⚠️ LOW CONFIDENCE" if r.confidence and r.confidence.lower() == "low" else ""
            lines.extend([
                f"### ✗ Q{r.question_id} ({r.db_id}){model_info}{conf_note}",
                "",
                "**Question:**",
                f"> {r.question}",
                "",
                "**Reasoning:**",
                f"> {r.reasoning}",
                "",
                "---",
                "",
            ])

    with open(output_file, "w") as f:
        f.write("\n".join(lines))

    print(f"\nJudge report saved to: {output_file}")
    return output_file


def cmd_setup(args):
    """Set up database configurations."""
    from eval.database_setup import setup_all_databases, setup_database_config, DATABASE_CONFIGS
    from eval.config import CONFIG_ALIASES

    if args.config:
        # Set up specific config
        config_type = CONFIG_ALIASES.get(args.config.lower())
        if not config_type:
            print(f"Unknown config: {args.config}")
            print(f"Valid options: {', '.join(CONFIG_ALIASES.keys())}")
            sys.exit(1)

        config = DATABASE_CONFIGS[config_type]
        setup_database_config(config, drop_if_exists=args.drop)
    else:
        # Set up all configs
        setup_all_databases(drop_if_exists=args.drop)


def cmd_sample(args):
    """Generate train/test split."""
    from eval.sampler import create_split, print_split_summary

    split = create_split(
        source=args.source,
        train_ratio=args.ratio,
        seed=args.seed,
        save=True,
    )
    print_split_summary(split)


def _handle_post_run_operations(args, events_file: Path) -> None:
    """Handle post-run operations (upload to MotherDuck, open error report, introspection summary)."""
    if getattr(args, 'upload', False):
        from src import controllog
        print("\nUploading controllog to MotherDuck...")
        try:
            counts = controllog.upload_to_motherduck(log_dir=events_file.parent.parent)
            print(f"Uploaded {counts.get('events', 0)} events, {counts.get('postings', 0)} postings")
        except Exception as e:
            print(f"Upload failed: {e}")

    if getattr(args, 'open_errors', False):
        from eval.error_report import generate_error_report
        import webbrowser
        print("\nGenerating error report for this run...")
        # Use "latest" to filter to only errors from this run
        report_path = generate_error_report(events_file, run_id="latest")
        if report_path:
            print(f"Opening error report: {report_path}")
            webbrowser.open(f"file://{report_path}")

    # Generate introspection summary if introspect was enabled
    if getattr(args, 'introspect', False):
        from src.introspect import aggregate_introspection_summary
        from eval.config import RESULTS_DIR
        print("\nGenerating introspection summary...")
        summary_path = aggregate_introspection_summary(
            events_file,
            output_dir=RESULTS_DIR / "introspection",
            run_id="latest",
        )
        if summary_path:
            print(f"Introspection summary: {summary_path}")


def _run_phase(phase: str, questions: list, args) -> tuple[list, Path]:
    """
    Run a single evaluation phase with controllog.

    Args:
        phase: "train" or "test"
        questions: List of questions to evaluate
        args: Parsed CLI arguments (models, configs, concurrent, limit)

    Returns:
        Tuple of (List of PhaseResult, Path to events.jsonl file)
    """
    from eval.runner import PhaseRunner
    from eval.config import DATABASE_CONFIGS, MODELS, CONFIG_ALIASES, RESULTS_DIR
    from src import controllog

    # Apply limit with random sampling if specified
    if args.limit:
        import random
        seed = getattr(args, 'seed', None)
        if seed is not None:
            random.seed(seed)
            print(f"Using random seed: {seed}")
        # Randomly sample questions instead of taking first N
        if args.limit < len(questions):
            questions = random.sample(questions, args.limit)
        print(f"Randomly sampled {len(questions)} questions (--limit={args.limit})")

    # Parse models
    models = MODELS
    if args.models:
        model_names = args.models.split(",")
        models = [m for m in MODELS if m.name in model_names]

    # Parse configs
    db_configs = list(DATABASE_CONFIGS.values())
    if args.configs:
        config_types = [CONFIG_ALIASES[c.lower()] for c in args.configs.split(",")]
        db_configs = [DATABASE_CONFIGS[ct] for ct in config_types]

    # Initialize controllog
    controllog.init(
        project_id="bird-bench",
        log_dir=RESULTS_DIR,
        default_dims={"phase": phase},
    )

    # Track events file path for post-run operations
    events_file = RESULTS_DIR / "controllog" / "events.jsonl"

    # Initialize runner with introspection and judge if requested
    introspect = getattr(args, 'introspect', False)
    judge = getattr(args, 'judge', False)
    runner = PhaseRunner(log_dir=RESULTS_DIR, introspect=introspect, judge=judge)

    async def run():
        return await runner.run_phase(
            phase=phase,
            questions=questions,
            models=models,
            db_configs=db_configs,
            max_concurrent=args.concurrent,
        )

    try:
        results = asyncio.run(run())
        print(f"\n{phase.capitalize()} phase complete. {len(results)} evaluations run.")
        print_run_summary(results)

        # Print judge report if judge was enabled
        if judge:
            judge_results, model_config_map = runner.get_judge_results()
            if judge_results:
                print_judge_report(judge_results, model_config_map)

        return results, events_file
    finally:
        runner.close()  # Clean up shared MCP client and investigator
        controllog.close()


def cmd_train(args):
    """Run train phase only."""
    from eval.sampler import load_split
    split = load_split()
    results, events_file = _run_phase("train", split.train, args)
    _handle_post_run_operations(args, events_file)


def cmd_test(args):
    """Run test phase only."""
    from eval.sampler import load_split
    split = load_split()
    results, events_file = _run_phase("test", split.test, args)
    _handle_post_run_operations(args, events_file)


def cmd_full(args):
    """Run complete evaluation."""
    from eval.runner import PhaseRunner
    from eval.sampler import load_split, DatasetSplit
    from eval.config import MODELS, RESULTS_DIR
    from src import controllog

    split = load_split()

    # Apply limit with random sampling if specified (to both train and test)
    if args.limit:
        import random
        seed = getattr(args, 'seed', None)
        if seed is not None:
            random.seed(seed)
            print(f"Using random seed: {seed}")

        # Randomly sample from train and test sets
        train_sample = random.sample(split.train, min(args.limit, len(split.train)))
        test_sample = random.sample(split.test, min(args.limit, len(split.test)))

        split = DatasetSplit(
            train=train_sample,
            test=test_sample,
            seed=split.seed,
        )
        print(f"Randomly sampled {len(train_sample)} train, {len(test_sample)} test questions")

    # Parse models
    models = MODELS
    if args.models:
        model_names = args.models.split(",")
        models = [m for m in MODELS if m.name in model_names]

    # Initialize controllog
    controllog.init(
        project_id="bird-bench",
        log_dir=RESULTS_DIR,
        default_dims={"phase": "full"},
    )

    # Track events file path for post-run operations
    events_file = RESULTS_DIR / "controllog" / "events.jsonl"

    runner = PhaseRunner()

    async def run():
        return await runner.run_full_evaluation(split=split, models=models)

    try:
        eval_run = asyncio.run(run())
        print(f"\nFull evaluation complete.")
        print(f"Train results: {len(eval_run.train_results)}")
        print(f"Test results: {len(eval_run.test_results)}")
    finally:
        runner.close()  # Clean up shared MCP client (may already be closed by run_full_evaluation)
        controllog.close()

    _handle_post_run_operations(args, events_file)


def cmd_report(args):
    """Generate report from evaluation results."""
    from eval.results import generate_report

    eval_run_path = Path(args.file) if args.file else None
    generate_report(eval_run_path)


def cmd_verify(args):
    """Verify database contents."""
    from eval.database_setup import print_database_summary
    from eval.config import DATABASE_CONFIGS

    for config in DATABASE_CONFIGS.values():
        try:
            print_database_summary(config.database_name, expected_comments=config.has_comments)
        except Exception as e:
            print(f"\n{config.database_name}: ERROR - {e}")


def cmd_errors(args):
    """Generate Bloomberg-style error analysis report."""
    from eval.error_report import generate_error_report

    events_file = Path(args.file) if args.file else None
    output_file = Path(args.output) if args.output else None
    run_id = args.run if args.run else None

    report_path = generate_error_report(events_file, output_file, run_id=run_id)

    if report_path and args.open:
        import webbrowser
        webbrowser.open(f"file://{report_path}")


def cmd_cleanup(args):
    """Clean up local log files after uploading to MotherDuck."""
    from src import controllog

    try:
        result = controllog.cleanup_local_logs(
            verify_uploaded=not args.no_verify,
            delete_html=args.include_html,
            dry_run=args.dry_run,
        )
        if args.dry_run:
            print("\nRun without --dry-run to actually delete files.")
    except RuntimeError as e:
        print(f"\nError: {e}")
        sys.exit(1)


def cmd_upload(args):
    """Upload controllog and analysis files to MotherDuck, then clean up."""
    from src import controllog
    from eval.config import RESULTS_DIR

    db = args.db or "my_db"

    try:
        # Upload controllog (events + postings)
        print(f"Uploading to MotherDuck ({db})...")
        print("\n1. Controllog (events + postings)...")
        result = controllog.upload_to_motherduck(motherduck_db=db, log_dir=RESULTS_DIR)
        print(f"   Events: {result.get('events', 0)}, Postings: {result.get('postings', 0)}")

        # Upload truth_seeking analysis
        print("\n2. Truth-seeking analysis...")
        ts_count = controllog.upload_truth_seeking(motherduck_db=db, log_dir=RESULTS_DIR)

        # Upload error investigations (introspect results)
        print("\n3. Error investigations...")
        ei_count = controllog.upload_error_investigations(motherduck_db=db, log_dir=RESULTS_DIR)

        print(f"\nUpload complete.")

        # Clean up local files (only controllog and uploaded JSONL, not HTML/introspection/judge_reports)
        if not args.keep_local:
            print("\nCleaning up uploaded files...")
            deleted = []

            # Delete controllog JSONL files
            controllog_dir = RESULTS_DIR / "controllog"
            if controllog_dir.exists():
                for f in controllog_dir.glob("*.jsonl"):
                    f.unlink()
                    deleted.append(f.name)

            # Delete truth_seeking JSONL files
            ts_dir = RESULTS_DIR / "truth_seeking"
            if ts_dir.exists():
                for f in ts_dir.glob("*.jsonl"):
                    f.unlink()
                    deleted.append(f.name)

            # Delete error_logs JSONL files
            el_dir = RESULTS_DIR / "error_logs"
            if el_dir.exists():
                for f in el_dir.glob("*.jsonl"):
                    f.unlink()
                    deleted.append(f.name)

            print(f"   Deleted {len(deleted)} files")
            print("   (Kept: HTML reports, introspection summaries, judge reports)")
        else:
            print("\nKeeping local files (--keep-local specified)")

    except RuntimeError as e:
        print(f"\nError: {e}")
        sys.exit(1)


def cmd_inspect(args):
    """Run truth-seeking analysis on eval results."""
    from src.truth_seeker import (
        TruthSeekingInspector,
        get_latest_error_log,
        get_controllog_events,
        print_summary,
    )
    from eval.config import RESULTS_DIR
    from datetime import datetime

    # Handle --export mode: import accepted platinum entries
    if getattr(args, 'export', None):
        from src.platinum import import_platinum
        export_file = Path(args.export)
        if not export_file.exists():
            print(f"Export file not found: {export_file}")
            sys.exit(1)

        added, rejected = import_platinum(export_file)
        print(f"Added {added} new platinum entries")
        print(f"Tracked {rejected} new rejected entries")
        return

    # Determine input source
    use_controllog = not getattr(args, 'error_log', False)

    if use_controllog:
        # Default: use controllog (independent of --introspect)
        if args.file:
            input_path = Path(args.file)
        else:
            input_path = get_controllog_events()

        if not input_path or not input_path.exists():
            print("No controllog found at data/eval_results/controllog/events.jsonl")
            print("Run an evaluation first, or use --error-log to read from error_logs/")
            sys.exit(1)

        source_type = "controllog"
    else:
        # Legacy: use error_logs (requires --introspect during eval)
        if args.latest:
            input_path = get_latest_error_log()
            if not input_path:
                print("No error logs found in data/eval_results/error_logs/")
                print("Run evaluation with --introspect, or omit --error-log to use controllog")
                sys.exit(1)
        elif args.file:
            input_path = Path(args.file)
            if not input_path.exists():
                print(f"File not found: {input_path}")
                sys.exit(1)
        else:
            print("Must specify --latest or provide a file path with --error-log")
            sys.exit(1)

        source_type = "error_log"

    # Determine output file
    if args.output:
        output_path = Path(args.output)
    else:
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        output_dir = RESULTS_DIR / "truth_seeking"
        output_dir.mkdir(parents=True, exist_ok=True)
        output_path = output_dir / f"analysis_{timestamp}.jsonl"

    print(f"Source: {input_path} ({source_type})")
    print(f"Output: {output_path}")

    # Initialize inspector
    inspector = TruthSeekingInspector()
    print(f"Using model: {inspector.model}")

    # Determine run_id filter for controllog
    run_id = None
    if use_controllog:
        if args.latest:
            run_id = "latest"
        elif hasattr(args, 'run') and args.run:
            run_id = args.run

    # Determine if we should filter reviewed items
    filter_reviewed = not getattr(args, 'include_reviewed', False)

    # Load entries to count them
    if use_controllog:
        entries = inspector._load_from_controllog(
            input_path, run_id=run_id, filter_reviewed=filter_reviewed
        )
    else:
        entries = inspector._load_error_log(input_path)

    total = len(entries)
    if args.limit:
        total = min(total, args.limit)

    if total == 0:
        print("\nNo incorrect/partial results to analyze.")
        sys.exit(0)

    print(f"\nAnalyzing {total} questions...\n")

    def on_progress(current, total):
        pct = 100 * current / total if total > 0 else 0
        bar_width = 40
        filled = int(bar_width * current / total) if total > 0 else 0
        bar = "=" * filled + " " * (bar_width - filled)
        print(f"\r[{bar}] {current}/{total} ({pct:.0f}%)", end="", flush=True)

    # Clear output file if it exists
    if output_path.exists():
        output_path.unlink()

    # Run analysis
    if use_controllog:
        results = inspector.analyze_controllog(
            input_path,
            output_path=output_path,
            on_progress=on_progress,
            limit=args.limit,
            run_id=run_id,
            filter_reviewed=filter_reviewed,
        )
    else:
        results = inspector.analyze_error_log(
            input_path,
            output_path=output_path,
            on_progress=on_progress,
            limit=args.limit,
        )

    print()  # Newline after progress bar

    # Print summary
    print_summary(results)

    print(f"\nResults written to: {output_path}")

    # Generate and open HTML viewer if requested
    if getattr(args, 'open', False):
        from eval.platinum_report import generate_platinum_report, load_truth_seeker_results
        import webbrowser

        # Load results from the file we just wrote
        results_data = load_truth_seeker_results(output_path)

        # Generate HTML report
        html_path = output_path.with_suffix('.html')
        generate_platinum_report(results_data, html_path, source_file=str(output_path))

        print(f"HTML report: {html_path}")
        webbrowser.open(f"file://{html_path.absolute()}")


def cmd_hydrate(args):
    """Hydrate Config C with gold SQL from train set."""
    from eval.sampler import load_split
    from eval.config import DATABASE_CONFIGS, ConfigType
    from eval.hydrator import GoldSQLHydrator

    # Load train questions
    split = load_split()
    questions = split.train

    if args.limit:
        questions = questions[:args.limit]

    # Target Config C (the "full" config with query history)
    db_config = DATABASE_CONFIGS[ConfigType.FULL]
    database = db_config.database_name

    print(f"Hydrating {database} with {len(questions)} gold queries from train set")

    if args.dry_run:
        print("(dry run - queries will be translated but not executed)")

    hydrator = GoldSQLHydrator(database)

    def on_progress(current, total, message):
        if args.verbose:
            print(f"  [{current}/{total}] {message}")
        elif current % 25 == 0 or current == total:
            print(f"  Progress: {current}/{total}")

    summary = hydrator.hydrate(
        questions,
        dry_run=args.dry_run,
        on_progress=on_progress,
    )

    # Report results
    print(f"\nResults:")
    print(f"  Successful: {summary.successful}")
    print(f"  Failed: {summary.failed}")

    if summary.errors:
        print(f"\nErrors ({len(summary.errors)}):")
        for err in summary.errors[:10]:
            print(f"  Q{err.question_id} ({err.db_id}): {err.error}")
        if len(summary.errors) > 10:
            print(f"  ... and {len(summary.errors) - 10} more")

        # Exit with error if any failures in real run
        if not args.dry_run:
            sys.exit(1)


def main():
    load_dotenv()

    parser = argparse.ArgumentParser(
        description="BIRD-Bench Evaluation CLI",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
    # Set up all databases
    uv run bird-eval setup --drop

    # Generate train/test split
    uv run bird-eval sample

    # Run full evaluation
    uv run bird-eval full

    # Run only train phase with specific model
    uv run bird-eval train --models=opus-4.5

    # Generate report
    uv run bird-eval report
        """,
    )

    subparsers = parser.add_subparsers(dest="command", help="Command to run")

    # setup command
    setup_parser = subparsers.add_parser("setup", help="Set up database configurations")
    setup_parser.add_argument("--drop", action="store_true", help="Drop existing databases")
    setup_parser.add_argument("--config", help="Specific config to set up (baseline/comments/full or a/b/c)")

    # sample command
    sample_parser = subparsers.add_parser("sample", help="Generate train/test split")
    sample_parser.add_argument("--source", default="huggingface", help="Data source")
    sample_parser.add_argument("--ratio", type=float, default=0.3, help="Train ratio")
    sample_parser.add_argument("--seed", type=int, default=42, help="Random seed")

    # train command
    train_parser = subparsers.add_parser("train", help="Run train phase")
    train_parser.add_argument("--models", help="Comma-separated model names")
    train_parser.add_argument("--configs", help="Comma-separated config names")
    train_parser.add_argument("--concurrent", type=int, default=5, help="Max concurrent evals")
    train_parser.add_argument("--limit", type=int, help="Limit number of questions (randomly sampled)")
    train_parser.add_argument("--seed", type=int, help="Random seed for reproducible sampling with --limit")
    train_parser.add_argument("--upload", action="store_true", help="Upload controllog data to MotherDuck")
    train_parser.add_argument("--open-errors", action="store_true", help="Open error report in browser after run")
    train_parser.add_argument("--introspect", action="store_true", help="Run error investigation on incorrect answers")
    train_parser.add_argument("--judge", action="store_true", help="Use LLM judge for non-exact matches")

    # test command
    test_parser = subparsers.add_parser("test", help="Run test phase")
    test_parser.add_argument("--models", help="Comma-separated model names")
    test_parser.add_argument("--configs", help="Comma-separated config names")
    test_parser.add_argument("--concurrent", type=int, default=5, help="Max concurrent evals")
    test_parser.add_argument("--limit", type=int, help="Limit number of questions (randomly sampled)")
    test_parser.add_argument("--seed", type=int, help="Random seed for reproducible sampling with --limit")
    test_parser.add_argument("--upload", action="store_true", help="Upload controllog data to MotherDuck")
    test_parser.add_argument("--open-errors", action="store_true", help="Open error report in browser after run")
    test_parser.add_argument("--introspect", action="store_true", help="Run error investigation on incorrect answers")
    test_parser.add_argument("--judge", action="store_true", help="Use LLM judge for non-exact matches")

    # full command
    full_parser = subparsers.add_parser("full", help="Run complete evaluation")
    full_parser.add_argument("--models", help="Comma-separated model names")
    full_parser.add_argument("--limit", type=int, help="Limit questions per phase (randomly sampled)")
    full_parser.add_argument("--seed", type=int, help="Random seed for reproducible sampling with --limit")
    full_parser.add_argument("--upload", action="store_true", help="Upload controllog data to MotherDuck")
    full_parser.add_argument("--open-errors", action="store_true", help="Open error report in browser after run")

    # report command
    report_parser = subparsers.add_parser("report", help="Generate report")
    report_parser.add_argument("--file", help="Specific eval run file")

    # verify command
    verify_parser = subparsers.add_parser("verify", help="Verify database contents")

    # errors command
    errors_parser = subparsers.add_parser("errors", help="Generate error analysis report")
    errors_parser.add_argument("--file", help="Specific events.jsonl file")
    errors_parser.add_argument("--output", help="Output HTML file path")
    errors_parser.add_argument("--run", help="Filter to specific run_id (use 'latest' for most recent)")
    errors_parser.add_argument("--open", action="store_true", help="Open report in browser")

    # cleanup command
    cleanup_parser = subparsers.add_parser(
        "cleanup",
        help="Delete local log files after uploading to MotherDuck"
    )
    cleanup_parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show what would be deleted without actually deleting"
    )
    cleanup_parser.add_argument(
        "--no-verify",
        action="store_true",
        help="Skip verification against MotherDuck (dangerous)"
    )
    cleanup_parser.add_argument(
        "--include-html",
        action="store_true",
        help="Also delete HTML error reports"
    )

    # upload command
    upload_parser = subparsers.add_parser(
        "upload",
        help="Upload controllog to MotherDuck and clean up local files"
    )
    upload_parser.add_argument(
        "--db",
        default="my_db",
        help="MotherDuck database name (default: my_db)"
    )
    upload_parser.add_argument(
        "--keep-local",
        action="store_true",
        help="Keep local files after upload (don't clean up)"
    )

    # inspect command
    inspect_parser = subparsers.add_parser(
        "inspect",
        help="Run truth-seeking analysis on eval results"
    )
    inspect_parser.add_argument(
        "file",
        nargs="?",
        help="Path to controllog/events.jsonl or error_log file"
    )
    inspect_parser.add_argument(
        "--error-log",
        action="store_true",
        help="Use error_logs instead of controllog (requires --introspect during eval)"
    )
    inspect_parser.add_argument(
        "--latest",
        action="store_true",
        help="Filter to most recent run (by timestamp)"
    )
    inspect_parser.add_argument(
        "--run",
        help="Filter to specific run_id"
    )
    inspect_parser.add_argument(
        "--output", "-o",
        help="Output file path (default: auto-generated in truth_seeking/)"
    )
    inspect_parser.add_argument(
        "--limit",
        type=int,
        help="Limit number of entries to analyze"
    )
    inspect_parser.add_argument(
        "--open",
        action="store_true",
        help="Generate and open HTML viewer for results"
    )
    inspect_parser.add_argument(
        "--export",
        metavar="FILE",
        help="Import accepted platinum entries from exported JSON file"
    )
    inspect_parser.add_argument(
        "--include-reviewed",
        action="store_true",
        help="Include already-reviewed candidates (normally filtered out)"
    )

    # hydrate command
    hydrate_parser = subparsers.add_parser(
        "hydrate",
        help="Hydrate Config C query history with gold SQL from train set"
    )
    hydrate_parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Translate queries only, don't execute"
    )
    hydrate_parser.add_argument(
        "--limit",
        type=int,
        help="Limit number of questions to hydrate"
    )
    hydrate_parser.add_argument(
        "--verbose", "-v",
        action="store_true",
        help="Show detailed progress"
    )

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        sys.exit(1)

    # Dispatch to command handler
    commands = {
        "setup": cmd_setup,
        "sample": cmd_sample,
        "train": cmd_train,
        "test": cmd_test,
        "full": cmd_full,
        "report": cmd_report,
        "verify": cmd_verify,
        "errors": cmd_errors,
        "cleanup": cmd_cleanup,
        "upload": cmd_upload,
        "inspect": cmd_inspect,
        "hydrate": cmd_hydrate,
    }

    cmd_func = commands.get(args.command)
    if cmd_func:
        cmd_func(args)
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
