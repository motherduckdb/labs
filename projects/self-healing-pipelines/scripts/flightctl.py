"""Local control for the self-healing Flights.

    flightctl.py run NAME [NAME ...] [--wait] [--cfg K=V ...]   trigger runs (by flight name or component)
    flightctl.py logs NAME [--run N] [--n 80]                    tail a run's log (oldest first)
    flightctl.py runs NAME [--n 10]                              recent runs
"""
import argparse
import sys
import time

import duckdb
import yaml
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
from healkit import flights  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parent.parent
REG = yaml.safe_load((ROOT / "pipelines.yaml").read_text())


def resolve(con, name):
    names = {**{k: v["flight_name"] for k, v in REG["pipelines"].items()}, **{k: v["flight_name"] for k, v in REG["healer"].items()}}
    fname = names.get(name, name)
    f = flights.by_name(con).get(fname)
    if not f:
        sys.exit(f"no flight named {fname}")
    return f["flight_id"], fname


def wait(con, fid, rn, timeout=1800):
    t0 = time.time()
    while time.time() - t0 < timeout:
        r = next((r for r in flights.runs(con, fid, limit=20) if r["run_number"] == rn), None)
        if r and r["status"] in flights.TERMINAL:
            return r["status"]
        time.sleep(4)
    return "TIMEOUT"


def tail(con, fid, rn, n):
    return list(reversed(flights.logs(con, fid, rn, limit=n)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["run", "logs", "runs"])
    ap.add_argument("names", nargs="+")
    ap.add_argument("--wait", action="store_true")
    ap.add_argument("--run", type=int)
    ap.add_argument("--n", type=int, default=60)
    ap.add_argument("--cfg", nargs="*", default=[])
    a = ap.parse_args()
    con = duckdb.connect("md:")
    con.execute("SET TimeZone='UTC'")
    if a.cmd == "run":
        cfg = dict(kv.split("=", 1) for kv in a.cfg)
        started = []
        for name in a.names:
            fid, fname = resolve(con, name)
            r = flights.trigger(con, fid, cfg or None)
            print(f"{fname}: run {r['run_number']} {r['status']}", flush=True)
            started.append((name, fid, r["run_number"]))
        if a.wait:
            for name, fid, rn in started:
                st = wait(con, fid, rn)
                print(f"\n=== {name} run {rn}: {st}")
                for line in tail(con, fid, rn, a.n):
                    print("  " + line[:400])
    elif a.cmd == "logs":
        fid, _ = resolve(con, a.names[0])
        rn = a.run or flights.runs(con, fid, limit=1)[0]["run_number"]
        for line in tail(con, fid, rn, a.n):
            print(line[:500])
    else:
        for name in a.names:
            fid, fname = resolve(con, name)
            for r in flights.runs(con, fid, limit=a.n):
                print(f"{fname} #{r['run_number']} {r['status']:10} {r['started_at']} -> {r['ended_at']} cfg={r['config']}")


if __name__ == "__main__":
    main()
