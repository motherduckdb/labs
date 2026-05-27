"""CLI: build databases, run an arm against a split, summarize results."""

from __future__ import annotations

import asyncio
import json
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
from src.load import build_db
from src.score import ExecutionError, score

REPO_ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = REPO_ROOT / "data"
RESULTS_DIR = REPO_ROOT / "results"
TASKS_PATH = DATA_DIR / "dabstep" / "tasks" / "all.jsonl"
SPLIT_PATH = DATA_DIR / "split.json"

console = Console()

MODEL_ALIASES = {
    "gemini": "google/gemini-3-flash-preview",
    "geminipro": "google/gemini-3.1-pro-preview",
    "gpt": "openai/gpt-5.5",
    "opus": "anthropic/claude-opus-4.7",
    "deepseek": "deepseek/deepseek-v4-flash",
}


def _load_questions(split: str) -> list[dict]:
    """Load questions for split={'train','test','all'}."""
    all_qs = [json.loads(line) for line in TASKS_PATH.read_text().splitlines() if line.strip()]
    if split == "all":
        return all_qs
    split_meta = json.loads(SPLIT_PATH.read_text())
    train_ids = set(split_meta["train_ids"])
    if split == "train":
        return [q for q in all_qs if str(q["task_id"]) in train_ids]
    if split == "test":
        return [q for q in all_qs if str(q["task_id"]) not in train_ids]
    raise click.ClickException(f"Unknown split: {split}")


@click.group()
def cli() -> None:
    load_dotenv()


@cli.command()
@click.option("--arm", type=click.Choice(["baseline", "explicit"]), required=True)
@click.option("--target", type=click.Path(path_type=Path), default=None,
              help="DuckDB file to build (default: ./{arm}.db)")
def load(arm: str, target: Path | None) -> None:
    """Build the DuckDB file for one arm by applying schemas/{arm}.sql."""
    target = target or REPO_ROOT / f"{arm}.db"
    path = build_db(arm, target)
    console.print(f"[green]✓[/green] built [bold]{arm}[/bold] → {path}")


# Color the arm so two side-by-side runs read at a glance.
ARM_STYLE = {"baseline": "yellow", "explicit": "cyan"}


def _arm_tag(arm: str) -> str:
    return f"[{ARM_STYLE.get(arm, 'white')}]{arm:>8}[/]"


def _correctness_mark(c: str) -> str:
    return {
        "correct": "[green]✓[/green]",
        "incorrect": "[red]✗[/red]",
        "error": "[red]![/red]",
        "hit_limit": "[yellow]⌛[/yellow]",
    }.get(c, "?")


@cli.command()
@click.option("--arm", type=click.Choice(["baseline", "explicit"]), required=True)
@click.option("--split", type=click.Choice(["train", "test"]), default="train")
@click.option("--db", type=click.Path(path_type=Path), default=None,
              help="DuckDB file (default: ./{arm}.db)")
@click.option("--model", default="gemini",
              help="OpenRouter model id, or alias: "
                   "gemini, geminipro, gpt, opus, deepseek")
@click.option("--limit", type=int, default=None, help="Cap number of questions")
@click.option("--task-id", "task_id", type=str, default=None,
              help="Run only the question with this task_id (overrides --split filter)")
@click.option("--max-turns", type=int, default=40)
@click.option("--reasoning", type=click.Choice(["low", "medium", "high", "off"]),
              default="medium", help="Thinking budget (off = no reasoning field sent)")
@click.option("--watch", is_flag=True, default=False,
              help="Stream every tool call live (question, gold answer, SQL, row counts)")
@click.option("--concurrency", type=int, default=16,
              help="Number of questions to run in parallel (default 16)")
@click.option("--out", type=click.Path(path_type=Path), default=None,
              help="Output JSONL path (default: results/{arm}_{split}_{ts}.jsonl)")
def evaluate(
    arm: str,
    split: str,
    db: Path | None,
    model: str,
    limit: int | None,
    task_id: str | None,
    max_turns: int,
    reasoning: str,
    watch: bool,
    concurrency: int,
    out: Path | None,
) -> None:
    """Run the agent across a split and write per-question JSONL."""
    model = MODEL_ALIASES.get(model, model)
    db = db or REPO_ROOT / f"{arm}.db"
    if not db.exists():
        raise click.ClickException(f"DB not found: {db}. Run `asm load --arm {arm}` first.")

    if task_id is not None:
        all_qs = _load_questions("all")
        questions = [q for q in all_qs if str(q["task_id"]) == task_id]
        if not questions:
            raise click.ClickException(f"task_id {task_id!r} not found in all.jsonl")
    else:
        questions = _load_questions(split)
        if limit:
            questions = questions[:limit]

    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out = out or RESULTS_DIR / f"{arm}_{split}_{ts}.jsonl"
    out.parent.mkdir(parents=True, exist_ok=True)

    if concurrency < 1:
        raise click.ClickException("--concurrency must be >= 1")

    console.rule(
        f"[bold]{arm}[/bold] · {split} · {len(questions)} questions · "
        f"{model} · reasoning={reasoning} · concurrency={concurrency}"
    )

    asyncio.run(_evaluate_loop(
        arm=arm, split=split, db=db, model=model,
        questions=questions, max_turns=max_turns,
        reasoning=reasoning, watch=watch, concurrency=concurrency, out=out,
    ))


def _print_block(prefix: Text, body: Text, body_indent: int) -> None:
    """Print `prefix` followed by `body`, where `body` wraps with a hanging
    indent of `body_indent` spaces. Single-line bodies share the prefix line;
    multi-paragraph or pre-wrapped bodies render on subsequent indented lines.
    """
    console.print(prefix)
    console.print(Padding(body, (0, 0, 0, body_indent)))


def _tid_prefix(task_id: str | None) -> str:
    """`[task_id] ` prefix for interleaved --watch output under concurrency."""
    return f"[dim][{task_id}][/dim] " if task_id else ""


def _render_thinking(text: str, task_id: str | None = None) -> None:
    """Pretty-print the model's thinking text (--watch)."""
    text = (text or "").strip()
    if not text:
        return
    label = Text.from_markup(_tid_prefix(task_id)) + Text("💭 thinking", style="italic blue dim")
    console.print(Padding(label, (0, 0, 0, 6)))
    body = Text(text, style="italic dim")
    console.print(Padding(body, (0, 0, 0, 8)))


def _render_tool_call(call: dict, task_id: str | None = None) -> None:
    """Pretty-print a single tool invocation as it happens (--watch)."""
    tool = call.get("tool", "?")
    err = call.get("error")
    turn = call.get("turn")
    max_turns = call.get("max_turns")
    turn_tag = ""
    if turn is not None and max_turns is not None:
        # Yellow once we're inside the countdown threshold.
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

    if tool == "list_tables":
        rows = call.get("result_rows", 0)
        line = header(f"  ({rows} tables)")
        console.print(Padding(line, (0, 0, 0, 6)))
        return

    if tool == "describe_table":
        tail = Text()
        tail.append("(")
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
            sql_text = Text(
                sql,
                style="bold" if tool == "submit_answer" else "default",
            )
            console.print(Padding(sql_text, (0, 0, 0, 8)))
        return

    console.print(Padding(Text(f"→ {tool} (unknown)"), (0, 0, 0, 6)))


async def _evaluate_loop(
    *, arm: str, split: str, db: Path, model: str,
    questions: list[dict], max_turns: int, reasoning: str,
    watch: bool, concurrency: int, out: Path,
) -> None:
    """Run questions concurrently up to `concurrency`. One shared
    OpenRouterProvider (single httpx client / connection pool); per-task
    usage and the per-task thinking callback live on contextvars in
    agent.py. DuckDB read-only connections are per-task because the
    Python connection object isn't thread-safe.
    """
    correct = 0
    by_cat: dict[str, int] = {}
    total_cost = 0.0
    total_elapsed = 0.0
    total_turns = 0
    n_hit_limit = 0
    completed = 0

    arm_tag = _arm_tag(arm)
    width = len(str(len(questions)))
    sem = asyncio.Semaphore(concurrency)
    write_lock = asyncio.Lock()
    provider = OpenRouterProvider(
        reasoning_effort=None if reasoning == "off" else reasoning,
    )
    f = out.open("w")
    wall_t0 = time.time()

    # Fresh per-invocation run_id (uuid7, sortable by time). out.stem is just
    # a human-readable label — relying on it for run_id breaks when --out is
    # reused, because deterministic controllog event_ids would collapse the
    # new run's rows into the prior run at upload time.
    run_id = controllog.new_id()
    controllog.init(
        project_id="agentic-sql-mini",
        log_dir=RESULTS_DIR,
        default_dims={
            "arm": arm, "split": split, "model": model,
            "run_id": run_id, "run_label": out.stem,
        },
    )

    async def run_one(q: dict) -> None:
        nonlocal correct, total_cost, total_elapsed, total_turns, n_hit_limit, completed
        tid = str(q["task_id"])
        async with sem:
            if watch:
                console.print()
                console.print(
                    f"  {arm_tag} {_tid_prefix(tid)}"
                    f"[bold]{tid}[/bold] [dim]· level={q.get('level','?')}[/dim]"
                )
                q_text = Text()
                q_text.append("Q: ", style="bold")
                q_text.append(q["question"])
                console.print(Padding(q_text, (0, 0, 0, 4)))
                if q.get("guidelines"):
                    g_text = Text()
                    g_text.append("guidelines: ", style="dim")
                    g_text.append(q["guidelines"], style="dim")
                    console.print(Padding(g_text, (0, 0, 0, 4)))
                gold_text = Text()
                gold_text.append("gold: ", style="dim")
                gold_text.append(str(q.get("answer")), style="green")
                console.print(Padding(gold_text, (0, 0, 0, 4)))

            # Spec § 6 lifecycle: NEW -> WIP before terminal transition.
            # Idempotency key scoped to run_id so re-running the same arm/split
            # gets a fresh event_id; without it the deterministic uuid5 would
            # collapse across runs.
            controllog.state_move(
                task_id=tid, from_="NEW", to="WIP",
                agent_id="asm-sql", run_id=run_id,
                idempotency_key=f"{run_id}:{tid}:NEW:WIP",
            )

            conn = duckdb.connect(str(db), read_only=True)
            t0 = time.time()
            try:
                try:
                    run = await run_agent(
                        conn=conn,
                        question=q["question"],
                        guidelines=q.get("guidelines"),
                        model=model,
                        provider=provider,
                        max_turns=max_turns,
                        on_tool_call=(lambda call, _tid=tid: _render_tool_call(call, _tid))
                        if watch else None,
                        on_thinking=(lambda text, _tid=tid: _render_thinking(text, _tid))
                        if watch else None,
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
                    gold_answer=q.get("answer", ""),
                    guidelines=q.get("guidelines"),
                    predicted_sql=None,
                )
            else:
                exec_result = run.final_rows if run.final_rows is not None else ExecutionError(
                    "NoSubmission", "agent did not submit"
                )
                result = score(
                    execution_result=exec_result,
                    gold_answer=q.get("answer", ""),
                    guidelines=q.get("guidelines"),
                    predicted_sql=run.final_sql,
                    hit_limit=run.hit_limit,
                )

            cost = run.cost_usd if run else 0.0
            n_turns = len(run.tool_calls) if run else 0

            row = {
                "task_id": tid,
                "level": q.get("level"),
                "arm": arm,
                "split": split,
                "model": model,
                "question": q["question"],
                "guidelines": q.get("guidelines"),
                "gold_answer": q.get("answer"),
                "predicted_answer": result.predicted_answer,
                "predicted_sql": run.final_sql if run else None,
                "is_correct": result.is_correct,
                "correctness": result.correctness.value,
                "reason": result.reason,
                "match_source": result.match_source,
                "hit_limit": run.hit_limit if run else False,
                "tool_calls": run.tool_calls if run else [],
                "n_tool_calls": n_turns,
                "elapsed_s": round(elapsed, 2),
                "cost_usd": round(cost, 6),
                "prompt_tokens": run.prompt_tokens if run else 0,
                "completion_tokens": run.completion_tokens if run else 0,
                "cached_tokens": run.cached_tokens if run else 0,
                "error": err,
                "ts": datetime.now(timezone.utc).isoformat(),
            }

            # One balanced task_complete event covering all the accounting for
            # this question. Built directly with event() + post() since the lib's
            # generic builders are per-model-call, not per-task-aggregate.
            project_id = "agentic-sql-mini"
            total_tokens = (run.prompt_tokens + run.completion_tokens) if run else 0
            wall_ms = int(elapsed * 1000)
            reward = 1.0 if result.is_correct else 0.0
            terminal_state = "DONE" if run is not None else "FAILED"
            postings = [
                controllog.post("resource.tokens", "provider:openrouter", "+tokens", -total_tokens, {"model": model}),
                controllog.post("resource.tokens", f"project:{project_id}", "+tokens", +total_tokens, {"model": model}),
                controllog.post("truth.time", "agent:asm-sql", "ms", -wall_ms, {"kind": "wall"}),
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
                actor={"agent_id": "asm-sql", "task_id": tid},
                run_id=run_id,
                payload={
                    "question_id": tid,
                    "level": q.get("level"),
                    "correctness": result.correctness.value,
                    "hit_limit": run.hit_limit if run else False,
                    "n_tool_calls": n_turns,
                    "cached_tokens": run.cached_tokens if run else 0,
                    "error": err,
                },
                postings=postings,
                idempotency_key=f"{run_id}:task:{tid}",
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
                        f"  ({result.correctness.value}, "
                        f"{n_turns}/{max_turns} turns, "
                        f"{elapsed:.1f}s, ${cost:.4f})",
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
                    console.print(
                        f"  {arm_tag} [{done:>{width}}/{len(questions)}] "
                        f"{_correctness_mark(result.correctness.value)} "
                        f"[dim]{tid:<6}[/dim] "
                        f"{elapsed:>5.1f}s  ${cost:.4f}  "
                        f"[dim]{n_turns:>2}/{max_turns} turns[/dim]  "
                        f"[dim]running: {correct}/{done} = {running_pct:.0f}%[/dim]"
                    )

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
    summary_table.add_row("arm", f"[bold]{arm}[/bold] · {split}")
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
        f"avg {total_turns/max(len(questions),1):.1f}/{max_turns}  "
        f"(hit_limit: {n_hit_limit}/{len(questions)})",
    )
    summary_table.add_row("results", str(out))
    console.print()
    console.print(summary_table)
    console.print()


@cli.command()
@click.argument("jsonl_path", type=click.Path(exists=True, path_type=Path))
def summary(jsonl_path: Path) -> None:
    """Print a quick correctness breakdown for one results file."""
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

    arm = rows[0].get("arm", "?")
    split = rows[0].get("split", "?")
    model = rows[0].get("model", "?")
    total_cost = sum(r.get("cost_usd", 0.0) or 0.0 for r in rows)
    total_time = sum(r.get("elapsed_s", 0.0) or 0.0 for r in rows)
    total_turns = sum(r.get("n_tool_calls", 0) or 0 for r in rows)
    n_hit_limit = sum(1 for r in rows if r.get("hit_limit"))

    pct = (correct / total * 100) if total else 0.0

    header = Table(show_header=False, box=None, padding=(0, 2))
    header.add_column(style="dim")
    header.add_column()
    header.add_row("file", str(jsonl_path))
    header.add_row("arm", f"[bold]{arm}[/bold] · {split} · {model}")
    header.add_row("accuracy", f"[bold]{correct}/{total} = {pct:.1f}%[/bold]")
    header.add_row("cost", f"${total_cost:.4f}")
    header.add_row("time", f"{total_time:.1f}s")
    header.add_row(
        "turns",
        f"avg {total_turns/total:.1f}  (hit_limit: {n_hit_limit}/{total})",
    )
    console.print(header)

    cat_table = Table(title="By correctness", show_header=True)
    cat_table.add_column("category")
    cat_table.add_column("n", justify="right")
    for cat in sorted(by_cat):
        cat_table.add_row(f"{_correctness_mark(cat)} {cat}", str(by_cat[cat]))
    console.print(cat_table)

    lvl_table = Table(title="By level", show_header=True)
    lvl_table.add_column("level")
    lvl_table.add_column("correct", justify="right")
    lvl_table.add_column("total", justify="right")
    lvl_table.add_column("%", justify="right")
    for lvl in sorted(by_level):
        c, t = by_level[lvl]
        lvl_table.add_row(str(lvl), str(c), str(t), f"{(c/t*100):.0f}")
    console.print(lvl_table)


@cli.command()
@click.argument("baseline_path", type=click.Path(exists=True, path_type=Path))
@click.argument("explicit_path", type=click.Path(exists=True, path_type=Path))
def compare(baseline_path: Path, explicit_path: Path) -> None:
    """Show the headline number: explicit accuracy − baseline accuracy."""
    def _stats(p: Path) -> tuple[int, int, float, float]:
        rows = [json.loads(line) for line in p.read_text().splitlines() if line.strip()]
        c = sum(1 for r in rows if r["is_correct"])
        cost = sum(r.get("cost_usd", 0.0) or 0.0 for r in rows)
        return c, len(rows), cost, (c / len(rows) * 100) if rows else 0.0

    bc, bn, bcost, bpct = _stats(baseline_path)
    ec, en, ecost, epct = _stats(explicit_path)

    table = Table(title="A/B comparison", show_header=True)
    table.add_column("arm", style="bold")
    table.add_column("accuracy", justify="right")
    table.add_column("cost", justify="right")
    table.add_column("file", style="dim")
    table.add_row(
        f"[{ARM_STYLE['baseline']}]baseline[/]",
        f"{bc}/{bn} = {bpct:.1f}%",
        f"${bcost:.4f}",
        baseline_path.name,
    )
    table.add_row(
        f"[{ARM_STYLE['explicit']}]explicit[/]",
        f"{ec}/{en} = {epct:.1f}%",
        f"${ecost:.4f}",
        explicit_path.name,
    )
    console.print(table)
    delta = epct - bpct
    sign = "+" if delta >= 0 else ""
    color = "green" if delta >= 0 else "red"
    console.print(
        f"[bold]headline:[/bold] explicit − baseline = "
        f"[{color}]{sign}{delta:.1f} pp[/{color}]"
    )


if __name__ == "__main__":
    cli()
