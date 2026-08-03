"""CLI for the shared DABstep and Agentic Company evaluation harness.

DABstep remains the default profile. Agentic Company supplies an external
question set, a single manual guide, a shared multi-schema snapshot, an
isolated prompt/skill, and criteria-driven scoring while reusing the same agent
loop, MCP tools, concurrency, retries, logging, results, and summary behavior.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import subprocess
import time
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path

import click
import controllog
from dotenv import load_dotenv
from rich.console import Console
from rich.padding import Padding
from rich.table import Table
from rich.text import Text

from src import guides_load
from src.agent import OpenRouterProvider, run_agent
from src.agentic_company_score import score as score_agentic_company
from src.load import DEFAULT_DATABASE, build_db
from src.mcp_client import create_mcp_session
from src.score import ExecutionError
from src.score import score as score_dabstep

REPO_ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = REPO_ROOT / "data"
RESULTS_DIR = REPO_ROOT / "results"
SKILL_PATH = REPO_ROOT / "skill" / "SKILL.md"
AGENTIC_COMPANY_SKILL_PATH = REPO_ROOT / "skill" / "AGENTIC_COMPANY.md"
TASKS_PATH = DATA_DIR / "dabstep" / "tasks" / "all.jsonl"
SPLIT_PATH = DATA_DIR / "split.json"

AGENTIC_COMPANY_BENCHMARK = "agentic-company"
AGENTIC_COMPANY_DATABASE = "agentic_company_snapshot"
AGENTIC_COMPANY_GUIDE_TOPIC = "agentic-company/manual"
AGENTIC_COMPANY_MANIFEST_VERSION = "0.3.0"
AGENTIC_COMPANY_SNAPSHOT_CUTOFF = "2026-07-31"
AGENTIC_COMPANY_TASK_COUNT = 40
AGENTIC_COMPANY_TOPIC_COUNT = 10
AGENTIC_COMPANY_DIFFICULTY_DISTRIBUTION = {"easy": 10, "hard": 30}
AGENTIC_COMPANY_DATABASE_BYTES = 705_441_792
AGENTIC_COMPANY_DATABASE_SHA256 = (
    "0a3c0bd92591093ad936d4eeb3cecf60958916dbbfd75ea4210b88619f0d9aa2"
)
AGENTIC_COMPANY_QUESTIONS_SHA256 = (
    "ed3dc9836d8401cfdf614270adad262e0f22ae68df67e6c08741c0871170abd1"
)
AGENTIC_COMPANY_MANUAL_SHA256 = (
    "fb68e02d6263e4d5d260769bf2b716be2d0c4139743ae67f7a87c1b45c14013f"
)
AGENTIC_COMPANY_SHARE = (
    "md:_share/agentic_company_snapshot_share/"
    "6b172abb-d377-4f0f-9a8a-d0ac199e074d"
)
AGENTIC_COMPANY_EXCLUDED_SCHEMAS = ("ground_truth", "sim")
_AGENTIC_REQUIRED_FIELDS = (
    "task_id",
    "question",
    "guidelines",
    "answer",
    "answer_criteria",
    "level",
    "topic_id",
    "topic",
    "snapshot_cutoff",
    "source_tables",
)
_AGENTIC_CRITERIA_TYPES = {
    "number",
    "string",
    "label:number",
    "label:label:number",
    "list[string]",
}

console = Console()

PROJECT_ID = "agentic-sql-claude-edition"
AGENT_ID = "asc-sql"

MODEL_ALIASES = {
    "opus": "anthropic/claude-opus-4.7",
    "sonnet": "anthropic/claude-sonnet-4.6",
    "haiku": "anthropic/claude-haiku-4.5",
    "gemini": "google/gemini-3-flash-preview",
    "gpt": "openai/gpt-5.5",
    "luna": "openai/gpt-5.6-luna",
}


def _git_output(*args: str) -> str | None:
    try:
        return subprocess.check_output(
            ["git", *args],
            cwd=REPO_ROOT,
            stderr=subprocess.DEVNULL,
            text=True,
        ).strip()
    except Exception:
        return None


def _build_run_provenance(
    *,
    benchmark: str,
    split: str,
    database: str,
    model: str,
    reasoning: str,
    max_turns: int,
    concurrency: int,
    out: Path,
    question_count: int,
    artifacts: dict | None = None,
) -> dict:
    commit_sha = _git_output("rev-parse", "HEAD")
    dirty_status = _git_output("status", "--porcelain")
    resolved_config = {
        "benchmark": benchmark,
        "split": split,
        "database": database,
        "model": model,
        "reasoning": reasoning,
        "max_turns": max_turns,
        "concurrency": concurrency,
        "question_count": question_count,
        "run_label": out.stem,
    }
    if artifacts:
        # controllog.run_metadata has a fixed keyword schema. Keep benchmark
        # provenance nested inside its supported resolved_config payload so
        # artifact hashes participate in the config hash without becoming an
        # unexpected top-level keyword.
        resolved_config["benchmark_artifacts"] = artifacts
    provenance = {
        "commit_sha": commit_sha,
        "repo": _git_output("config", "--get", "remote.origin.url"),
        "dirty": bool(dirty_status) if dirty_status is not None else None,
        "effort": reasoning,
        "resolved_config": resolved_config,
        "agent_name": AGENT_ID,
        "dataset_name": database,
        "dataset_version": (artifacts or {}).get("version", split),
    }
    return provenance


def _md_database() -> str:
    return os.environ.get("MD_DATABASE", DEFAULT_DATABASE)


def _agentic_company_benchmark_dir() -> Path:
    configured = os.environ.get("AGENTIC_COMPANY_REPO")
    root = Path(configured).expanduser() if configured else REPO_ROOT.parents[2] / "the-agentic-company"
    return root / "benchmarks" / "dabstep_agentic_company"


def _resolve_agentic_paths(
    questions_jsonl: Path | None = None,
    manual: Path | None = None,
) -> tuple[Path, Path, Path]:
    benchmark_dir = _agentic_company_benchmark_dir()
    return (
        questions_jsonl or benchmark_dir / "questions.jsonl",
        manual or benchmark_dir / "manual.md",
        benchmark_dir / "manifest.json",
    )


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _validate_agentic_manifest(questions: list[dict], manifest: dict) -> None:
    """Reject incomplete/drifted benchmark artifacts before model spend."""
    if manifest.get("version") != AGENTIC_COMPANY_MANIFEST_VERSION:
        raise ValueError(
            "Agentic Company manifest version does not match this harness: "
            f"expected {AGENTIC_COMPANY_MANIFEST_VERSION!r}, "
            f"received {manifest.get('version')!r}."
        )
    cutoff = manifest.get("snapshot_cutoff")
    if cutoff != AGENTIC_COMPANY_SNAPSHOT_CUTOFF:
        raise ValueError(
            "Agentic Company manifest snapshot_cutoff does not match this harness: "
            f"expected {AGENTIC_COMPANY_SNAPSHOT_CUTOFF!r}, received {cutoff!r}."
        )
    excluded_schemas = manifest.get("excluded_schemas")
    if excluded_schemas != list(AGENTIC_COMPANY_EXCLUDED_SCHEMAS):
        raise ValueError(
            "Agentic Company manifest excluded_schemas does not match the enforced "
            f"boundary: expected {list(AGENTIC_COMPANY_EXCLUDED_SCHEMAS)!r}, "
            f"received {excluded_schemas!r}."
        )
    source_database = manifest.get("source_database")
    if not isinstance(source_database, dict):
        raise TypeError("Agentic Company manifest source_database must be an object.")
    if source_database.get("path") != "data/company_for_analysis.duckdb":
        raise ValueError("Agentic Company manifest source_database.path is not canonical.")
    source_bytes = source_database.get("bytes")
    if source_bytes != AGENTIC_COMPANY_DATABASE_BYTES:
        raise ValueError(
            "Agentic Company manifest database byte size does not match the pinned snapshot."
        )
    if source_database.get("sha256") != AGENTIC_COMPANY_DATABASE_SHA256:
        raise ValueError(
            "Agentic Company manifest database SHA does not match the pinned snapshot."
        )
    expected_count = manifest.get("task_count")
    if isinstance(expected_count, bool) or not isinstance(expected_count, int):
        raise TypeError("Agentic Company manifest task_count must be an integer.")
    if expected_count != AGENTIC_COMPANY_TASK_COUNT:
        raise ValueError(
            f"Agentic Company manifest task_count must be {AGENTIC_COMPANY_TASK_COUNT}."
        )
    if len(questions) != expected_count:
        raise ValueError(
            "Agentic Company questions.jsonl does not match manifest task_count: "
            f"expected {expected_count}, loaded {len(questions)}."
        )
    expected_distribution = manifest.get("difficulty_distribution")
    if not isinstance(expected_distribution, dict):
        raise TypeError("Agentic Company manifest difficulty_distribution must be an object.")
    if expected_distribution != AGENTIC_COMPANY_DIFFICULTY_DISTRIBUTION:
        raise ValueError(
            "Agentic Company manifest difficulty_distribution does not match the "
            f"pinned benchmark: {AGENTIC_COMPANY_DIFFICULTY_DISTRIBUTION}."
        )
    actual_distribution: dict[str, int] = {}
    for question in questions:
        level = str(question.get("level") or "")
        actual_distribution[level] = actual_distribution.get(level, 0) + 1
    if actual_distribution != expected_distribution:
        raise ValueError(
            "Agentic Company question difficulty distribution does not match manifest: "
            f"expected {expected_distribution}, loaded {actual_distribution}."
        )
    expected_topics = manifest.get("topic_count")
    actual_topics = len({str(question.get("topic_id")) for question in questions})
    if isinstance(expected_topics, bool) or not isinstance(expected_topics, int):
        raise TypeError("Agentic Company manifest topic_count must be an integer.")
    if expected_topics != AGENTIC_COMPANY_TOPIC_COUNT:
        raise ValueError(
            f"Agentic Company manifest topic_count must be {AGENTIC_COMPANY_TOPIC_COUNT}."
        )
    if actual_topics != expected_topics:
        raise ValueError(
            "Agentic Company question topic count does not match manifest: "
            f"expected {expected_topics}, loaded {actual_topics}."
        )
    topics = manifest.get("topics")
    if not isinstance(topics, list) or len(topics) != expected_topics:
        raise ValueError("Agentic Company manifest topics must list every topic exactly once.")
    expected_by_id: dict[str, dict] = {}
    for topic in topics:
        if not isinstance(topic, dict) or not isinstance(topic.get("topic_id"), str):
            raise TypeError("Every Agentic Company manifest topic must be an object with topic_id.")
        topic_id = topic["topic_id"]
        if topic_id in expected_by_id:
            raise ValueError(f"Duplicate Agentic Company manifest topic_id {topic_id!r}.")
        expected_by_id[topic_id] = topic
    canonical_topic_ids = {f"T{index:02d}" for index in range(1, 11)}
    if set(expected_by_id) != canonical_topic_ids:
        raise ValueError("Agentic Company manifest must contain topic IDs T01 through T10.")
    actual_by_id: dict[str, dict[str, object]] = {}
    for question in questions:
        topic_id = question["topic_id"]
        topic_name = question["topic"]
        if question["snapshot_cutoff"] != cutoff:
            raise ValueError(
                f"{question['task_id']}: snapshot_cutoff does not match manifest."
            )
        source_tables = question["source_tables"]
        if not isinstance(source_tables, list) or not source_tables or not all(
            isinstance(table, str) and table for table in source_tables
        ):
            raise TypeError(f"{question['task_id']}: source_tables must be non-empty strings.")
        actual = actual_by_id.setdefault(
            topic_id,
            {"topic": topic_name, "task_count": 0, "easy_count": 0, "hard_count": 0},
        )
        if actual["topic"] != topic_name:
            raise ValueError(f"{topic_id}: question topic labels are inconsistent.")
        actual["task_count"] = int(actual["task_count"]) + 1
        level_key = f"{question['level']}_count"
        actual[level_key] = int(actual[level_key]) + 1
    if set(actual_by_id) != set(expected_by_id):
        raise ValueError("Agentic Company manifest topic IDs do not match questions.jsonl.")
    for topic_id, expected in expected_by_id.items():
        actual = actual_by_id[topic_id]
        for field in ("topic", "task_count", "easy_count", "hard_count"):
            if expected.get(field) != actual[field]:
                raise ValueError(
                    f"Agentic Company topic {topic_id} {field} does not match manifest: "
                    f"expected {expected.get(field)!r}, loaded {actual[field]!r}."
                )


def _validate_agentic_criteria(criteria: object, location: str) -> None:
    if not isinstance(criteria, dict):
        raise TypeError(f"{location}: answer_criteria must be an object")
    answer_type = criteria.get("type")
    if answer_type not in _AGENTIC_CRITERIA_TYPES:
        raise ValueError(f"{location}: unsupported answer criteria type {answer_type!r}")
    if answer_type in {"number", "label:number", "label:label:number"}:
        decimals = criteria.get("decimals")
        if isinstance(decimals, bool) or not isinstance(decimals, int) or decimals < 0:
            raise ValueError(f"{location}: decimals must be a non-negative integer")
        tolerance = criteria.get("tolerance")
        try:
            parsed_tolerance = Decimal(str(tolerance))
        except (InvalidOperation, ValueError, TypeError) as exc:
            raise ValueError(f"{location}: tolerance must be a finite non-negative number") from exc
        if not parsed_tolerance.is_finite() or parsed_tolerance < 0:
            raise ValueError(f"{location}: tolerance must be a finite non-negative number")
    if answer_type in {"label:number", "label:label:number", "list[string]"}:
        delimiter = criteria.get("delimiter")
        if not isinstance(delimiter, str) or not delimiter:
            raise ValueError(f"{location}: delimiter must be a non-empty string")
    if answer_type == "list[string]":
        if not isinstance(criteria.get("order_sensitive"), bool):
            raise ValueError(f"{location}: order_sensitive must be a boolean")
        if not isinstance(criteria.get("empty_answer", ""), str):
            raise ValueError(f"{location}: empty_answer must be a string")


def _bad_golds() -> set[str]:
    """Task ids with provably-wrong hf_consensus golds, set aside (see bad_golds.json)."""
    p = DATA_DIR / "bad_golds.json"
    if not p.exists():
        return set()
    return {str(t) for t in json.loads(p.read_text()).get("task_ids", [])}


def _load_questions(
    split: str,
    *,
    benchmark: str = "dabstep",
    questions_path: Path | None = None,
) -> list[dict]:
    """Load questions, excluding known-bad golds from the test/all sets.
    split='templates' -> the 26 train_ids (one per template; bad golds aren't among them);
    split='test'      -> the 419 held-out questions (all minus the 26 train minus 5 bad golds);
    split='all'       -> 445 (450 minus 5 bad golds).
    """
    if benchmark == AGENTIC_COMPANY_BENCHMARK:
        if split != "all":
            raise ValueError("Agentic Company supports only split='all'.")
        if questions_path is None:
            questions_path = _resolve_agentic_paths()[0]
        if not questions_path.is_file():
            raise FileNotFoundError(f"Agentic Company questions not found: {questions_path}")
        questions: list[dict] = []
        seen: set[str] = set()
        for line_number, line in enumerate(questions_path.read_text().splitlines(), start=1):
            if not line.strip():
                continue
            try:
                question = json.loads(line)
            except json.JSONDecodeError as exc:
                raise ValueError(f"{questions_path}:{line_number}: invalid JSON: {exc}") from exc
            missing = [field for field in _AGENTIC_REQUIRED_FIELDS if field not in question]
            if missing:
                raise ValueError(f"{questions_path}:{line_number}: missing fields {missing}")
            task_id = question["task_id"]
            if not isinstance(task_id, str) or not task_id:
                raise ValueError(f"{questions_path}:{line_number}: task_id must be a string")
            if task_id in seen:
                raise ValueError(f"{questions_path}:{line_number}: duplicate task_id {task_id!r}")
            location = f"{questions_path}:{line_number}"
            _validate_agentic_criteria(question["answer_criteria"], location)
            if not all(
                isinstance(question[field], str)
                for field in (
                    "question",
                    "guidelines",
                    "answer",
                    "level",
                    "topic_id",
                    "topic",
                    "snapshot_cutoff",
                )
            ):
                raise ValueError(
                    f"{location}: question, guidelines, answer, level, topic_id, topic, "
                    "and snapshot_cutoff must be strings"
                )
            if question["level"] not in {"easy", "hard"}:
                raise ValueError(f"{location}: level must be 'easy' or 'hard'")
            seen.add(task_id)
            question["question_index"] = len(questions)
            questions.append(question)
        return questions
    if benchmark != "dabstep":
        raise ValueError(f"Unknown benchmark: {benchmark!r}")

    all_qs = [json.loads(line) for line in TASKS_PATH.read_text().splitlines() if line.strip()]
    bad = _bad_golds()
    if split == "all":
        return [q for q in all_qs if str(q["task_id"]) not in bad]
    split_meta = json.loads(SPLIT_PATH.read_text())
    train_ids = set(split_meta["train_ids"])
    by_id = {str(q["task_id"]): q for q in all_qs}
    if split == "test":
        return [q for q in all_qs if str(q["task_id"]) not in train_ids and str(q["task_id"]) not in bad]
    # 'templates': preserve the order of train_ids, skip any not in all.jsonl.
    return [by_id[i] for i in split_meta["train_ids"] if i in by_id]


@click.group()
def cli() -> None:
    load_dotenv()


@cli.command()
@click.option("--database", default=None, help=f"MotherDuck database (default ${{MD_DATABASE}} or {DEFAULT_DATABASE})")
def load(database: str | None) -> None:
    """Build/refresh the MotherDuck database from data/dabstep/context/."""
    database = database or _md_database()
    console.print(f"Building MotherDuck database [bold]{database}[/bold] …")
    counts = build_db(database)
    table = Table(show_header=True, box=None, padding=(0, 2))
    table.add_column("table", style="cyan")
    table.add_column("rows", justify="right")
    for name, n in counts.items():
        table.add_row(name, f"{n:,}")
    console.print(table)
    console.print(f"[green]✓[/green] built [bold]{database}[/bold]")


@cli.command("context")
def context_cmd() -> None:
    """Where the semantic layer lives now (it moved from local markdown to MCP guides).

    The former in-process context store is gone: the semantic layer IS the
    MotherDuck MCP guides. Publish the local context items as guides with
    `asm guides-load`, then browse them through the MCP (list_guides/get_guide)
    — the same read-only path the agent uses.
    """
    console.print(
        "The semantic layer now lives in MotherDuck MCP [bold]guides[/bold], not a "
        "local context store.\n"
    )
    console.print("  • Publish the local context items as guides:")
    console.print("      [cyan]asm guides-load --dry-run[/cyan]   # preview the planned topics")
    console.print("      [cyan]asm guides-load[/cyan]             # create/update the guides")
    console.print(
        "  • Browse them via the MCP (list_guides/get_guide) — the read-only path\n"
        "    the agent uses. There is no local context inspector anymore."
    )


@cli.command("guides-load")
@click.option(
    "--benchmark",
    type=click.Choice(["dabstep", AGENTIC_COMPANY_BENCHMARK]),
    default="dabstep",
    show_default=True,
    help="Guide bundle to publish.",
)
@click.option("--dry-run", is_flag=True, default=False,
              help="Preview the planned guide topics without making any MCP calls.")
@click.option("--prefix", default=None,
              help="Override the DABstep topic prefix (Agentic Company is fixed).")
@click.option(
    "--manual",
    type=click.Path(path_type=Path),
    default=None,
    help="Agentic Company manual.md (defaults to the canonical external benchmark path).",
)
def guides_load_cmd(
    benchmark: str,
    dry_run: bool,
    prefix: str | None,
    manual: Path | None,
) -> None:
    """Publish the selected benchmark's context to MotherDuck MCP guides.

    DABstep publishes its context-item bundle. Agentic Company discovers or
    creates exactly one personal manual at its fixed topic, without a local UUID
    lock. Live publication requires MOTHERDUCK_TOKEN.
    """
    if not dry_run and not os.environ.get("MOTHERDUCK_TOKEN"):
        raise click.ClickException("MOTHERDUCK_TOKEN is not set.")

    label = "planning" if dry_run else "publishing"
    console.print(f"[bold]{label}[/bold] context items → MotherDuck guides …")
    try:
        if benchmark == AGENTIC_COMPANY_BENCHMARK:
            manual_path = _resolve_agentic_paths(manual=manual)[1]
            results = guides_load.publish_manual_sync(
                manual_path=manual_path,
                prefix=prefix,
                dry_run=dry_run,
            )
        else:
            if manual is not None:
                raise click.ClickException("--manual is only valid for agentic-company.")
            results = guides_load.publish_all_sync(prefix=prefix, dry_run=dry_run)
    except (RuntimeError, TypeError, ValueError, OSError) as exc:
        raise click.ClickException(str(exc)) from exc

    table = Table(show_header=True, box=None, padding=(0, 2))
    table.add_column("id", style="cyan")
    table.add_column("topic")
    table.add_column("uuid", style="dim")
    table.add_column("action")
    action_style = {
        "created": "green", "updated": "green", "planned": "dim", "failed": "red",
    }
    for r in results:
        action = r.get("action") or "?"
        style = action_style.get(action, "white")
        row_action = f"[{style}]{action}[/{style}]"
        if r.get("error"):
            row_action += f"  [red]{str(r['error'])[:80]}[/red]"
        elif r.get("warning"):
            row_action += f"  [yellow]{str(r['warning'])[:80]}[/yellow]"
        table.add_row(
            str(r.get("id")),
            str(r.get("topic")),
            str(r.get("uuid") or "—"),
            row_action,
        )
    console.print(table)

    created = sum(1 for r in results if r.get("action") == "created")
    updated = sum(1 for r in results if r.get("action") == "updated")
    failed = sum(1 for r in results if r.get("action") == "failed")
    if dry_run:
        console.print(f"[dim]{len(results)} guide(s) planned (dry run — nothing written).[/dim]")
    else:
        console.print(
            f"[green]✓[/green] created {created} · updated {updated} · "
            f"[red]failed {failed}[/red]"
        )


def _correctness_mark(c: str) -> str:
    return {
        "correct": "[green]✓[/green]",
        "incorrect": "[red]✗[/red]",
        "error": "[red]![/red]",
        "hit_limit": "[yellow]⌛[/yellow]",
    }.get(c, "?")


@cli.command()
@click.option(
    "--benchmark",
    type=click.Choice(["dabstep", AGENTIC_COMPANY_BENCHMARK]),
    default="dabstep",
    show_default=True,
)
@click.option("--split", type=click.Choice(["templates", "test", "all"]), default=None,
              help="DABstep: templates/test/all. Agentic Company: all (default).")
@click.option("--model", default="gemini", help="OpenRouter model id or alias: gemini, opus, sonnet, haiku, gpt")
@click.option("--database", default=None, help="MotherDuck database to query (read-only).")
@click.option(
    "--questions-jsonl",
    type=click.Path(path_type=Path),
    default=None,
    help="Path to the pinned Agentic Company questions.jsonl artifact.",
)
@click.option(
    "--manual",
    type=click.Path(path_type=Path),
    default=None,
    help="Path to the pinned Agentic Company manual.md artifact.",
)
@click.option(
    "--limit",
    type=click.IntRange(min=1),
    default=None,
    help="Cap number of selected questions (must be at least 1).",
)
@click.option("--task-id", "task_id", type=str, default=None, help="Run only this task_id.")
@click.option("--task-ids", "task_ids", type=str, default=None,
              help="Comma-separated task_ids to run as one batch (overrides --split).")
@click.option("--max-turns", type=int, default=40)
@click.option("--reasoning", type=click.Choice(["low", "medium", "high", "max", "off"]), default="low",
              help="Thinking budget. Default 'low' — the cost/accuracy sweet spot for this skill.")
@click.option("--watch", is_flag=True, default=False, help="Stream tool calls live.")
@click.option("--concurrency", type=int, default=15, help="Questions to run in parallel.")
@click.option("--luna-max", "luna_max", is_flag=True, default=False,
              help="Shortcut: openai/gpt-5.6-luna at reasoning=max (418/419 test @ $1.86, "
                   "~1/5 the gemini cost). Overrides --model and --reasoning.")
@click.option("--no-guides", "no_guides", is_flag=True, default=False,
              help="Ablation baseline: list_guides/get_guide always answer 'No guides "
                   "exist.' — measures the agent without the semantic layer.")
@click.option("--out", type=click.Path(path_type=Path), default=None)
def evaluate(
    benchmark: str,
    split: str | None,
    model: str,
    database: str | None,
    questions_jsonl: Path | None,
    manual: Path | None,
    limit: int | None,
    task_id: str | None,
    task_ids: str | None,
    max_turns: int,
    reasoning: str,
    watch: bool,
    concurrency: int,
    luna_max: bool,
    no_guides: bool,
    out: Path | None,
) -> None:
    """Run the agent across the eval set and write per-question JSONL."""
    if luna_max:
        model, reasoning = "luna", "max"
    model = MODEL_ALIASES.get(model, model)
    is_agentic_company = benchmark == AGENTIC_COMPANY_BENCHMARK
    split = split or ("all" if is_agentic_company else "templates")
    if is_agentic_company and split != "all":
        raise click.ClickException("agentic-company supports only --split all.")
    if not is_agentic_company and (questions_jsonl is not None or manual is not None):
        raise click.ClickException(
            "--questions-jsonl and --manual are only valid with --benchmark agentic-company."
        )

    artifacts: dict = {}
    manifest: dict | None = None
    resolved_questions_path: Path | None = None
    if is_agentic_company:
        resolved_questions_path, resolved_manual_path, manifest_path = _resolve_agentic_paths(
            questions_jsonl=questions_jsonl,
            manual=manual,
        )
        for label, path in (
            ("questions", resolved_questions_path),
            ("manual", resolved_manual_path),
            ("manifest", manifest_path),
        ):
            if not path.is_file():
                raise click.ClickException(f"Agentic Company {label} not found: {path}")
        try:
            manifest = json.loads(manifest_path.read_text())
        except json.JSONDecodeError as exc:
            raise click.ClickException(
                f"Agentic Company manifest is not valid JSON: {manifest_path}: {exc}"
            ) from exc
        if not isinstance(manifest, dict):
            raise click.ClickException(
                f"Agentic Company manifest must be a JSON object: {manifest_path}"
            )
        database = (
            database
            or os.environ.get("AGENTIC_COMPANY_MD_DATABASE")
            or AGENTIC_COMPANY_DATABASE
        )
    else:
        database = database or _md_database()

    try:
        all_questions = _load_questions(
            "all" if (task_ids is not None or task_id is not None) else split,
            benchmark=benchmark,
            questions_path=resolved_questions_path,
        )
    except (TypeError, ValueError, OSError) as exc:
        raise click.ClickException(str(exc)) from exc
    if is_agentic_company:
        try:
            _validate_agentic_manifest(all_questions, manifest or {})
        except (TypeError, ValueError) as exc:
            raise click.ClickException(str(exc)) from exc
        questions_sha256 = _sha256(resolved_questions_path)
        manual_sha256 = _sha256(resolved_manual_path)
        if questions_sha256 != AGENTIC_COMPANY_QUESTIONS_SHA256:
            raise click.ClickException(
                "Agentic Company questions.jsonl does not match the pinned v0.3.0 artifact."
            )
        if manual_sha256 != AGENTIC_COMPANY_MANUAL_SHA256:
            raise click.ClickException(
                "Agentic Company manual.md does not match the pinned v0.3.0 artifact."
            )
        artifacts = {
            "version": manifest["version"],
            "snapshot_cutoff": manifest["snapshot_cutoff"],
            "questions_path": str(resolved_questions_path.resolve()),
            "questions_sha256": questions_sha256,
            "manual_path": str(resolved_manual_path.resolve()),
            "manual_sha256": manual_sha256,
            "database_sha256": manifest["source_database"]["sha256"],
            "share": AGENTIC_COMPANY_SHARE,
        }

    task_key = (
        (lambda value: str(value).casefold())
        if is_agentic_company
        else (lambda value: str(value))
    )
    if task_ids is not None:
        wanted = [t.strip() for t in task_ids.split(",") if t.strip()]
        if not wanted:
            raise click.ClickException("--task-ids must contain at least one task ID.")
        if len(wanted) != len({task_key(task) for task in wanted}):
            raise click.ClickException("--task-ids must not contain duplicate task IDs.")
        by_id = {task_key(q["task_id"]): q for q in all_questions}
        missing = [task for task in wanted if task_key(task) not in by_id]
        if missing:
            raise click.ClickException(f"task_ids not found in the selected question set: {missing}")
        questions = [by_id[task_key(task)] for task in wanted]
    elif task_id is not None:
        questions = [
            question
            for question in all_questions
            if task_key(question["task_id"]) == task_key(task_id)
        ]
        if not questions:
            raise click.ClickException(
                f"task_id {task_id!r} not found in the selected question set"
            )
    else:
        questions = all_questions
    if limit is not None:
        questions = questions[:limit]
    if not questions:
        raise click.ClickException("No questions were selected for evaluation.")

    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    default_name = (
        f"agentic-company_{split}_{ts}.jsonl"
        if is_agentic_company
        else f"{split}_{ts}.jsonl"
    )
    out = out or RESULTS_DIR / default_name
    out.parent.mkdir(parents=True, exist_ok=True)

    if concurrency < 1:
        raise click.ClickException("--concurrency must be >= 1")

    console.rule(
        f"[bold]{split}[/bold] · {len(questions)} questions · {model} · "
        f"reasoning={reasoning} · db={database} · concurrency={concurrency}"
        + (" · [bold red]NO GUIDES[/bold red]" if no_guides else "")
    )

    asyncio.run(_evaluate_loop(
        benchmark=benchmark, split=split, database=database, model=model, questions=questions,
        max_turns=max_turns, reasoning=reasoning, watch=watch,
        concurrency=concurrency, no_guides=no_guides, out=out,
        skill_path=AGENTIC_COMPANY_SKILL_PATH if is_agentic_company else SKILL_PATH,
        guide_topic=AGENTIC_COMPANY_GUIDE_TOPIC if is_agentic_company else None,
        attach_share=AGENTIC_COMPANY_SHARE if is_agentic_company else None,
        excluded_schemas=AGENTIC_COMPANY_EXCLUDED_SCHEMAS if is_agentic_company else (),
        artifacts=artifacts,
        project_id=("agentic-company-dabstep" if is_agentic_company else PROJECT_ID),
    ))


def _describe_exception(e: BaseException) -> str:
    """Render an exception for the jsonl `error` field. An ExceptionGroup's
    str() hides the sub-exceptions (the MCP SDK surfaces transport failures
    through an anyio TaskGroup) — flatten them so the actual cause is recorded."""
    desc = f"{type(e).__name__}: {e}"
    if isinstance(e, BaseExceptionGroup):
        leaves: list[BaseException] = []
        stack: list[BaseException] = [e]
        while stack:
            cur = stack.pop()
            if isinstance(cur, BaseExceptionGroup):
                stack.extend(cur.exceptions)
            else:
                leaves.append(cur)
        desc += " [" + "; ".join(f"{type(s).__name__}: {s}" for s in leaves) + "]"
    return desc


def _tid_prefix(task_id: str | None) -> str:
    return f"[dim][{task_id}][/dim] " if task_id else ""


def _score_question(
    *,
    benchmark: str,
    execution_result,
    question: dict,
    predicted_sql: str | None,
    hit_limit: bool = False,
):
    if benchmark == AGENTIC_COMPANY_BENCHMARK:
        return score_agentic_company(
            execution_result=execution_result,
            gold_answer=question.get("answer", ""),
            criteria=question.get("answer_criteria") or {},
            predicted_sql=predicted_sql,
            hit_limit=hit_limit,
        )
    return score_dabstep(
        execution_result=execution_result,
        gold_answer=question.get("answer", ""),
        guidelines=question.get("guidelines"),
        predicted_sql=predicted_sql,
        hit_limit=hit_limit,
    )


def _agentic_result_metadata(question: dict, artifacts: dict | None) -> dict:
    return {
        "benchmark": AGENTIC_COMPANY_BENCHMARK,
        "question_index": question.get("question_index"),
        "topic_id": question.get("topic_id"),
        "topic": question.get("topic"),
        "answer_criteria": question.get("answer_criteria"),
        "snapshot_cutoff": question.get("snapshot_cutoff"),
        "source_tables": question.get("source_tables"),
        "questions_sha256": (artifacts or {}).get("questions_sha256"),
        "manual_sha256": (artifacts or {}).get("manual_sha256"),
        "database_sha256": (artifacts or {}).get("database_sha256"),
    }


def _render_thinking(text: str, task_id: str | None = None) -> None:
    text = (text or "").strip()
    if not text:
        return
    label = Text.from_markup(_tid_prefix(task_id)) + Text("💭 thinking", style="italic blue dim")
    console.print(Padding(label, (0, 0, 0, 6)))
    console.print(Padding(Text(text, style="italic dim"), (0, 0, 0, 8)))


def _render_tool_call(call: dict, task_id: str | None = None) -> None:
    tool = call.get("tool", "?")
    err = call.get("error")
    turn = call.get("turn")
    max_turns = call.get("max_turns")
    turn_tag = ""
    if turn is not None and max_turns is not None:
        remaining = max_turns - turn
        style = "yellow" if remaining <= 5 else "dim"
        turn_tag = f"[{style}][turn {turn}/{max_turns}][/]  "

    def header(extra: Text | str = "") -> Text:
        t = Text.from_markup(_tid_prefix(task_id) + turn_tag)
        t.append("→ ", style="magenta")
        t.append(tool, style="bold magenta")
        if isinstance(extra, str):
            t.append(extra, style="dim")
        else:
            t.append(" ")
            t.append(extra)
        return t

    if tool == "list_guides":
        topic = call.get("topic")
        tail = Text("(")
        tail.append(str(topic) if topic else "catalog", style="cyan")
        if err:
            tail.append(") ", style="default")
            tail.append("ERR ", style="bold red")
            tail.append(err[:200], style="red")
        else:
            tail.append(f")  ({call.get('result_chars', 0)} chars)", style="dim")
        console.print(Padding(header(tail), (0, 0, 0, 6)))
        return

    if tool == "get_guide":
        tail = Text("(")
        tail.append(str(call.get("uuid") or ""), style="cyan")
        if err:
            tail.append(") ", style="default")
            tail.append("ERR ", style="bold red")
            tail.append(err[:200], style="red")
        else:
            tail.append(f")  ({call.get('result_chars', 0)} chars)", style="dim")
        console.print(Padding(header(tail), (0, 0, 0, 6)))
        return

    if tool == "search_catalog":
        tail = Text("(")
        tail.append(str(call.get("query") or ""), style="cyan")
        if err:
            tail.append(") ", style="default")
            tail.append("ERR ", style="bold red")
            tail.append(err[:200], style="red")
        else:
            tail.append(f")  ({call.get('result_rows', 0)} matches)", style="dim")
        console.print(Padding(header(tail), (0, 0, 0, 6)))
        return

    if tool == "list_tables":
        console.print(Padding(header(f"  ({call.get('result_rows', 0)} tables)"), (0, 0, 0, 6)))
        return

    if tool == "list_columns":
        tail = Text("(")
        tail.append(str(call.get("table") or ""), style="cyan")
        if err:
            tail.append(") ", style="default")
            tail.append("ERR ", style="bold red")
            tail.append(err[:200], style="red")
        else:
            tail.append(f")  ({call.get('cols')} cols)", style="dim")
        console.print(Padding(header(tail), (0, 0, 0, 6)))
        return

    if tool in ("query", "submit_answer"):
        sql = (call.get("sql") or "").strip()
        if err:
            line = header(Text("ERR ", style="bold red") + Text(err[:200], style="red"))
        else:
            line = header(f"  ({call.get('rows')} rows)")
        console.print(Padding(line, (0, 0, 0, 6)))
        if sql:
            console.print(Padding(Text(sql, style="bold" if tool == "submit_answer" else "default"), (0, 0, 0, 8)))
        return

    console.print(Padding(Text(f"→ {tool} (unknown)"), (0, 0, 0, 6)))


async def _preflight_agentic_company(
    *,
    database: str,
    attach_share: str,
    excluded_schemas: tuple[str, ...],
    artifacts: dict,
    verify_guide: bool,
) -> None:
    """Fail before model spend if the pinned share or single guide is wrong."""
    async with create_mcp_session(
        session_hint="agentic-company-preflight",
        database=database,
        attach_share=attach_share,
        excluded_schemas=excluded_schemas,
        guide_topic=AGENTIC_COMPANY_GUIDE_TOPIC,
    ) as mcp:
        cutoff = await mcp.call_tool(
            "query",
            {"sql": "SELECT max(sim_date)::VARCHAR FROM finance.pnl_daily"},
        )
        expected_cutoff = artifacts.get("snapshot_cutoff")
        if cutoff.is_error or cutoff.rows != [[expected_cutoff]]:
            raise click.ClickException(
                "Agentic Company share preflight failed: expected finance.pnl_daily "
                f"through {expected_cutoff}, received {cutoff.text}"
            )
        if not verify_guide:
            return
        listing = await mcp.call_tool(
            "list_guides",
            {"topic": AGENTIC_COMPANY_GUIDE_TOPIC},
        )
        try:
            guide_uuid = guides_load.select_agentic_manual(
                guides_load._guide_listing_payload(listing)
            )
        except (RuntimeError, TypeError) as exc:
            raise click.ClickException(
                f"Agentic Company manual guide preflight failed: {exc}"
            ) from exc
        if guide_uuid is None:
            raise click.ClickException(
                "Expected exactly one guide under agentic-company/manual; run "
                "`asm guides-load --benchmark agentic-company` before evaluation."
            )
        guide = await mcp.call_tool("get_guide", {"uuid": guide_uuid})
        try:
            remote_text = json.loads(guide.text).get("text", "")
            local_text = Path(artifacts["manual_path"]).read_text().rstrip()
        except (KeyError, OSError, AttributeError, json.JSONDecodeError) as exc:
            raise click.ClickException("Could not verify the Agentic Company manual guide.") from exc
        marker = f"\n\n{guides_load.AGENTIC_COMPANY_MANUAL_DESCRIPTION}\n\n"
        remote_body = remote_text.split(marker, 1)[1] if marker in remote_text else None
        if guide.is_error or remote_body != local_text:
            raise click.ClickException(
                "The published Agentic Company manual does not match the selected manual.md. "
                "Run `asm guides-load --benchmark agentic-company` to update it."
            )


async def _evaluate_loop(
    *, benchmark: str, split: str, database: str, model: str, questions: list[dict],
    max_turns: int, reasoning: str, watch: bool, concurrency: int,
    no_guides: bool = False, out: Path, skill_path: Path = SKILL_PATH,
    guide_topic: str | None = None, attach_share: str | None = None,
    excluded_schemas: tuple[str, ...] = (), artifacts: dict | None = None,
    project_id: str = PROJECT_ID,
) -> None:
    correct = 0
    by_cat: dict[str, int] = {}
    total_cost = 0.0
    total_elapsed = 0.0
    total_turns = 0
    n_hit_limit = 0
    completed = 0

    width = len(str(len(questions)))
    sem = asyncio.Semaphore(concurrency)
    write_lock = asyncio.Lock()
    # OpenRouter's documented "disable reasoning" is effort="none"; omitting the
    # reasoning param would instead fall back to the model's endpoint default.
    provider = OpenRouterProvider(reasoning_effort="none" if reasoning == "off" else reasoning)
    skill_text = skill_path.read_text() if skill_path.exists() else None
    md_token = os.environ.get("MOTHERDUCK_TOKEN")
    if not md_token:
        raise click.ClickException("MOTHERDUCK_TOKEN is not set.")
    if benchmark == AGENTIC_COMPANY_BENCHMARK:
        if attach_share is None:
            raise click.ClickException("Agentic Company profile requires its configured share.")
        await _preflight_agentic_company(
            database=database,
            attach_share=attach_share,
            excluded_schemas=excluded_schemas,
            artifacts=artifacts or {},
            verify_guide=not no_guides,
        )
    f = out.open("w")
    wall_t0 = time.time()

    run_id = controllog.new_id()
    run_provenance = _build_run_provenance(
        benchmark=benchmark,
        split=split,
        database=database,
        model=model,
        reasoning=reasoning,
        max_turns=max_turns,
        concurrency=concurrency,
        out=out,
        question_count=len(questions),
        artifacts=artifacts,
    )
    run_provenance["resolved_config"]["no_guides"] = no_guides
    controllog.init(
        project_id=project_id,
        log_dir=RESULTS_DIR,
        default_dims={
            "benchmark": benchmark, "split": split, "model": model, "database": database,
            "run_id": run_id, "run_label": out.stem,
        },
    )
    run_provenance = dict(controllog.run_metadata(run_id=run_id, **run_provenance)["payload_json"])

    async def run_one(q: dict) -> None:
        nonlocal correct, total_cost, total_elapsed, total_turns, n_hit_limit, completed
        tid = str(q["task_id"])
        async with sem:
            if watch:
                console.print()
                console.print(f"  {_tid_prefix(tid)}[bold]{tid}[/bold] [dim]· level={q.get('level','?')}[/dim]")
                q_text = Text(); q_text.append("Q: ", style="bold"); q_text.append(q["question"])
                console.print(Padding(q_text, (0, 0, 0, 4)))
                if q.get("guidelines"):
                    g_text = Text(); g_text.append("guidelines: ", style="dim"); g_text.append(q["guidelines"], style="dim")
                    console.print(Padding(g_text, (0, 0, 0, 4)))
                gold_text = Text(); gold_text.append("gold: ", style="dim"); gold_text.append(str(q.get("answer")), style="green")
                console.print(Padding(gold_text, (0, 0, 0, 4)))

            controllog.state_move(
                task_id=tid, from_="NEW", to="WIP", agent_id=AGENT_ID, run_id=run_id,
                idempotency_key=f"{run_id}:{tid}:NEW:WIP",
            )

            # One MCP session per task: all data + schema + guide access goes
            # server-side against md:<db> through this read-only session.
            # MCP transport flakes come in bursts under concurrency (observed
            # 18/419 on one run, all fine on retry) — one retry keeps a
            # transient outage from being scored as incorrect answers.
            t0 = time.time()
            run, err = None, None
            for attempt in range(2):
                try:
                    async with create_mcp_session(
                        session_hint=tid, database=database, no_guides=no_guides,
                        attach_share=attach_share,
                        excluded_schemas=excluded_schemas,
                        guide_topic=guide_topic,
                    ) as mcp:
                        run = await run_agent(
                            mcp=mcp, database=database,
                            question=q["question"], guidelines=q.get("guidelines"),
                            model=model, provider=provider, skill_text=skill_text,
                            prompt_profile=benchmark,
                            guide_topic=guide_topic,
                            max_turns=max_turns,
                            on_tool_call=(lambda call, _tid=tid: _render_tool_call(call, _tid)) if watch else None,
                            on_thinking=(lambda text, _tid=tid: _render_thinking(text, _tid)) if watch else None,
                        )
                    err = None
                    break
                except Exception as e:
                    run = None
                    err = _describe_exception(e)
                    if attempt == 0:
                        console.print(
                            f"  {_tid_prefix(tid)}[yellow]run failed, retrying:[/yellow] "
                            f"[dim]{err[:160]}[/dim]"
                        )
                        await asyncio.sleep(3)

            elapsed = time.time() - t0

            if run is None:
                execution_result = ExecutionError("RunFailure", err or "")
                result = _score_question(
                    benchmark=benchmark,
                    execution_result=execution_result,
                    question=q,
                    predicted_sql=None,
                )
            else:
                exec_result = run.final_rows if run.final_rows is not None else ExecutionError(
                    "NoSubmission", "agent did not submit"
                )
                result = _score_question(
                    benchmark=benchmark,
                    execution_result=exec_result,
                    question=q,
                    predicted_sql=run.final_sql,
                    hit_limit=run.hit_limit,
                )

            cost = run.cost_usd if run else 0.0
            n_turns = len(run.tool_calls) if run else 0

            row = {
                "task_id": tid, "level": q.get("level"), "split": split, "model": model,
                "no_guides": no_guides,
                "question": q["question"], "guidelines": q.get("guidelines"),
                "gold_answer": q.get("answer"), "predicted_answer": result.predicted_answer,
                "predicted_sql": run.final_sql if run else None,
                "is_correct": result.is_correct, "correctness": result.correctness.value,
                "reason": result.reason, "match_source": result.match_source,
                "hit_limit": run.hit_limit if run else False,
                "tool_calls": run.tool_calls if run else [],
                "n_tool_calls": n_turns, "elapsed_s": round(elapsed, 2),
                "cost_usd": round(cost, 6),
                "prompt_tokens": run.prompt_tokens if run else 0,
                "completion_tokens": run.completion_tokens if run else 0,
                "cached_tokens": run.cached_tokens if run else 0,
                "error": err, "ts": datetime.now(timezone.utc).isoformat(),
            }
            if benchmark == AGENTIC_COMPANY_BENCHMARK:
                row.update(_agentic_result_metadata(q, artifacts))

            total_tokens = (run.prompt_tokens + run.completion_tokens) if run else 0
            wall_ms = int(elapsed * 1000)
            reward = 1.0 if result.is_correct else 0.0
            terminal_state = "DONE" if run is not None else "FAILED"
            postings = [
                controllog.post("resource.tokens", "provider:openrouter", "+tokens", -total_tokens, {"model": model}),
                controllog.post("resource.tokens", f"project:{project_id}", "+tokens", +total_tokens, {"model": model}),
                controllog.post("truth.time", f"agent:{AGENT_ID}", "ms", -wall_ms, {"kind": "wall"}),
                controllog.post("truth.time", f"project:{project_id}", "ms", +wall_ms, {"kind": "wall"}),
                controllog.post("truth.money", "vendor:openrouter", "$", -float(cost), {"model": model}),
                controllog.post("truth.money", f"project:{project_id}", "$", +float(cost), {"model": model}),
                controllog.post("truth.state", f"task:{tid}", "tasks", -1, {"from": "WIP"}),
                controllog.post("truth.state", f"task:{tid}", "tasks", +1, {"to": terminal_state}),
                controllog.post("truth.utility", f"task:{tid}", "points", +reward, {"metric": "reward"}),
                controllog.post("truth.utility", f"project:{project_id}", "points", -reward, {"metric": "reward"}),
            ]
            controllog.event(
                kind="task_complete",
                actor={"agent_id": AGENT_ID, "task_id": tid},
                run_id=run_id,
                payload={
                    "question_id": tid, "level": q.get("level"),
                    "correctness": result.correctness.value,
                    "hit_limit": run.hit_limit if run else False,
                    "n_tool_calls": n_turns,
                    "cached_tokens": run.cached_tokens if run else 0,
                    "error": err,
                },
                postings=postings,
                idempotency_key=f"{run_id}:task:{tid}",
            )

            # Rich per-question event for controllog-viz `review` (trace cards):
            # the conversation (run.messages, Responses-API items) is what the
            # viz renders as the chain-of-thought + tool-call explorer.
            tcs = run.tool_calls if run else []
            query_count = sum(1 for c in tcs if c.get("tool") == "query")
            sql_errors = sum(1 for c in tcs if c.get("error") and c.get("tool") in ("query", "submit_answer"))
            raw_response = None
            if run and run.messages is not None:
                # Force JSON-serializable so a stray object can't break the event.
                raw_response = {"messages": json.loads(json.dumps(run.messages, default=str))}
            controllog.event(
                kind="evaluation_result",
                actor={"agent_id": AGENT_ID, "task_id": tid},
                run_id=run_id,
                payload={
                    "question_id": tid,
                    "question_text": q["question"],
                    "evidence": q.get("guidelines"),
                    "db_id": database,
                    "database": database,
                    "model": model,
                    "config_type": "skill+context",
                    "level": q.get("level"),
                    "predicted_sql": run.final_sql if run else None,
                    "gold_sql": None,  # DABStep ships gold answers, not gold SQL
                    "gold_result": q.get("answer"),
                    "predicted_result": result.predicted_answer,
                    "is_correct": result.is_correct,
                    "correctness_level": result.correctness.value,
                    "match_source": result.match_source,
                    "partial_reason": result.reason,
                    "hit_iteration_limit": run.hit_limit if run else False,
                    "tool_calls": n_turns,
                    "sql_errors": sql_errors,
                    "query_count": query_count,
                    "duration_ms": wall_ms,
                    "cost_usd": float(cost),
                    "input_tokens": run.prompt_tokens if run else 0,
                    "output_tokens": run.completion_tokens if run else 0,
                    "run": {"config_hash": run_provenance.get("config_hash")},
                    "raw_response": raw_response,
                    "answer_source": q.get("answer_source"),
                    "error_description": err,
                },
                idempotency_key=f"{run_id}:eval:{tid}",
            )

            async with write_lock:
                if result.is_correct:
                    correct += 1
                by_cat[result.correctness.value] = by_cat.get(result.correctness.value, 0) + 1
                total_cost += cost
                total_elapsed += elapsed
                total_turns += n_turns
                if run and run.hit_limit:
                    n_hit_limit += 1
                completed += 1
                done = completed
                running_pct = correct / done * 100

                f.write(json.dumps(row) + "\n")
                f.flush()

                if watch:
                    pred_line = Text.from_markup(_tid_prefix(tid))
                    pred_line.append("pred: ", style="dim")
                    pred_line.append(str(result.predicted_answer))
                    pred_line.append("  ")
                    pred_line.append_text(Text.from_markup(_correctness_mark(result.correctness.value)))
                    pred_line.append(
                        f"  ({result.correctness.value}, {n_turns}/{max_turns} turns, {elapsed:.1f}s, ${cost:.4f})",
                        style="dim",
                    )
                    console.print(Padding(pred_line, (0, 0, 0, 4)))
                    if not result.is_correct:
                        gold_line = Text.from_markup(_tid_prefix(tid))
                        gold_line.append("gold: ", style="dim")
                        gold_line.append(str(q.get("answer")), style="green")
                        gold_line.append("  (mismatch)", style="red")
                        console.print(Padding(gold_line, (0, 0, 0, 4)))
                else:
                    # One line per question: "[X/Y] correct|incorrect: <answer>".
                    # Built as Text so answers with [..]/quotes don't break markup.
                    label = result.correctness.value  # correct|incorrect|error|hit_limit
                    color = {"correct": "green", "incorrect": "red",
                             "error": "red", "hit_limit": "yellow"}.get(label, "white")
                    ans = str(result.predicted_answer)
                    if len(ans) > 25:
                        ans = ans[:24] + "…"
                    line = Text(f"  [{done:>{width}}/{len(questions)}] ")
                    line.append(label, style=color)
                    line.append(": ")
                    line.append(ans)
                    console.print(line)

    try:
        await asyncio.gather(*(run_one(q) for q in questions))
    finally:
        f.close()
        await provider.aclose()
    wall_elapsed = time.time() - wall_t0

    pct = (correct / len(questions) * 100) if questions else 0.0
    summary_table = Table(show_header=False, box=None, padding=(0, 2))
    summary_table.add_column(style="dim")
    summary_table.add_column()
    summary_table.add_row("split", f"[bold]{split}[/bold] · {model}")
    summary_table.add_row("accuracy", f"[bold]{correct}/{len(questions)} = {pct:.1f}%[/bold]")
    summary_table.add_row(
        "breakdown",
        " · ".join(f"{_correctness_mark(k)} {k}: {v}" for k, v in sorted(by_cat.items())),
    )
    summary_table.add_row("cost", f"${total_cost:.4f}")
    summary_table.add_row(
        "time",
        f"wall {wall_elapsed:.1f}s · sum {total_elapsed:.1f}s "
        f"({total_elapsed/max(len(questions),1):.1f}s/q · "
        f"speedup {total_elapsed/max(wall_elapsed,0.001):.1f}×)",
    )
    summary_table.add_row(
        "turns",
        f"avg {total_turns/max(len(questions),1):.1f}/{max_turns}  (hit_limit: {n_hit_limit}/{len(questions)})",
    )
    summary_table.add_row("results", str(out))
    console.print()
    console.print(summary_table)
    console.print()


@cli.command()
@click.argument("jsonl_path", type=click.Path(exists=True, path_type=Path))
def summary(jsonl_path: Path) -> None:
    """Print a correctness breakdown for one results file."""
    rows = [json.loads(line) for line in jsonl_path.read_text().splitlines() if line.strip()]
    if not rows:
        console.print(f"[yellow]empty results file: {jsonl_path}[/yellow]")
        return

    total = len(rows)
    correct = sum(1 for r in rows if r["is_correct"])
    by_cat: dict[str, int] = {}
    by_level: dict[str, tuple[int, int]] = {}
    for r in rows:
        by_cat[r["correctness"]] = by_cat.get(r["correctness"], 0) + 1
        lvl = r.get("level") or "?"
        c, t = by_level.get(lvl, (0, 0))
        by_level[lvl] = (c + (1 if r["is_correct"] else 0), t + 1)

    total_cost = sum(r.get("cost_usd", 0.0) or 0.0 for r in rows)
    total_time = sum(r.get("elapsed_s", 0.0) or 0.0 for r in rows)
    total_turns = sum(r.get("n_tool_calls", 0) or 0 for r in rows)
    n_hit_limit = sum(1 for r in rows if r.get("hit_limit"))
    pct = (correct / total * 100) if total else 0.0

    header = Table(show_header=False, box=None, padding=(0, 2))
    header.add_column(style="dim")
    header.add_column()
    header.add_row("file", str(jsonl_path))
    header.add_row("split", f"{rows[0].get('split','?')} · {rows[0].get('model','?')}")
    header.add_row("accuracy", f"[bold]{correct}/{total} = {pct:.1f}%[/bold]")
    header.add_row("cost", f"${total_cost:.4f}")
    header.add_row("time", f"{total_time:.1f}s")
    header.add_row("turns", f"avg {total_turns/total:.1f}  (hit_limit: {n_hit_limit}/{total})")
    console.print(header)

    cat_table = Table(title="By correctness", show_header=True)
    cat_table.add_column("category")
    cat_table.add_column("n", justify="right")
    for cat in sorted(by_cat):
        cat_table.add_row(f"{_correctness_mark(cat)} {cat}", str(by_cat[cat]))
    console.print(cat_table)

    # The misses — most useful for iterating toward 100%.
    misses = [r for r in rows if not r["is_correct"]]
    if misses:
        miss_table = Table(title="Misses", show_header=True)
        miss_table.add_column("task_id")
        miss_table.add_column("predicted")
        miss_table.add_column("gold", style="green")
        miss_table.add_column("reason", style="dim")
        for r in misses:
            miss_table.add_row(
                str(r["task_id"]),
                str(r.get("predicted_answer"))[:40],
                str(r.get("gold_answer"))[:40],
                str(r.get("reason") or r.get("correctness")),
            )
        console.print(miss_table)


if __name__ == "__main__":
    cli()
