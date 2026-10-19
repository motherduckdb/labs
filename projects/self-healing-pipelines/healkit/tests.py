"""Data tests from pipelines/<p>/tests.yaml. Error-severity failures fail the run; warn-severity only log.

    tests:
      - {name: pk_unique, type: unique, asset: p1_wiki.pageviews, columns: [article, day], severity: error}
      - {name: views_not_null, type: not_null, asset: p1_wiki.pageviews, columns: [views]}
      - {name: unit_ok, type: accepted_values, asset: p2_nws.forecast_periods, column: temperature_unit, values: [F, C]}
      - {name: loaded_rows, type: volume, asset: p1_wiki.pageviews, min_ratio: 0.3, max_ratio: 3.0, severity: warn}
      - {name: fresh, type: freshness, asset: p2_nws.forecast_periods, column: fetched_at, max_age_hours: 6}
      - {name: shape, type: contract, asset: p2_nws.forecast_periods, columns: {temperature: DOUBLE, temperature_unit: VARCHAR}}
      - {name: row_min, type: row_count_min, asset: ..., min: 1}
      - {name: custom, type: sql, asset: ..., sql: "SELECT count(*) FROM {asset} WHERE ..."}   # failing rows

Severity is part of the contract: the fixer's patch rules forbid lowering it or deleting a test.
"""
import pathlib
from dataclasses import dataclass

import yaml

from . import events
from .db import data_db

ROOT = pathlib.Path(__file__).resolve().parent.parent


class DataTestFailed(Exception):
    pass


@dataclass
class Result:
    name: str
    type: str
    asset: str
    severity: str
    passed: bool
    failing: int
    message: str


def load(pipeline: str) -> list[dict]:
    path = ROOT / "pipelines" / pipeline / "tests.yaml"
    return (yaml.safe_load(path.read_text()) or {}).get("tests", []) if path.exists() else []


def record_volume(con, asset: str, rows_loaded: int):
    """Called by a pipeline after each load so `volume` tests have a trailing baseline."""
    schema = asset.split(".")[0]
    con.execute(f"CREATE TABLE IF NOT EXISTS {data_db()}.{schema}._load_stats (asset VARCHAR, ts TIMESTAMPTZ DEFAULT now(), rows_loaded BIGINT)")
    con.execute(f"INSERT INTO {data_db()}.{schema}._load_stats (asset, rows_loaded) VALUES (?, ?)", [asset, rows_loaded])


def _q(asset: str) -> str:
    return f"{data_db()}.{asset}"


def _run_one(con, t: dict) -> Result:
    kind, asset, sev = t["type"], t["asset"], t.get("severity", "error")
    tbl = _q(asset)
    failing, msg = 0, ""
    if kind == "unique":
        cols = ", ".join(t["columns"])
        failing = con.execute(f"SELECT coalesce(sum(n - 1), 0) FROM (SELECT count(*) AS n FROM {tbl} GROUP BY {cols} HAVING n > 1)").fetchone()[0]
        msg = f"{failing} duplicate rows on ({cols}) in {asset}"
    elif kind == "not_null":
        cond = " OR ".join(f"{c} IS NULL" for c in t["columns"])
        failing = con.execute(f"SELECT count(*) FROM {tbl} WHERE {cond}").fetchone()[0]
        total = con.execute(f"SELECT count(*) FROM {tbl}").fetchone()[0]
        msg = f"{failing} of {total} rows have NULL in ({', '.join(t['columns'])}) in {asset}"
    elif kind == "accepted_values":
        vals = t["values"]
        failing = con.execute(f"SELECT count(*) FROM {tbl} WHERE {t['column']} IS NOT NULL AND {t['column']}::VARCHAR NOT IN (SELECT unnest(?::VARCHAR[]))", [vals]).fetchone()[0]
        bad = con.execute(f"SELECT DISTINCT {t['column']}::VARCHAR FROM {tbl} WHERE {t['column']} IS NOT NULL AND {t['column']}::VARCHAR NOT IN (SELECT unnest(?::VARCHAR[])) LIMIT 5", [vals]).fetchall()
        msg = f"{failing} rows in {asset}.{t['column']} outside accepted values {vals}; e.g. {[b[0][:80] for b in bad]}"
    elif kind == "row_count_min":
        n = con.execute(f"SELECT count(*) FROM {tbl}").fetchone()[0]
        failing = int(n < t.get("min", 1))
        msg = f"{asset} has {n} rows, expected at least {t.get('min', 1)}"
    elif kind == "volume":
        schema = asset.split(".")[0]
        rows = con.execute(f"""SELECT rows_loaded FROM {data_db()}.{schema}._load_stats WHERE asset = ? ORDER BY ts DESC LIMIT 11""", [asset]).fetchall()
        if len(rows) >= 4:
            cur, base = rows[0][0], sorted(r[0] for r in rows[1:])[len(rows[1:]) // 2]
            ratio = cur / base if base else (0 if cur == 0 else float("inf"))
            failing = int(not (t.get("min_ratio", 0.3) <= ratio <= t.get("max_ratio", 3.0)))
            msg = f"{asset} loaded {cur} rows vs trailing median {base} (ratio {ratio:.2f})"
        else:
            msg = f"{asset}: not enough history for a volume baseline ({len(rows)} loads)"
    elif kind == "freshness":
        age = con.execute(f"SELECT date_diff('minute', max({t['column']})::TIMESTAMPTZ, now()) FROM {tbl}").fetchone()[0]
        failing = int(age is None or age > 60 * t["max_age_hours"])
        msg = f"{asset}.{t['column']} newest value is {age} minutes old (max {60 * t['max_age_hours']})"
    elif kind == "contract":
        actual = dict(con.execute(f"""SELECT column_name, data_type FROM duckdb_columns()
            WHERE database_name = ? AND schema_name = ? AND table_name = ?""", [data_db(), *asset.split(".")]).fetchall())
        problems = [f"{c}: expected {ty}, got {actual.get(c, 'MISSING')}" for c, ty in t["columns"].items()
                    if actual.get(c, "MISSING").upper() != ty.upper()]
        failing = len(problems)
        msg = f"contract {asset}: " + ("; ".join(problems) if problems else "ok")
    elif kind == "sql":
        failing = con.execute(t["sql"].format(asset=tbl, db=data_db())).fetchone()[0]
        msg = f"{t['name']}: {failing} failing rows in {asset}"
    else:
        raise ValueError(f"unknown test type {kind}")
    return Result(t["name"], kind, asset, sev, failing == 0, int(failing), msg)


def run(con, pipeline: str, only_assets: set[str] | None = None) -> list[Result]:
    results = []
    for t in load(pipeline):
        if only_assets and t["asset"] not in only_assets:
            continue
        try:
            r = _run_one(con, t)
        except Exception as e:
            r = Result(t["name"], t["type"], t["asset"], t.get("severity", "error"), False, -1,
                       f"test {t['name']} could not run: {type(e).__name__}: {str(e).splitlines()[0][:300]}")
        results.append(r)
        print(f"  test {'PASS' if r.passed else r.severity.upper()} {r.name}: {r.message}", flush=True)
        if not r.passed:
            events.emit("test", r.severity, r.message, asset=r.asset, test=f"{r.type}:{r.name}",
                        error_type="DataTestFailed",
                        detail={"failing": r.failing, "upstream_assets": t.get("upstream_assets")})
    failed = [r for r in results if not r.passed and r.severity == "error"]
    if failed:
        raise DataTestFailed("; ".join(r.message for r in failed))
    return results


def quarantine(con, staging: str, asset: str, where: str, reason: str) -> int:
    """Move rows matching `where` out of a TEMP staging table into <asset>__quarantine before the load.

    Quarantine happens on staging so a production table is never deleted from; the rows stay
    inspectable with the reason and time they were held back. Returns rows moved.
    """
    qtbl = _q(asset) + "__quarantine"
    con.execute(f"CREATE TABLE IF NOT EXISTS {qtbl} AS SELECT *, ''::VARCHAR AS _q_reason, now() AS _q_ts FROM {staging} LIMIT 0")
    n = con.execute(f"SELECT count(*) FROM {staging} WHERE {where}").fetchone()[0]
    if n:
        con.execute(f"INSERT INTO {qtbl} BY NAME SELECT *, ? AS _q_reason, now() AS _q_ts FROM {staging} WHERE {where}", [reason])
        con.execute(f"DELETE FROM {staging} WHERE {where}")
        events.emit("info", "info", f"quarantined {n} rows from {asset}: {reason}", asset=asset, test="quarantine",
                    detail={"rows": n, "where": where})
    return n
