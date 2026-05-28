"""``controllog-viz`` CLI — render controllog datasets to static HTML.

    controllog-viz dashboard --source logs/ -o out/dashboard.html
    controllog-viz review    --source logs/ --latest -o out/review.html
    controllog-viz review    --source md:my_db --run-id run-2026-05-26

``--source`` is a JSONL file, directory, or glob, or ``md:<database>`` for MotherDuck.
"""
from __future__ import annotations

import webbrowser
from pathlib import Path

import click

from controllog_viz import queries as q
from controllog_viz import reader, render

_source_option = click.option(
    "--source",
    required=True,
    help="JSONL file/dir/glob, or 'md:<database>' for MotherDuck.",
)
_open_option = click.option("--open", "open_browser", is_flag=True, help="Open the HTML when done.")


def _write_and_report(html: str, output: Path, kind: str, open_browser: bool) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(html, encoding="utf-8")
    click.echo(f"Generated {kind}: {output}")
    if open_browser:
        webbrowser.open(f"file://{output.resolve()}")


@click.group()
@click.version_option(package_name="controllog-viz")
def cli() -> None:
    """Render controllog datasets to static HTML views."""


@cli.command()
@_source_option
@click.option("--run-id", default=None, help="Run to review.")
@click.option("--latest", is_flag=True, help="Review the run with the most recent event.")
@click.option("-o", "--output", default="out/review.html", type=click.Path(), help="Output HTML path.")
@_open_option
def review(source: str, run_id: str | None, latest: bool, output: str, open_browser: bool) -> None:
    """Render the per-run review page."""
    if not run_id and not latest:
        raise click.UsageError("Specify --run-id or --latest.")

    con = reader.connect(source)
    try:
        if latest:
            run_id = q.latest_run_id(con)
            if run_id is None:
                raise click.ClickException(f"No runs found in source {source!r}.")
        html = render.render_run_review(con, run_id)
    finally:
        con.close()

    _write_and_report(html, Path(output), "review", open_browser)


@cli.command()
@_source_option
@click.option("-o", "--output", default="out/dashboard.html", type=click.Path(), help="Output HTML path.")
@_open_option
def dashboard(source: str, output: str, open_browser: bool) -> None:
    """Render the cross-run dashboard page."""
    con = reader.connect(source)
    try:
        html = render.render_dashboard(con, reader.source_label(source))
    finally:
        con.close()

    _write_and_report(html, Path(output), "dashboard", open_browser)


if __name__ == "__main__":
    cli()
