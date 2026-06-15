"""CLI: build the MotherDuck DB, run the agent over the 26 templates, summarize.

Single setup (one DB, one skill, one context store). The eval set is the 26
template-representative questions (`train_ids` in data/split.json); gold answers
come from data/dabstep/tasks/all.jsonl.
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
import duckdb
from dotenv import load_dotenv
from rich.console import Console
from rich.padding import Padding
from rich.table import Table
from rich.text import Text

from src.agent import OpenRouterProvider, run_agent
from src.context_store import ContextStore
from src.load import DEFAULT_DATABASE, build_db
from src.score import ExecutionError, score

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
    split: str,
    database: str,
    model: str,
    reasoning: str,
    max_turns: int,
    concurrency: int,
    out: Path,
    question_count: int,
) -> dict:
    commit_sha = _git_output("rev-parse", "HEAD")
    dirty_status = _git_output("status", "--porcelain")
    resolved_config = {
        "split": split,
        "database": database,
        "model": model,
        "reasoning": reasoning,
        "max_turns": max_turns,
        "concurrency": concurrency,
        "question_count": question_count,
        "run_label": out.stem,
    }
    return {
        "commit_sha": commit_sha,
        "repo": _git_output("config", "--get", "remote.origin.url"),
        "dirty": bool(dirty_status) if dirty_status is not None else None,
        "effort": reasoning,
        "resolved_config": resolved_config,
        "agent_name": AGENT_ID,
        "dataset_name": database,
        "dataset_version": split,
    }


def _md_database() -> str:
    return os.environ.get("MD_DATABASE", DEFAULT_DATABASE)


def _bad_golds() -> set[str]:
    """Task ids with provably-wrong hf_consensus golds, set aside (see bad_golds.json)."""
    p = DATA_DIR / "bad_golds.json"
    if not p.exists():
        return set()
    return {str(t) for t in json.loads(p.read_text()).get("task_ids", [])}


def _load_questions(split: str) -> list[dict]:
    """Load questions, excluding known-bad golds from the test/all sets.
    split='templates' -> the 26 train_ids (one per template; bad golds aren't among them);
    split='test'      -> the 419 held-out questions (all minus the 26 train minus 5 bad golds);
    split='all'       -> 445 (450 minus 5 bad golds).
    """
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
@click.option("--domains", default=None, help="Comma-separated domains to list items for.")
@click.option("--ids", default=None, help="Comma-separated context ids to print in full.")
def context_cmd(domains: str | None, ids: str | None) -> None:
    """Inspect the semantic-layer context store (mirrors the semantic_lookup tool)."""
    from src.context_store import render_semantic_lookup

    store = ContextStore()
    console.print(render_semantic_lookup(store, domains=domains, ids=ids))


def _correctness_mark(c: str) -> str:
    return {
        "correct": "[green]✓[/green]",
        "incorrect": "[red]✗[/red]",
        "error": "[red]![/red]",
        "hit_limit": "[yellow]⌛[/yellow]",
    }.get(c, "?")


@cli.command()
@click.option("--split", type=click.Choice(["templates", "test", "all"]), default="templates",
              help="'templates' = 26 reps (default); 'test' = 424 held-out; 'all' = full 450.")
@click.option("--model", default="gemini", help="OpenRouter model id or alias: gemini, opus, sonnet, haiku, gpt")
@click.option("--database", default=None, help="MotherDuck database to query (read-only).")
@click.option("--limit", type=int, default=None, help="Cap number of questions.")
@click.option("--task-id", "task_id", type=str, default=None, help="Run only this task_id.")
@click.option("--task-ids", "task_ids", type=str, default=None,
              help="Comma-separated task_ids to run as one batch (overrides --split).")
@click.option("--max-turns", type=int, default=40)
@click.option("--reasoning", type=click.Choice(["low", "medium", "high", "off"]), default="low",
              help="Thinking budget. Default 'low' — the cost/accuracy sweet spot for this skill.")
@click.option("--watch", is_flag=True, default=False, help="Stream tool calls live.")
@click.option("--concurrency", type=int, default=15, help="Questions to run in parallel.")
@click.option("--out", type=click.Path(path_type=Path), default=None)
def evaluate(
    split: str,
    model: str,
    database: str | None,
    limit: int | None,
    task_id: str | None,
    task_ids: str | None,
    max_turns: int,
    reasoning: str,
    watch: bool,
    concurrency: int,
    out: Path | None,
) -> None:
    """Run the agent across the eval set and write per-question JSONL."""
    model = MODEL_ALIASES.get(model, model)
    database = database or _md_database()

    if task_ids is not None:
        wanted = [t.strip() for t in task_ids.split(",") if t.strip()]
        by_id = {str(q["task_id"]): q for q in _load_questions("all")}
        missing = [t for t in wanted if t not in by_id]
        if missing:
            raise click.ClickException(f"task_ids not found in all.jsonl: {missing}")
        questions = [by_id[t] for t in wanted]
    elif task_id is not None:
        all_qs = _load_questions("all")
        questions = [q for q in all_qs if str(q["task_id"]) == task_id]
        if not questions:
            raise click.ClickException(f"task_id {task_id!r} not found in all.jsonl")
    else:
        questions = _load_questions(split)
        if limit:
            questions = questions[:limit]

    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out = out or RESULTS_DIR / f"{split}_{ts}.jsonl"
    out.parent.mkdir(parents=True, exist_ok=True)

    if concurrency < 1:
        raise click.ClickException("--concurrency must be >= 1")

    console.rule(
        f"[bold]{split}[/bold] · {len(questions)} questions · {model} · "
        f"reasoning={reasoning} · db={database} · concurrency={concurrency}"
    )

    asyncio.run(_evaluate_loop(
        split=split, database=database, model=model, questions=questions,
        max_turns=max_turns, reasoning=reasoning, watch=watch,
        concurrency=concurrency, out=out,
    ))


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

    if tool == "semantic_lookup":
        domains = call.get("domains")
        ids = call.get("ids")
        if ids:
            tail = f"  (ids: {', '.join(ids) if isinstance(ids, list) else ids})"
        elif domains:
            tail = f"  (domains: {', '.join(domains) if isinstance(domains, list) else domains})"
        else:
            tail = "  (list domains)"
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
    *, split: str, database: str, model: str, questions: list[dict],
    max_turns: int, reasoning: str, watch: bool, concurrency: int, out: Path,
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
    provider = OpenRouterProvider(reasoning_effort=None if reasoning == "off" else reasoning)
    store = ContextStore()
    skill_text = SKILL_PATH.read_text() if SKILL_PATH.exists() else None
    md_token = os.environ.get("MOTHERDUCK_TOKEN")
    if not md_token:
        raise click.ClickException("MOTHERDUCK_TOKEN is not set.")
    f = out.open("w")
    wall_t0 = time.time()

    run_id = controllog.new_id()
    run_provenance = _build_run_provenance(
        split=split,
        database=database,
        model=model,
        reasoning=reasoning,
        max_turns=max_turns,
        concurrency=concurrency,
        out=out,
        question_count=len(questions),
    )
    controllog.init(
        project_id=PROJECT_ID,
        log_dir=RESULTS_DIR,
        default_dims={
            "split": split, "model": model, "database": database,
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

            # MotherDuck-attached read-only connection, one per task.
            conn = duckdb.connect(f"md:{database}?motherduck_token={md_token}", read_only=True)
            t0 = time.time()
            try:
                try:
                    run = await run_agent(
                        conn=conn, store=store, database=database,
                        question=q["question"], guidelines=q.get("guidelines"),
                        model=model, provider=provider, skill_text=skill_text,
                        max_turns=max_turns,
                        on_tool_call=(lambda call, _tid=tid: _render_tool_call(call, _tid)) if watch else None,
                        on_thinking=(lambda text, _tid=tid: _render_thinking(text, _tid)) if watch else None,
                    )
                    err = None
                except Exception as e:
                    run = None
                    err = f"{type(e).__name__}: {e}"
            finally:
                conn.close()

            elapsed = time.time() - t0

            if run is None:
                result = score(
                    execution_result=ExecutionError("RunFailure", err or ""),
                    gold_answer=q.get("answer", ""), guidelines=q.get("guidelines"),
                    predicted_sql=None,
                )
            else:
                exec_result = run.final_rows if run.final_rows is not None else ExecutionError(
                    "NoSubmission", "agent did not submit"
                )
                result = score(
                    execution_result=exec_result, gold_answer=q.get("answer", ""),
                    guidelines=q.get("guidelines"), predicted_sql=run.final_sql,
                    hit_limit=run.hit_limit,
                )

            cost = run.cost_usd if run else 0.0
            n_turns = len(run.tool_calls) if run else 0

            row = {
                "task_id": tid, "level": q.get("level"), "split": split, "model": model,
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

            total_tokens = (run.prompt_tokens + run.completion_tokens) if run else 0
            wall_ms = int(elapsed * 1000)
            reward = 1.0 if result.is_correct else 0.0
            terminal_state = "DONE" if run is not None else "FAILED"
            postings = [
                controllog.post("resource.tokens", "provider:openrouter", "+tokens", -total_tokens, {"model": model}),
                controllog.post("resource.tokens", f"project:{PROJECT_ID}", "+tokens", +total_tokens, {"model": model}),
                controllog.post("truth.time", f"agent:{AGENT_ID}", "ms", -wall_ms, {"kind": "wall"}),
                controllog.post("truth.time", f"project:{PROJECT_ID}", "ms", +wall_ms, {"kind": "wall"}),
                controllog.post("truth.money", "vendor:openrouter", "$", -float(cost), {"model": model}),
                controllog.post("truth.money", f"project:{PROJECT_ID}", "$", +float(cost), {"model": model}),
                controllog.post("truth.state", f"task:{tid}", "tasks", -1, {"from": "WIP"}),
                controllog.post("truth.state", f"task:{tid}", "tasks", +1, {"to": terminal_state}),
                controllog.post("truth.utility", f"task:{tid}", "points", +reward, {"metric": "reward"}),
                controllog.post("truth.utility", f"project:{PROJECT_ID}", "points", -reward, {"metric": "reward"}),
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
