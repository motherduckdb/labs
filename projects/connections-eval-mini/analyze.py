"""Analyze eval results with DuckDB.

Run after completing evaluations to compare models, inspect costs,
and replay individual games to understand model reasoning.

Usage:
    uv run analyze.py
    uv run analyze.py --replay          # show game-by-game detail
    uv run analyze.py --controllog      # show controllog accounting
"""

import argparse
import sys
from pathlib import Path

import duckdb
from rich.console import Console
from rich.table import Table

console = Console()
LOGS = Path(__file__).parent / "logs"


def build_eval_views(conn: duckdb.DuckDBPyConnection, log_dir: Path = LOGS) -> None:
    """Create DuckDB views for complete and in-progress eval runs."""
    eval_glob = str(log_dir / "connections_eval_*.jsonl")
    conn.execute(f"""
        CREATE VIEW exchanges AS
        SELECT * FROM read_json_auto('{eval_glob}')
        WHERE message = 'exchange'
    """)

    conn.execute(f"""
        CREATE VIEW summaries AS
        SELECT * FROM read_json_auto('{eval_glob}')
        WHERE message = 'summary'
    """)

    conn.execute("""
        CREATE VIEW completed_summaries AS
        SELECT * EXCLUDE (row_num)
        FROM (
            SELECT *,
                ROW_NUMBER() OVER (
                    PARTITION BY run_id
                    ORDER BY timestamp DESC
                ) AS row_num
            FROM summaries
        )
        WHERE row_num = 1
          AND COALESCE(status, 'completed') = 'completed'
    """)

    conn.execute("""
        CREATE VIEW completed_runs AS
        SELECT run_id FROM completed_summaries
    """)

    conn.execute("""
        CREATE VIEW completed_exchanges AS
        SELECT e.*
        FROM exchanges e
        JOIN completed_runs r USING (run_id)
    """)

    # Controllog views (optional - may not exist yet)
    cl_events_glob = str(log_dir / "controllog" / "*" / "events.jsonl")
    cl_postings_glob = str(log_dir / "controllog" / "*" / "postings.jsonl")
    if list(log_dir.glob("controllog/*/events.jsonl")):
        conn.execute(f"""
            CREATE VIEW cl_events AS
            SELECT * FROM read_json_auto('{cl_events_glob}')
        """)
        conn.execute(f"""
            CREATE VIEW cl_postings AS
            SELECT * FROM read_json_auto('{cl_postings_glob}')
        """)


def get_conn(log_dir: Path = LOGS) -> duckdb.DuckDBPyConnection:
    conn = duckdb.connect()

    if not list(log_dir.glob("connections_eval_*.jsonl")):
        console.print("[red]No log files found in logs/. Run some evals first![/red]")
        console.print("  uv run eval run -m haiku-4.5 -p 5")
        sys.exit(1)

    build_eval_views(conn, log_dir=log_dir)
    return conn


# ---------------------------------------------------------------------------
# Model leaderboard
# ---------------------------------------------------------------------------

def show_leaderboard(conn: duckdb.DuckDBPyConnection) -> None:
    rows = conn.execute("""
        SELECT
            model,
            COUNT(*) AS runs,
            SUM(puzzles_solved) AS solved,
            SUM(puzzles_attempted) AS attempted,
            ROUND(SUM(puzzles_solved) * 100.0 / SUM(puzzles_attempted), 1) AS solve_pct,
            ROUND(MEDIAN(total_cost / puzzles_attempted), 4) AS med_cost_per_puzzle,
            ROUND(MEDIAN(avg_time_sec), 1) AS med_time
        FROM completed_summaries
        GROUP BY model
        ORDER BY solve_pct DESC, med_cost_per_puzzle ASC
    """).fetchall()

    table = Table(title="Model Leaderboard")
    table.add_column("Model", style="bold")
    table.add_column("Runs", justify="right")
    table.add_column("Solved", justify="right")
    table.add_column("Rate", justify="right")
    table.add_column("Med $/puzzle", justify="right")
    table.add_column("Med Time", justify="right")

    for r in rows:
        model, runs, solved, attempted, pct, cpp, med_t = r
        table.add_row(
            model,
            str(runs),
            f"{solved}/{attempted}",
            f"{pct}%",
            f"${cpp:.4f}",
            f"{med_t}s",
        )

    console.print(table)


# ---------------------------------------------------------------------------
# Per-puzzle analysis
# ---------------------------------------------------------------------------

def show_puzzle_analysis(conn: duckdb.DuckDBPyConnection) -> None:
    rows = conn.execute("""
        WITH puzzle_runs AS (
            SELECT
                puzzle_id,
                model,
                run_id,
                SUM(CASE WHEN result LIKE 'CORRECT%' THEN 1 ELSE 0 END) AS correct,
                SUM(CASE WHEN result LIKE 'INCORRECT%' THEN 1 ELSE 0 END) AS incorrect,
                MAX(CASE WHEN result = 'CORRECT' THEN 1 ELSE 0 END) AS won,
                SUM(COALESCE(cost, 0)) AS puzzle_cost,
                SUM(latency_ms) AS puzzle_ms
            FROM completed_exchanges
            GROUP BY puzzle_id, model, run_id
        )
        SELECT
            puzzle_id,
            COUNT(*) AS runs,
            SUM(won) AS wins,
            ROUND(SUM(won)::FLOAT / COUNT(*) * 100, 0) AS solve_pct,
            ROUND(MEDIAN(correct), 1) AS med_correct,
            ROUND(MEDIAN(incorrect), 1) AS med_incorrect,
            ROUND(MEDIAN(puzzle_cost), 4) AS med_cost,
            ROUND(MEDIAN(puzzle_ms) / 1000, 1) AS med_time_sec
        FROM puzzle_runs
        GROUP BY puzzle_id
        ORDER BY solve_pct ASC, med_incorrect DESC
    """).fetchall()

    table = Table(title="Puzzle Difficulty (hardest first)")
    table.add_column("Puzzle", style="bold", justify="right")
    table.add_column("Runs", justify="right")
    table.add_column("Wins", justify="right")
    table.add_column("Solve %", justify="right")
    table.add_column("Med Correct", justify="right")
    table.add_column("Med Incorrect", justify="right")
    table.add_column("Med Cost", justify="right")
    table.add_column("Med Time", justify="right")

    for r in rows:
        pid, runs, wins, pct, correct, incorrect, cost, time_sec = r
        table.add_row(str(pid), str(runs), str(wins), f"{pct}%", str(correct), str(incorrect), f"${cost:.4f}", f"{time_sec}s")

    console.print(table)


# ---------------------------------------------------------------------------
# Cost efficiency
# ---------------------------------------------------------------------------

def show_cost_analysis(conn: duckdb.DuckDBPyConnection) -> None:
    rows = conn.execute("""
        WITH per_puzzle AS (
            SELECT
                model,
                run_id,
                puzzle_id,
                SUM(COALESCE(cost, 0)) AS puzzle_cost,
                SUM(COALESCE(prompt_tokens, 0)) AS puzzle_prompt_tok,
                SUM(COALESCE(completion_tokens, 0)) AS puzzle_compl_tok,
                SUM(latency_ms) AS puzzle_ms
            FROM completed_exchanges
            GROUP BY model, run_id, puzzle_id
        )
        SELECT
            model,
            ROUND(SUM(puzzle_cost), 4) AS total_cost,
            ROUND(MEDIAN(puzzle_cost), 4) AS med_cost_per_puzzle,
            ROUND(MEDIAN(puzzle_prompt_tok)) AS med_prompt_tok,
            ROUND(MEDIAN(puzzle_compl_tok)) AS med_compl_tok,
            ROUND(MEDIAN(puzzle_ms), 0) AS med_latency_ms
        FROM per_puzzle
        GROUP BY model
        ORDER BY total_cost ASC
    """).fetchall()

    table = Table(title="Cost & Token Analysis (per puzzle)")
    table.add_column("Model", style="bold")
    table.add_column("Total Cost", justify="right")
    table.add_column("Med $/puzzle", justify="right")
    table.add_column("Med Prompt Tok", justify="right")
    table.add_column("Med Compl Tok", justify="right")
    table.add_column("Med Latency", justify="right")

    for r in rows:
        model, cost, cpp, pt, ct, lat = r
        table.add_row(
            model, f"${cost:.4f}", f"${cpp:.4f}",
            f"{int(pt):,}", f"{int(ct):,}", f"{int(lat)}ms",
        )

    console.print(table)


# ---------------------------------------------------------------------------
# Game replay
# ---------------------------------------------------------------------------

def show_replay(conn: duckdb.DuckDBPyConnection, show_thinking: bool = False) -> None:
    """Show guess-by-guess detail for the most recent run."""
    runs = conn.execute("""
        SELECT run_id, model FROM completed_summaries ORDER BY run_id DESC
    """).fetchall()

    if not runs:
        console.print("[yellow]No runs found.[/yellow]")
        return

    # Show replay for each run's puzzles
    for run_id, model in runs[:3]:  # limit to 3 most recent
        console.print(f"\n[bold]Run: {model}[/bold]  ({run_id})")

        puzzles = conn.execute("""
            SELECT DISTINCT puzzle_id FROM completed_exchanges
            WHERE run_id = $1 ORDER BY puzzle_id
        """, [run_id]).fetchall()

        for (pid,) in puzzles:
            guesses = conn.execute("""
                SELECT guess_index, guess, result, confidence, latency_ms, cost, thinking
                FROM completed_exchanges
                WHERE run_id = $1 AND puzzle_id = $2
                ORDER BY guess_index
            """, [run_id, pid]).fetchall()

            won = any("CORRECT" == g[2] for g in guesses)
            status = "[green]WON[/green]" if won else "[red]LOST[/red]"
            console.print(f"  {model}: Puzzle {pid} {status}")

            for idx, guess, result, conf, lat, cost, thinking in guesses:
                if show_thinking and thinking:
                    console.print(f"    [dim]--- Guess {idx} thinking ---[/dim]")
                    for line in thinking.strip().split("\n"):
                        console.print(f"    [dim]{line}[/dim]")
                    console.print()
                short_result = result[:50] + "..." if len(result) > 50 else result
                cost_str = f"${cost:.4f}" if cost else ""
                time_str = f"{lat / 1000:.1f}s" if lat else ""
                meta = ", ".join(x for x in [time_str, cost_str] if x)
                console.print(f"    {idx}. {guess}  =>  {short_result}  [{meta}]")
                if show_thinking:
                    console.print()

            # Show auto-solve if won with fewer guesses than 4 groups
            correct_count = sum(1 for g in guesses if g[2].startswith("CORRECT"))
            if won and correct_count < 4:
                console.print(f"    {guesses[-1][0] + 1}. (auto-solved by elimination)")


# ---------------------------------------------------------------------------
# Controllog analysis
# ---------------------------------------------------------------------------

def show_controllog(conn: duckdb.DuckDBPyConnection) -> None:
    """Show the double-entry accounting view of the eval."""
    try:
        conn.execute("SELECT 1 FROM cl_postings LIMIT 1")
    except duckdb.CatalogException:
        console.print("[yellow]No controllog data found yet.[/yellow]")
        return

    # Token balance by model
    rows = conn.execute("""
        SELECT
            dims_json->>'model' AS model,
            dims_json->>'phase' AS phase,
            SUM(delta_numeric)::INT AS total_tokens
        FROM cl_postings
        WHERE account_type = 'resource.tokens'
            AND account_id LIKE 'project:%'
        GROUP BY model, phase
        ORDER BY model, phase
    """).fetchall()

    table = Table(title="Controllog: Token Accounting")
    table.add_column("Model", style="bold")
    table.add_column("Phase")
    table.add_column("Tokens", justify="right")

    for model, phase, tokens in rows:
        table.add_row(model, phase, f"{tokens:,}")

    console.print(table)

    # Cost by model
    rows = conn.execute("""
        SELECT
            dims_json->>'model' AS model,
            ROUND(SUM(delta_numeric), 4) AS total_cost
        FROM cl_postings
        WHERE account_type = 'resource.money'
            AND account_id LIKE 'project:%'
        GROUP BY model
        ORDER BY total_cost DESC
    """).fetchall()

    table = Table(title="Controllog: Cost Accounting")
    table.add_column("Model", style="bold")
    table.add_column("Total Cost", justify="right")

    for model, cost in rows:
        table.add_row(model, f"${cost:.4f}")

    console.print(table)

    # Trial balance — should be zero for every account type
    rows = conn.execute("""
        SELECT
            account_type,
            unit,
            ROUND(SUM(delta_numeric), 6) AS balance
        FROM cl_postings
        GROUP BY account_type, unit
        ORDER BY account_type
    """).fetchall()

    table = Table(title="Controllog: Trial Balance (should all be zero)")
    table.add_column("Account Type", style="bold")
    table.add_column("Unit")
    table.add_column("Balance", justify="right")

    for acct, unit, balance in rows:
        style = "green" if abs(balance) < 0.001 else "red bold"
        table.add_row(acct, unit, f"{balance}", style=style)

    console.print(table)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Analyze eval results with DuckDB")
    parser.add_argument("--replay", action="store_true", help="Show game-by-game replay")
    parser.add_argument("--thinking", action="store_true", help="Show replay with model thinking")
    parser.add_argument("--controllog", action="store_true", help="Show controllog accounting")
    args = parser.parse_args()

    conn = get_conn()

    if args.thinking:
        show_replay(conn, show_thinking=True)
    elif args.replay:
        show_replay(conn)
    elif args.controllog:
        show_controllog(conn)
    else:
        show_leaderboard(conn)
        console.print()
        show_puzzle_analysis(conn)
        console.print()
        show_cost_analysis(conn)
        console.print()
        console.print("[dim]Tip: --replay for game detail, --thinking for model reasoning, --controllog for accounting[/dim]")


if __name__ == "__main__":
    main()
