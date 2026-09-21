"""What runs inside the MotherDuck Flight.

The dbt v2 run never executes Python: the ``save_charts_as_dives`` macro stages the project
(boards, ``dbt_charts.yml``, ``dbt_project.yml``, ``target/manifest.json``) **and this
package's own source** into a MotherDuck table, then triggers a Flight. The Flight's whole
program (``macros/flight_program.sql``) writes the staged package files to ``DCD_STAGE``,
puts them on ``sys.path`` and calls ``main()`` below.

``main()`` materializes the staged project files under ``DCD_STAGE``, synthesizes the ``profiles.yml``
dbt Charts needs to read the warehouse, compiles every eligible board and upserts its Dive.
It reports back through two tables so the macro can log URLs and fail the dbt build:

* ``dbt_charts_dive_registry`` — one row per published Dive (key, id, title, URL)
* ``dbt_charts_dive_runs``     — one row per Flight run (status, results JSON, error)

Config comes in as environment variables set by the macro: ``DCD_DB``, ``DCD_SCHEMA``,
``DCD_INPUTS``, ``DCD_OPTIONS`` (JSON overrides) and ``DCD_FAILED`` (models that failed in
the dbt run). The runs row is keyed by ``MOTHERDUCK_FLIGHT_RUN_ID``, which the runtime
injects and the macro also gets back from ``MD_RUN_FLIGHT``.
"""

from __future__ import annotations

import json
import os
import time
import traceback
from pathlib import Path
from typing import Any

import duckdb

STAGE = Path(os.environ.get("DCD_STAGE", "/tmp/dbt_charts_dive"))


def _materialize_project(con: duckdb.DuckDBPyConnection, db: str, schema: str, table: str) -> Path:
    """Write the staged dbt project (boards, config, manifest) to disk.

    The package's own source is already on disk: the Flight's bootstrap writes it and puts
    it on ``sys.path`` before importing this module.
    """
    project = STAGE / "project"
    rows = con.execute(f"SELECT path, content FROM \"{db}\".\"{schema}\".\"{table}\" WHERE kind = 'project'").fetchall()
    for rel, content in rows:
        dest = project / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(content, encoding="utf-8")
    print(f"staged {len(rows)} project files -> {project}", flush=True)
    return project


def write_profiles(project: Path, db: str, schema: str | None = None) -> None:
    """A ``profiles.yml`` covering every (profile, target) the board config names.

    dbt Charts reads the warehouse through a dbt profile. Inside a Flight the warehouse is
    always this MotherDuck database and the run's injected token authenticates it, so every
    ``dbt_profile`` source resolves to the same ``md:`` connection — and to the schema the
    dbt run wrote to, which is what a board's unqualified table name means.
    """
    import yaml

    cfg = yaml.safe_load((project / "dbt_charts.yml").read_text(encoding="utf-8")) if (project / "dbt_charts.yml").exists() else {}
    wanted: dict[str, set[str]] = {}
    for source in ((cfg or {}).get("sources") or {}).values():
        if isinstance(source, dict) and source.get("type") == "dbt_profile":
            wanted.setdefault(str(source.get("profile") or "default"), set()).add(str(source.get("target") or "dev"))
    if not wanted:
        proj = yaml.safe_load((project / "dbt_project.yml").read_text(encoding="utf-8")) or {}
        wanted = {str(proj.get("profile") or "default"): {"dev"}}
    doc = {
        profile: {
            "target": sorted(targets)[0],
            "outputs": {t: {"type": "duckdb", "path": f"md:{db}", "schema": schema or "main", "threads": 4} for t in sorted(targets)},
        }
        for profile, targets in wanted.items()
    }
    (project / "profiles.yml").write_text(yaml.safe_dump(doc), encoding="utf-8")
    os.environ["DBT_PROFILES_DIR"] = str(project)
    os.environ["DBT_PROJECT_DIR"] = str(project)


def _record_run(con: duckdb.DuckDBPyConnection, db: str, schema: str, results: list[dict[str, Any]], error: str | None) -> None:
    con.execute(
        f'CREATE TABLE IF NOT EXISTS "{db}"."{schema}"."dbt_charts_dive_runs" '
        "(run_id VARCHAR, finished_at TIMESTAMPTZ, status VARCHAR, results JSON, error VARCHAR)"
    )
    run_id = os.environ.get("MOTHERDUCK_FLIGHT_RUN_ID") or ""
    # One row per run, kept for a month: enough to debug the last failure, not a growing log
    # of every Dive URL sitting in the user's schema (and in any share of it).
    con.execute(f"""DELETE FROM "{db}"."{schema}"."dbt_charts_dive_runs" WHERE run_id = ? OR finished_at < now() - INTERVAL 30 DAY""", [run_id])
    con.execute(
        f'INSERT INTO "{db}"."{schema}"."dbt_charts_dive_runs" SELECT ?, now(), ?, ?, ?',
        [run_id, "error" if error else "ok", json.dumps(results), error],
    )


def _drop_staging(con: duckdb.DuckDBPyConnection, db: str, schema: str) -> None:
    """The staged input is spent once it has been read; leaving it would put the boards and
    this package's source in the user's schema (and in any share of it). The macro drops it
    too when it waits for the run; this covers wait: false and failures."""
    table = os.environ.get("DCD_INPUTS")
    if table:
        con.execute(f'DROP TABLE IF EXISTS "{db}"."{schema}"."{table}"')


def main() -> None:
    t0 = time.time()
    db = os.environ["DCD_DB"]
    schema = os.environ.get("DCD_SCHEMA") or "main"
    con = duckdb.connect("md:")
    results: list[dict[str, Any]] = []
    try:
        project = _materialize_project(con, db, schema, os.environ.get("DCD_INPUTS") or "dbt_charts_dive_inputs")

        from dbt_charts_dive.bundle import use_warehouse_cache
        from dbt_charts_dive.config import load_options
        from dbt_charts_dive.publisher import publish

        # A Flight's /tmp is new every run, so the Vega runtime is cached in the warehouse
        # instead: one download per version, not one per run.
        use_warehouse_cache(con, f'"{db}"."{schema}"."dbt_charts_dive_vega"')

        write_profiles(project, db, schema)
        options = load_options(project, json.loads(os.environ.get("DCD_OPTIONS") or "{}") or {})
        failed = json.loads(os.environ.get("DCD_FAILED") or "[]") or []
        print(f"options: {json.dumps(options)}", flush=True)
        if failed:
            print(f"models that failed in the dbt run: {failed}", flush=True)
        results = publish(project, con, database=db, schema=schema, options=options, failed=failed)
    except Exception:
        error = traceback.format_exc()
        print(error, flush=True)
        _record_run(con, db, schema, results, error.strip().splitlines()[-1][:800])
        _drop_staging(con, db, schema)
        raise
    _record_run(con, db, schema, results, None)
    _drop_staging(con, db, schema)
    published = [r for r in results if r.get("dive_id")]
    print(f"done in {time.time() - t0:.1f}s: {len(published)} dive(s) published, {len(results) - len(published)} skipped", flush=True)


if __name__ == "__main__":
    main()
