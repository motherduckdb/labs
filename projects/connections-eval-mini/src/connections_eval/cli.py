"""CLI for eval-connections-mini."""

import typer
from pathlib import Path
from rich.console import Console
from rich.table import Table

from .core import ConnectionsGame, EvalRunFailedError

app = typer.Typer(help="Evaluate AI models on NYT Connections puzzles")
console = Console()

INPUTS = Path(__file__).parent.parent.parent / "inputs"
LOGS = Path(__file__).parent.parent.parent / "logs"


@app.command()
def run(
    model: str = typer.Option(..., "--model", "-m", help="Model name from models.yml"),
    puzzles: int = typer.Option(5, "--puzzles", "-p", min=1, help="Number of puzzles to run"),
    seed: int = typer.Option(None, "--seed", "-s", help="Random seed for reproducibility"),
):
    """Run evaluation against a model."""
    LOGS.mkdir(exist_ok=True)
    game = ConnectionsGame(INPUTS, LOGS, seed=seed)

    if model not in game.model_config:
        console.print(f"[red]Unknown model: {model}[/red]")
        console.print(f"Available: {', '.join(sorted(game.model_config.keys()))}")
        raise typer.Exit(1)

    console.print(f"Running {puzzles} puzzles with [bold]{model}[/bold]...")
    failed = False
    try:
        summary = game.run_evaluation(model, max_puzzles=puzzles)
    except EvalRunFailedError as exc:
        summary = exc.summary
        failed = True

    # Results table
    table = Table(title=f"Results: {model}")
    table.add_column("Metric", style="bold")
    table.add_column("Value")

    solved = summary["puzzles_solved"]
    attempted = summary["puzzles_attempted"]
    targeted = summary.get("puzzles_targeted", attempted)
    rate = (solved / attempted * 100) if attempted else 0

    table.add_row("Status", str(summary.get("status", "completed")))
    table.add_row("Puzzles", f"{solved}/{attempted} ({rate:.0f}%)")
    if targeted != attempted:
        table.add_row("Scheduled", str(targeted))
    table.add_row("Guesses", f"{summary['total_guesses']} ({summary['correct_guesses']} correct, {summary['incorrect_guesses']} incorrect)")
    table.add_row("Invalid", str(summary["invalid_responses"]))
    table.add_row("Tokens", f"{summary['total_tokens']:,} (prompt: {summary['total_prompt_tokens']:,}, completion: {summary['total_completion_tokens']:,})")
    table.add_row("Cost", f"${summary['total_cost']:.4f}")
    table.add_row("Time", f"{summary['total_time_sec']:.1f}s (avg {summary['avg_time_sec']:.1f}s/puzzle)")

    console.print(table)
    console.print(f"\nRun ID: {summary['run_id']}")
    console.print(f"Logs:   {LOGS}/")
    if failed:
        failure = summary.get("error_message", "unknown error")
        if summary.get("status_code") is not None:
            failure = f"HTTP {summary['status_code']}: {failure}"
        console.print(f"[red]Run failed on puzzle {summary.get('failed_puzzle_id')}: {failure}[/red]")
        raise typer.Exit(1)


@app.command("list-models")
def list_models():
    """Show available models."""
    game = ConnectionsGame(INPUTS, LOGS)
    table = Table(title="Available Models")
    table.add_column("Name", style="bold")
    table.add_column("OpenRouter ID")
    table.add_column("Type")

    for name, model_id in sorted(game.model_config.items()):
        mtype = "thinking" if model_id in game.thinking_models else "standard"
        table.add_row(name, model_id, mtype)

    console.print(table)


@app.command("list-puzzles")
def list_puzzles():
    """Show available puzzles."""
    game = ConnectionsGame(INPUTS, LOGS)
    table = Table(title=f"Available Puzzles ({len(game.puzzles)})")
    table.add_column("ID", style="bold")
    table.add_column("Date")
    table.add_column("Difficulty")
    table.add_column("Sample Words")

    for p in sorted(game.puzzles, key=lambda x: x.difficulty):
        sample = ", ".join(p.words[:6]) + "..."
        table.add_row(str(p.id), str(p.date), str(p.difficulty), sample)

    console.print(table)


def main():
    app()
