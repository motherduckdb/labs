"""Watchdog Flight: keeps the checker alive. Deterministic: no LLM, no harness, no Jev, no OpenRouter.

Runs from a pinned release tag (watchdog-v*), never the base branch, so one bad merge can't break the
checker and the watchdog together; the loader falls back to cached code if GitHub is down.

Each tick:
 1. kill switch on, or today's fixer spend over the cap -> pause dispatch, cancel running fixers,
    open an issue, stop. (Unpauses when both clear, if the watchdog was the one that paused.)
 2. checker healthy (fresh heartbeat, last run OK) -> heartbeat
 3. checker run stuck -> cancel it and restart
 4. checker run failed or missed -> restart once (at most one automatic restart per hour)
 5. still failing after 2 in a row -> GitHub issue + an L3 fixer incident for healer code
 6. independently: fixer runs older than the runtime cap are cancelled and their lease released
"""
import json
import os
from datetime import datetime, timezone

from healkit import db, flights
from healkit.gh import GitHub
from healkit.registry import registry

S = db.STATE_DB
STALE_S = int(os.environ.get("HEAL_CHECKER_STALE_S", "1800"))
STUCK_S = int(os.environ.get("HEAL_CHECKER_STUCK_S", "900"))
FIXER_CAP_S = int(os.environ.get("HEAL_FIXER_RUNTIME_CAP_S", "2700"))
ACTIVE = ("PENDING", "QUEUED", "STARTING", "RUNNING")
log = []


def say(msg):
    log.append(msg)
    print(msg, flush=True)


def ctl(con):
    return dict(con.execute(f"SELECT key, value FROM {S}.main.control").fetchall())


def set_ctl(con, key, value):
    con.execute(f"INSERT OR REPLACE INTO {S}.main.control (key, value, updated_at, updated_by) VALUES (?, ?, now(), 'watchdog')", [key, value])


def age_s(ts):
    return None if ts is None else (datetime.now(timezone.utc) - ts).total_seconds()


def issue_once(con, key, title, body):
    if ctl(con).get(key):
        return
    g = GitHub(registry()["repo"])
    num = None
    if g.enabled:
        try:
            num = g.create_issue(title, body, ["heal", "healer:watchdog", "category:healer-and-platform"])["number"]
        except Exception as e:
            say(f"could not open issue: {e}")
    set_ctl(con, key, str(num or "local"))
    say(f"issue: {title} -> #{num}")


def cancel_running_fixers(con, fixer_id, why):
    for r in flights.runs(con, fixer_id, limit=20):
        if r["status"] in ACTIVE:
            flights.cancel(con, fixer_id, r["run_number"])
            inc = (r.get("config") or {}).get("INCIDENT_ID")
            con.execute(f"UPDATE {S}.main.fixer_runs SET status = 'cancelled', ended_at = now(), outcome = 'cancelled' WHERE flight_run_number = ?",
                        [r["run_number"]])
            if inc:
                con.execute(f"UPDATE {S}.main.incidents SET lease_expires = now() - INTERVAL 1 SECOND, lease_owner = NULL WHERE incident_id = ?", [int(inc)])
            say(f"cancelled fixer run {r['run_number']} (incident {inc}): {why}")


def guard_spend(con, fixer_id) -> bool:
    c = ctl(con)
    spent = con.execute(f"SELECT coalesce(sum(cost_usd), 0) FROM {S}.main.fixer_runs WHERE started_at >= current_date").fetchone()[0]
    cap = float(c.get("daily_spend_cap_usd", 50))
    tripped = c.get("kill_switch") == "on" or spent >= cap
    if tripped:
        why = "kill switch on" if c.get("kill_switch") == "on" else f"daily fixer spend ${spent:.2f} >= cap ${cap:.2f}"
        if c.get("dispatch_paused") != "on":
            set_ctl(con, "dispatch_paused", "on")
            set_ctl(con, "dispatch_paused_by", "watchdog")
        if fixer_id:
            cancel_running_fixers(con, fixer_id, why)
        issue_once(con, "watchdog_guard_issue", f"[heal] dispatch paused: {why}",
                   f"The watchdog paused fixer dispatch and cancelled running fixers.\n\nReason: {why}.\n"
                   "Clear `kill_switch` / wait for the next day (or raise `daily_spend_cap_usd`) in `heal.control` to resume.")
        say(f"guard tripped: {why}")
        return True
    if c.get("dispatch_paused") == "on" and c.get("dispatch_paused_by") == "watchdog":
        set_ctl(con, "dispatch_paused", "off")
        con.execute(f"DELETE FROM {S}.main.control WHERE key IN ('dispatch_paused_by', 'watchdog_guard_issue')")
        say("guard cleared: dispatch resumed")
    return False


def fixer_runtime_cap(con, fixer_id):
    for r in flights.runs(con, fixer_id, limit=20):
        a = age_s(r.get("started_at"))
        if r["status"] in ACTIVE and a and a > FIXER_CAP_S * 1.1:
            flights.cancel(con, fixer_id, r["run_number"])
            con.execute(f"UPDATE {S}.main.fixer_runs SET status = 'failed', outcome = 'runtime_cap', ended_at = now() WHERE flight_run_number = ?",
                        [r["run_number"]])
            inc = (r.get("config") or {}).get("INCIDENT_ID")
            if inc:
                con.execute(f"UPDATE {S}.main.incidents SET lease_expires = now() - INTERVAL 1 SECOND, lease_owner = NULL WHERE incident_id = ?", [int(inc)])
            say(f"fixer run {r['run_number']} over runtime cap ({a:.0f}s); cancelled, lease released")


def restart_checker(con, checker_id, why) -> bool:
    last = con.execute(f"SELECT value FROM {S}.main.control WHERE key = 'watchdog_last_restart'").fetchone()
    if last and age_s(datetime.fromisoformat(last[0])) < 3600:
        say(f"checker needs a restart ({why}) but one already happened within the hour")
        return False
    r = flights.trigger(con, checker_id)
    set_ctl(con, "watchdog_last_restart", datetime.now(timezone.utc).isoformat())
    say(f"restarted checker (run {r['run_number']}): {why}")
    return True


def escalate_checker(con, fixer_id, why):
    issue_once(con, "watchdog_checker_issue", "[heal] checker keeps failing",
               f"The checker has not recovered after an automatic restart.\n\n{why}\n\nAn L3 fixer was dispatched for healer code.")
    if con.execute(f"SELECT 1 FROM {S}.main.incidents WHERE class = 'healer_checker_fault' AND status NOT IN ('resolved')").fetchone():
        return
    inc_id = con.execute(f"""INSERT INTO {S}.main.incidents (status, pipeline, pipelines, class, category, disposition, severity, level, title,
                             fingerprint, last_event_at) VALUES ('open', 'healer', ['healer'], 'healer_checker_fault', 'healer-and-platform',
                             'fix', 'high', 'L3', ?, 'healer-checker', now()) RETURNING incident_id""", [f"checker failing: {why[:120]}"]).fetchone()[0]
    con.execute(f"INSERT INTO {S}.main.incident_transitions (incident_id, from_status, to_status, reason, actor) VALUES (?, NULL, 'open', ?, 'watchdog')",
                [inc_id, why[:500]])
    if fixer_id and ctl(con).get("dispatch_paused") != "on":
        r = flights.trigger(con, fixer_id, {"INCIDENT_ID": inc_id, "AUTONOMY": "L3", "MODE": "fix", "ATTEMPT": 1})
        con.execute(f"""UPDATE {S}.main.incidents SET status = 'investigating', attempts = 1, lease_owner = ?,
                        lease_expires = now() + INTERVAL 15 MINUTE WHERE incident_id = ?""", [f"fixer-run:{r['run_number']}", inc_id])
        con.execute(f"INSERT INTO {S}.main.incident_transitions (incident_id, from_status, to_status, reason, actor) VALUES (?, 'open', 'investigating', ?, 'watchdog')",
                    [inc_id, f"L3 fixer dispatched (run {r['run_number']})"])
        say(f"dispatched L3 fixer run {r['run_number']} for healer incident {inc_id}")


def main():
    con = db.connect()
    by_name = flights.by_name(con)
    h = registry()["healer"]
    checker_id = (by_name.get(h["checker"]["flight_name"]) or {}).get("flight_id")
    fixer_id = (by_name.get(h["fixer"]["flight_name"]) or {}).get("flight_id")
    state = "ok"
    if guard_spend(con, fixer_id):
        state = "guard"
    else:
        if fixer_id:
            fixer_runtime_cap(con, fixer_id)
        if checker_id:
            runs = flights.runs(con, checker_id, limit=10)
            hb = con.execute(f"SELECT max(ts) FROM {S}.main.heartbeats WHERE component = 'checker'").fetchone()[0]
            hb_age = age_s(hb)
            done = [r for r in runs if r["status"] in flights.TERMINAL]
            active = [r for r in runs if r["status"] in ACTIVE]
            consecutive_fail = 0
            for r in done:
                if r["status"] == "SUCCEEDED":
                    break
                consecutive_fail += 1
            stuck = [r for r in active if r["status"] == "RUNNING" and (age_s(r.get("started_at")) or 0) > STUCK_S]
            if stuck:
                state = "stuck"
                for r in stuck:
                    flights.cancel(con, checker_id, r["run_number"])
                    say(f"checker run {r['run_number']} stuck for {age_s(r['started_at']):.0f}s; cancelled")
                restart_checker(con, checker_id, "stuck run cancelled")
            elif consecutive_fail >= 2:
                state = "failing"
                escalate_checker(con, fixer_id, f"{consecutive_fail} consecutive failed checker runs (last #{done[0]['run_number']})")
            elif consecutive_fail == 1 and not active:
                state = "failed"
                restart_checker(con, checker_id, f"last checker run #{done[0]['run_number']} {done[0]['status']}")
            elif (hb_age is None or hb_age > STALE_S) and not active:
                state = "silent"
                if not restart_checker(con, checker_id, f"no checker heartbeat for {hb_age or 'ever'} s (missed runs)"):
                    escalate_checker(con, fixer_id, f"checker silent for {hb_age} s and the hourly restart is used up")
            elif consecutive_fail == 0:
                con.execute(f"DELETE FROM {S}.main.control WHERE key = 'watchdog_checker_issue'")
    ctx = db.run_context()
    con.execute(f"INSERT INTO {S}.main.heartbeats (component, run_number, sha, detail) VALUES ('watchdog', ?, ?, ?::JSON)",
                [ctx["run_number"], ctx["sha"], json.dumps({"state": state, "log": log})])
    print(f"watchdog tick: {state}", flush=True)


if __name__ == "__main__":
    main()
