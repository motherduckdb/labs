#!/usr/bin/env python
"""End-to-end test: board YAML -> Dive source -> live SQL on MotherDuck -> rendered DOM.

    python tests/e2e_test.py <dbt project dir> charts/board.yml [charts/other.yml ...]

For each board it (1) compiles the Dive exactly as the dbt hook does, (2) runs every board
query against MotherDuck, (3) renders the Dive in jsdom with those rows (the Vega bundle is
mocked; charts' pixels are dbt-charts' concern), and (4) asserts that what depends on the
data is really there: every table has one row per SQL row and no empty cells, KPIs show a
value, no chart is in an error or loading state. Exit code 1 on any failure.

Needs: the dbt project's Python env (dbt-charts, dbt_charts_dive importable), node >= 18,
`npm install` in this directory, and a MotherDuck token in the environment.
"""

from __future__ import annotations

import datetime as dt
import decimal
import json
import os
import subprocess
import sys
from pathlib import Path

import duckdb

HERE = Path(__file__).resolve().parent


def jsonable(v):
    if isinstance(v, decimal.Decimal):
        return float(v)
    if isinstance(v, (dt.date, dt.datetime)):
        return v.isoformat()
    return v


def fetch_rows(sql: str) -> list[dict]:
    con = duckdb.connect("md:")
    cur = con.execute(sql)
    cols = [d[0] for d in cur.description]
    return [{c: jsonable(v) for c, v in zip(cols, row)} for row in cur.fetchall()]


def run_board(project_dir: Path, board: str) -> list[str]:
    from dbt_charts_dive.builder import build_dive_from_boards

    failures: list[str] = []
    build = build_dive_from_boards(project_dir, [board])
    manifest = build.manifest
    rows_by_sql = {sql: fetch_rows(sql) for sql in manifest["queries"].values()}

    out = HERE / "build"
    out.mkdir(exist_ok=True)
    (out / "dive.tsx").write_text(build.content, encoding="utf-8")
    (out / "rows.json").write_text(json.dumps(rows_by_sql), encoding="utf-8")
    proc = subprocess.run(["node", str(HERE / "run_dive.mjs"), str(out / "dive.tsx"), str(out / "rows.json")], capture_output=True, text=True, cwd=HERE)
    if proc.returncode != 0:
        return [f"harness crashed: {proc.stderr.strip()[-800:]}"]
    report = json.loads(proc.stdout)

    # ── assertions ──────────────────────────────────────────────────────────
    if report["alerts"]:
        failures.append(f"error boxes rendered: {report['alerts']}")
    if report["skeletons"]:
        failures.append(f"{report['skeletons']} chart(s) still loading after render")
    if not report["required_databases"]:
        failures.append("REQUIRED_DATABASES is empty")

    charts = manifest["charts"]
    expected_tables = [c for c in charts.values() if c["kind"] == "table"]
    legend_tables = [c for c in charts.values() if c["kind"] == "vega" and c.get("legend")]
    if len(report["tables"]) != len(expected_tables) + len(legend_tables):
        failures.append(f"expected {len(expected_tables) + len(legend_tables)} table(s), DOM has {len(report['tables'])}")
    dom_tables = list(report["tables"])
    for c in expected_tables:
        sql = manifest["queries"].get(c["query"])
        rows = rows_by_sql.get(sql, [])
        page = (c.get("table") or {}).get("page_rows")
        want = min(len(rows), page) if page else len(rows)
        cols = (c.get("table") or {}).get("columns") or []
        match = next((t for t in dom_tables if [h for h in t["headers"]] == [col["label"] for col in cols]), None)
        if match is None:
            failures.append(f"table '{c['id']}': no DOM table with headers {[col['label'] for col in cols]}")
            continue
        dom_tables.remove(match)
        if len(match["rows"]) != want:
            failures.append(f"table '{c['id']}': {len(match['rows'])} DOM rows, SQL returned {len(rows)} (page_rows={page})")
        empty = [(i, j) for i, r in enumerate(match["rows"]) for j, cell in enumerate(r) if cell in ("", "—")]
        if want and empty:
            failures.append(f"table '{c['id']}': {len(empty)} empty cell(s), first at row/col {empty[0]}")
        if want and match["rows"]:
            first_sql = rows[0]
            first_dom = match["rows"][0]
            key0 = cols[0]["key"] if cols else None
            if key0 and str(first_sql.get(key0)) not in first_dom[0]:
                failures.append(f"table '{c['id']}': first cell {first_dom[0]!r} does not show SQL value {first_sql.get(key0)!r}")

    kpis = [c for c in charts.values() if c["kind"] == "kpi"]
    if kpis and not report["kpis"]:
        failures.append(f"{len(kpis)} KPI(s) in board but no KPI text rendered")
    for c in kpis:
        label = (c.get("kpi") or {}).get("label") or {}
        label_text = " ".join(label.get("lines", [])) if isinstance(label, dict) else str(label)
        if label_text and not any(label_text.split()[0].lower() in k.lower() for k in report["kpis"]):
            failures.append(f"KPI '{c['id']}': label {label_text!r} not found in rendered text")

    vega = [c for c in charts.values() if c["kind"] == "vega"]
    if report["vega_charts"] != len(vega):
        failures.append(f"expected {len(vega)} Vega chart(s) mounted, DOM has {report['vega_charts']}")

    summary = f"{board}: {len(charts)} charts, {len(rows_by_sql)} queries, tables={len(report['tables'])} rows={[len(t['rows']) for t in report['tables']]} kpi_texts={len(report['kpis'])} vega={report['vega_charts']}"
    print(("FAIL " if failures else "PASS ") + summary)
    return failures


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    project_dir = Path(sys.argv[1]).resolve()
    os.chdir(project_dir)
    os.environ.setdefault("DBT_PROFILES_DIR", str(project_dir))
    if not (HERE / "node_modules").exists():
        subprocess.run(["npm", "install", "--silent"], cwd=HERE, check=True)
    bad = 0
    for board in sys.argv[2:]:
        failures = run_board(project_dir, board)
        for f in failures:
            print("   -", f)
        bad += bool(failures)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
