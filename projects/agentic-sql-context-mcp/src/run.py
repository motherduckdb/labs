"""CLI for the shared DABstep and Agentic Company evaluation harness.

DABstep remains the default profile. Agentic Company supplies an external
question set, a single manual guide, a shared multi-schema snapshot, an
isolated prompt/skill, and criteria-driven scoring while reusing the same agent
loop, MCP tools, concurrency, retries, logging, results, and summary behavior.
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path

import click
import controllog
from dotenv import load_dotenv
from rich.console import Console
from rich.padding import Padding
from rich.table import Table
from rich.text import Text

from src import guides_load
from src.agent import LMSTUDIO_CONCURRENCY, LMSTUDIO_MODEL, LLMProvider, run_agent
from src.agentic_company_profile import (
    AGENTIC_COMPANY_PROFILE,
    AgenticCompanyArtifacts,
    AgenticCompanyProfile,
)
from src.load import DEFAULT_DATABASE, build_db
from src.mcp_client import create_mcp_session
from src.score import ExecutionError
from src.score import score as score_dabstep

REPO_ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = REPO_ROOT / "data"
RESULTS_DIR = REPO_ROOT / "results"
SKILL_PATH = REPO_ROOT / "skill" / "SKILL.md"
TASKS_PATH = DATA_DIR / "dabstep" / "tasks" / "all.jsonl"
SPLIT_PATH = DATA_DIR / "split.json"

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
    # Local LM Studio model id (only reachable with --local).
    "qwen": LMSTUDIO_MODEL,
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
    if benchmark == AGENTIC_COMPANY_PROFILE.name:
        path = questions_path or AGENTIC_COMPANY_PROFILE.resolve_paths()[0]
        return AGENTIC_COMPANY_PROFILE.load_questions(path, split=split)
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
    type=click.Choice(["dabstep", AGENTIC_COMPANY_PROFILE.name]),
    default="dabstep",
    show_default=True,
    help="Guide bundle to publish.",
)
@click.option("--dry-run", is_flag=True, default=False,
              help="Preview the planned guide topics without making any MCP calls.")
@click.option("--prefix", default=None,
              help="Override the DABstep topic prefix (Agentic Company is fixed).")
@click.option("--lockfile", type=click.Path(path_type=Path), default=None,
              help="DABstep: use this uuid lockfile instead of the committed "
                   "guides.lock.json. Guide uuids are per-principal — a second "
                   "MotherDuck account cannot update guides it does not own — so "
                   "publish under your own lockfile (e.g. guides.lock.<you>.json, "
                   "gitignored) to leave the committed one intact.")
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
    lockfile: Path | None,
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
        if benchmark == AGENTIC_COMPANY_PROFILE.name:
            questions_path, manual_path, manifest_path = AGENTIC_COMPANY_PROFILE.resolve_paths(
                manual=manual
            )
            AGENTIC_COMPANY_PROFILE.load_bundle(
                questions_path,
                manual_path,
                manifest_path,
            )
            if lockfile is not None:
                raise click.ClickException(
                    "--lockfile is only valid for dabstep; agentic-company keeps no local lock."
                )
            results = guides_load.publish_manual_sync(
                manual_path=manual_path,
                prefix=prefix,
                dry_run=dry_run,
            )
        else:
            if manual is not None:
                raise click.ClickException("--manual is only valid for agentic-company.")
            results = guides_load.publish_all_sync(
                prefix=prefix, dry_run=dry_run, lockfile_path=lockfile,
            )
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
    type=click.Choice(["dabstep", AGENTIC_COMPANY_PROFILE.name]),
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
@click.option("--local", "local", is_flag=True, default=False,
              help="Run against the local LM Studio server instead of OpenRouter "
                   f"({LMSTUDIO_MODEL} at http://localhost:1234/v1, concurrency "
                   f"{LMSTUDIO_CONCURRENCY}, no reasoning/usage extensions).")
@click.option("--luna-max", "luna_max", is_flag=True, default=False,
              help="Shortcut: openai/gpt-5.6-luna at reasoning=max (418/419 test @ $1.86, "
                   "~1/5 the gemini cost). Overrides --model and --reasoning.")
@click.option("--no-guides", "no_guides", is_flag=True, default=False,
              help="Ablation baseline: list_guides/get_guide always answer 'No guides "
                   "exist.' — measures the agent without the semantic layer.")
@click.option("--out", type=click.Path(path_type=Path), default=None)
@click.pass_context
def evaluate(
    ctx: click.Context,
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
    local: bool,
    luna_max: bool,
    no_guides: bool,
    out: Path | None,
) -> None:
    """Run the agent across the eval set and write per-question JSONL."""
    if luna_max and local:
        raise click.ClickException("--luna-max routes through OpenRouter; it cannot combine with --local.")
    if luna_max:
        model, reasoning = "luna", "max"
    if local:
        # Defaults the local server needs, applied only where the caller did
        # not ask for something specific.
        source = ctx.get_parameter_source
        if source("model") is click.core.ParameterSource.DEFAULT:
            model = LMSTUDIO_MODEL
        if source("concurrency") is click.core.ParameterSource.DEFAULT:
            concurrency = LMSTUDIO_CONCURRENCY
    model = MODEL_ALIASES.get(model, model)
    profile = AGENTIC_COMPANY_PROFILE if benchmark == AGENTIC_COMPANY_PROFILE.name else None
    split = split or (profile.default_split if profile else "templates")
    if profile and split != profile.default_split:
        raise click.ClickException(
            f"{profile.name} supports only --split {profile.default_split}."
        )
    if profile is None and (questions_jsonl is not None or manual is not None):
        raise click.ClickException(
            "--questions-jsonl and --manual are only valid with --benchmark agentic-company."
        )

    artifacts: AgenticCompanyArtifacts | None = None
    if profile:
        resolved_questions_path, resolved_manual_path, manifest_path = profile.resolve_paths(
            questions_jsonl=questions_jsonl,
            manual=manual,
        )
        try:
            all_questions, artifacts = profile.load_bundle(
                resolved_questions_path,
                resolved_manual_path,
                manifest_path,
            )
        except (TypeError, ValueError, OSError) as exc:
            raise click.ClickException(str(exc)) from exc
        database = profile.database_name(database)
    else:
        database = database or _md_database()
        try:
            all_questions = _load_questions(
                "all" if (task_ids is not None or task_id is not None) else split,
                benchmark=benchmark,
            )
        except (TypeError, ValueError, OSError) as exc:
            raise click.ClickException(str(exc)) from exc

    task_key = profile.task_key if profile else (lambda value: str(value))
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
        f"{profile.name}_{split}_{ts}.jsonl"
        if profile
        else f"{split}_{ts}.jsonl"
    )
    out = out or RESULTS_DIR / default_name
    out.parent.mkdir(parents=True, exist_ok=True)

    if concurrency < 1:
        raise click.ClickException("--concurrency must be >= 1")

    console.rule(
        f"[bold]{split}[/bold] · {len(questions)} questions · {model} · "
        f"reasoning={reasoning} · db={database} · concurrency={concurrency}"
        + (" · [bold cyan]LOCAL (LM Studio)[/bold cyan]" if local else "")
        + (" · [bold red]NO GUIDES[/bold red]" if no_guides else "")
    )

    asyncio.run(
        _evaluate_loop(
            benchmark=benchmark,
            split=split,
            database=database,
            model=model,
            questions=questions,
            max_turns=max_turns,
            reasoning=reasoning,
            watch=watch,
            concurrency=concurrency,
            local=local,
            no_guides=no_guides,
            out=out,
            profile=profile,
            artifacts=artifacts,
        )
    )


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


async def _evaluate_loop(
    *, benchmark: str, split: str, database: str, model: str, questions: list[dict],
    max_turns: int, reasoning: str, watch: bool, concurrency: int,
    local: bool = False, no_guides: bool = False, out: Path,
    profile: AgenticCompanyProfile | None = None,
    artifacts: AgenticCompanyArtifacts | None = None,
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
    # In local mode the provider drops the reasoning field entirely.
    provider = LLMProvider(
        reasoning_effort="none" if reasoning == "off" else reasoning,
        local=local,
    )
    vendor = "lmstudio-local" if local else "openrouter"
    skill_path = profile.skill_path if profile else SKILL_PATH
    skill_text = skill_path.read_text() if skill_path.exists() else None
    guide_topic = profile.guide_topic if profile else None
    attach_share = profile.share if profile else None
    excluded_schemas = profile.excluded_schemas if profile else ()
    project_id = profile.project_id if profile else PROJECT_ID
    artifact_provenance = artifacts.provenance() if artifacts else None
    md_token = os.environ.get("MOTHERDUCK_TOKEN")
    if not md_token:
        raise click.ClickException("MOTHERDUCK_TOKEN is not set.")
    if profile:
        if artifacts is None:
            raise click.ClickException("Agentic Company profile requires validated artifacts.")
        try:
            await profile.preflight(
                database=database,
                artifacts=artifacts,
                verify_guide=not no_guides,
            )
        except (RuntimeError, TypeError, ValueError, OSError) as exc:
            raise click.ClickException(str(exc)) from exc

    def score_question(execution_result, question: dict, predicted_sql, hit_limit=False):
        if profile:
            return profile.score(
                execution_result=execution_result,
                question=question,
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
        artifacts=artifact_provenance,
    )
    run_provenance["resolved_config"]["no_guides"] = no_guides
    run_provenance["resolved_config"]["local"] = local
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
                result = score_question(
                    execution_result=execution_result,
                    question=q,
                    predicted_sql=None,
                )
            else:
                exec_result = run.final_rows if run.final_rows is not None else ExecutionError(
                    "NoSubmission", "agent did not submit"
                )
                result = score_question(
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
            if profile and artifacts:
                row.update(profile.result_metadata(q, artifacts))

            total_tokens = (run.prompt_tokens + run.completion_tokens) if run else 0
            wall_ms = int(elapsed * 1000)
            reward = 1.0 if result.is_correct else 0.0
            terminal_state = "DONE" if run is not None else "FAILED"
            postings = [
                controllog.post("resource.tokens", f"provider:{vendor}", "+tokens", -total_tokens, {"model": model}),
                controllog.post("resource.tokens", f"project:{project_id}", "+tokens", +total_tokens, {"model": model}),
                controllog.post("truth.time", f"agent:{AGENT_ID}", "ms", -wall_ms, {"kind": "wall"}),
                controllog.post("truth.time", f"project:{project_id}", "ms", +wall_ms, {"kind": "wall"}),
                controllog.post("truth.money", f"vendor:{vendor}", "$", -float(cost), {"model": model}),
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
