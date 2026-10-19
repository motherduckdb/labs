"""Create or update every self-healing Flight (pipelines, checker, fixer, watchdog) from pipelines.yaml.

Each Flight stores only bootstrap/loader.py; the loader pulls the real code from git on every run.
Flights are found by name (owner_only), so ids never live in git.

    source ~/.config/self-healing/env.sh
    uv run --with duckdb==1.5.6 --with pytz --with pyyaml python scripts/deploy.py [--ref heal/dev] [--schedules test|default|off] [--only NAME ...]
"""
import argparse
import pathlib

import duckdb
import yaml

ROOT = pathlib.Path(__file__).resolve().parent.parent
REG = yaml.safe_load((ROOT / "pipelines.yaml").read_text())
LOADER = (ROOT / "bootstrap/loader.py").read_text()
REQS = (ROOT / "bootstrap/requirements.txt").read_text()
TOKEN_NAME = "self-healing-main"

FIXER_CONFIG = {
    "INCIDENT_ID": "0", "AUTONOMY": "L3", "MODE": "fix", "ATTEMPT": "1", "BUDGET_USD": "10", "APPROVER_ROUNDS": "2",
    "MODEL": "~anthropic/claude-opus-latest", "APPROVER_MODEL": "~openai/gpt-sol-latest", "RUNTIME_CAP_S": "2700",
    "OPENCODE_STEPS": "80", "HEAL_LEASE_S": "900", "HEAL_GITHUB_MODE": "direct",
}
CHECKER_CONFIG = {"HEAL_GREEN_RUNS": "2", "HEAL_WATCH_RUNS": "3", "HEAL_FLAP_WINDOW": "10", "HEAL_BACKOFF_BASE_S": "60",
                  "HEAL_LEASE_S": "900", "HEAL_WATCHDOG_SILENT_S": "1200", "HEAL_GITHUB_MODE": "direct"}
WATCHDOG_CONFIG = {"HEAL_CHECKER_STALE_S": "300", "HEAL_CHECKER_STUCK_S": "600", "HEAL_FIXER_RUNTIME_CAP_S": "2700"}


def components(ref: str):
    base = {"HEAL_REPO": REG["repo"], "HEAL_PROJECT_PATH": REG["project_path"], "HEAL_REF": ref}
    for name, p in REG["pipelines"].items():
        cfg = {**base, "HEAL_COMPONENT": name, "HEAL_ENTRY": p["entry"], "HEAL_PIPELINE": name}
        if name == "p4_usgs":
            cfg["RUN_BACKFILL_DAYS"] = "0"
        yield name, p["flight_name"], cfg, ["openrouter", *p.get("secrets", [])], None, 900
    h = REG["healer"]
    yield ("checker", h["checker"]["flight_name"], {**base, "HEAL_COMPONENT": "checker", "HEAL_ENTRY": h["checker"]["entry"], **CHECKER_CONFIG},
           ["openrouter", "github"], h["checker"], 600)
    yield ("fixer", h["fixer"]["flight_name"], {**base, "HEAL_COMPONENT": "fixer", "HEAL_ENTRY": h["fixer"]["entry"], **FIXER_CONFIG},
           ["openrouter", "github", "github_read"], None, h["fixer"]["max_runtime_sec"])
    yield ("watchdog", h["watchdog"]["flight_name"], {**base, "HEAL_REF": h["watchdog"]["ref"] if ref == REG["base_branch"] else ref,
                                                      "HEAL_COMPONENT": "watchdog", "HEAL_ENTRY": h["watchdog"]["entry"], **WATCHDOG_CONFIG},
           ["github"], h["watchdog"], 300)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ref", default=REG["base_branch"])
    ap.add_argument("--schedules", choices=["test", "default", "off"], default="off")
    ap.add_argument("--only", nargs="*")
    args = ap.parse_args()
    con = duckdb.connect("md:")
    con.execute("SET TimeZone='UTC'")
    secrets = {r[0] for r in con.execute("SELECT name FROM duckdb_secrets()").fetchall()}
    rows = con.execute("SELECT flight_id, flight_name, schedule_cron FROM MD_LIST_FLIGHTS(owner_only := true)").fetchall()
    existing = {r[1]: str(r[0]) for r in rows}
    current_cron = {r[1]: r[2] for r in rows}
    for comp, fname, cfg, want_secrets, sched, max_rt in components(args.ref):
        if args.only and comp not in args.only:
            continue
        have = [s for s in want_secrets if s in secrets]
        missing = sorted(set(want_secrets) - set(have))
        cron = None if (sched is None or args.schedules == "off") else sched[f"schedule_{args.schedules}"]
        params = dict(name=fname, source_code=LOADER, requirements_txt=REQS, config=cfg, flight_secret_names=have,
                      access_token_name=TOKEN_NAME, max_runtime_sec=max_rt)
        if fname in existing:
            fid = existing[fname]
            # Only touch the schedule when it changes; clearing a schedule that doesn't exist is an error.
            if (cron or None) != (current_cron.get(fname) or None):
                params["schedule_cron"] = cron or ""
            sets = ", ".join(f"{k} := ?" for k in params)
            con.execute(f"SELECT * FROM MD_UPDATE_FLIGHT(flight_id := ?::UUID, {sets})", [fid, *params.values()]).fetchall()
            action = "updated"
        else:
            sets = ", ".join(f"{k} := ?" for k in params)
            extra = ", schedule_cron := ?" if cron else ""
            fid = str(con.execute(f"SELECT flight_id FROM MD_CREATE_FLIGHT({sets}{extra})", [*params.values(), *([cron] if cron else [])]).fetchone()[0])
            action = "created"
        print(f"{action:8} {comp:18} {fname:24} {fid} cron={cron!r} secrets={have}" + (f" MISSING={missing}" if missing else ""))


if __name__ == "__main__":
    main()
