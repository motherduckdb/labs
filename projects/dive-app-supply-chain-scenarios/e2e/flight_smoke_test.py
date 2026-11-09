#!/usr/bin/env python3
"""Runs the Flight's backend (flight/planner.py) end to end on a local DuckDB
file, no MotherDuck needed: setup (static tables + seeds), then every op the
Dive sends, the way the Flight would run them.

  uv run --with duckdb==1.5.6 --with pytz python e2e/flight_smoke_test.py
"""
import json
import os
import sys
import tempfile
import threading

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "flight"))
import planner  # noqa: E402


class LocalStore(planner.Store):
    def __init__(self, path: str):
        import duckdb

        self.db = "scenario_planner"
        self.lock = threading.RLock()
        self.con = duckdb.connect(path)
        self._init_session()


def check(cond, msg):
    if not cond:
        raise SystemExit(f"FAIL: {msg}")
    print(f"ok  {msg}")


def main():
    with tempfile.TemporaryDirectory() as tmp:
        store = LocalStore(os.path.join(tmp, "scenario_planner.duckdb"))
        store.ensure_schema(lambda m: print(f"    {m}"))
        api = planner.Api(store)
        call = lambda op, args: api.call(op, json.loads(json.dumps(args)), "smoke")  # noqa: E731
        names = [s["name"] for s in api.scenario_rows()]
        check(names[0] == "Baseline" and len(names) == 5, f"seeded {names}")
        check(store.one('SELECT count(*) AS n FROM "scenario_planner".main.baseline_forecast')["n"] == 26 * 24, "26 weeks x 24 region-categories forecast")

        s = call("create_scenario", {"name": "Smoke test", "based_on": "baseline"})
        sid = s["scenario_id"]
        drivers = {**s["drivers"], "demand_upside_pct": 10, "expedite": {"speed": "1d", "capacity_pct": 25}}
        s = call("update_scenario", {"scenario_id": sid, "version": s["version"], "drivers": drivers})
        check(s["drivers"]["expedite"]["speed"] == "1d", "update_scenario saved the drivers")
        s = call("set_overrides", {"scenario_id": sid, "changes": [
            {"region": "West", "category": "Outerwear", "week_idx": 3, "units": 2500},
            {"region": "West", "category": "Denim", "week_idx": 4, "units": 0}]})
        check(len(s["overrides"]) == 2 and s["overrides"][0]["edited_by"] == "smoke" and s["overrides"][0]["edited_at"], "set_overrides stored who and when")
        s = call("set_overrides", {"scenario_id": sid, "changes": [{"region": "West", "category": "Denim", "week_idx": 4, "units": None}]})
        check(len(s["overrides"]) == 1, "a null clears an override")
        try:
            call("set_overrides", {"scenario_id": sid, "changes": [{"region": "Mars", "category": "Denim", "week_idx": 0, "units": 1}]})
            check(False, "a bad cell is rejected")
        except planner.ApiError as e:
            check(e.status == 400, f"a bad cell is rejected ({e.message})")

        s = call("set_status", {"scenario_id": sid, "status": "submitted", "version": s["version"]})
        check(s["status"] == "submitted", "submitted")
        s = call("set_status", {"scenario_id": sid, "status": "approved", "version": s["version"]})
        rows = store.q("SELECT count(*) AS n, sum(extra_cost) AS cost, sum(net_margin) AS net FROM approved_plan WHERE scenario_id = ?", [sid])[0]
        check(s["status"] == "approved" and rows["n"] == 26 * 24, f"approved: {rows['n']} plan rows, extra cost ${rows['cost']:,.0f}")
        r = call("push_to_erp", {"scenario_id": sid})
        check(r["lines"] > 0 and r["est_cost"] > 0, f"push_to_erp queued {r['lines']} lines (${r['est_cost']:,.0f}, 1-day at ${planner.engine.SPEEDS['1d']['cost']}/unit)")

        s = call("set_status", {"scenario_id": sid, "status": "draft", "version": s["version"]})
        call("delete_scenario", {"scenario_id": sid})
        check(sid not in [x["scenario_id"] for x in api.scenario_rows()], "reopened and deleted")
        acts = [a["action"] for a in store.q("SELECT action FROM activity_log ORDER BY ts")]
        check(acts == ["seed", "create", "drivers", "override", "override", "submitted", "approved", "erp", "draft", "delete"], f"activity log {acts}")
        store.con.close()
    print("PASS: the Flight backend handles every op on a fresh database")


if __name__ == "__main__":
    main()
