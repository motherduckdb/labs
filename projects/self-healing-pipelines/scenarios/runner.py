"""Chaos runner: execute scenarios from scenarios.yaml against the deployed Flights and score them.

    source ~/.config/self-healing/env.sh
    uv run --with duckdb==1.5.6 --with pytz --with pyyaml --with requests python scenarios/runner.py S03 S06 --level L1 --campaign c1

Per scenario: reset world (+ retire code patches unless the scenario `requires` earlier ones) -> set
controls (autonomy_cap = --level) -> inject -> run the pipelines -> tick the checker until every
incident opened since injection settles (resolved / escalated / proposed, or watching with no
change) -> score against `expect` -> heal.eval.scenario_runs. The runner drives the checker itself
(one Flight run per tick), so no schedule has to be left enabled.
"""
import argparse
import json
import pathlib
import subprocess
import sys
import time
from datetime import datetime, timezone

import duckdb
import yaml

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from healkit import flights  # noqa: E402
from healkit.registry import registry  # noqa: E402

SC = yaml.safe_load((ROOT / "scenarios/scenarios.yaml").read_text())["scenarios"]
SETTLED = {"resolved", "escalated", "proposed"}
con = duckdb.connect("md:")
con.execute("SET TimeZone='UTC'")
NAMES = {**{k: v["flight_name"] for k, v in registry()["pipelines"].items()}, **{k: v["flight_name"] for k, v in registry()["healer"].items()}}


def fid(name):
    return flights.by_name(con)[NAMES.get(name, name)]["flight_id"]


def log(msg):
    print(f"[{datetime.now():%H:%M:%S}] {msg}", flush=True)


def run_and_wait(name, cfg=None, timeout=1500):
    f = fid(name)
    r = flights.trigger(con, f, cfg)
    t0 = time.time()
    while time.time() - t0 < timeout:
        st = next((x["status"] for x in flights.runs(con, f, limit=10) if x["run_number"] == r["run_number"]), "?")
        if st in flights.TERMINAL:
            return st
        time.sleep(5)
    return "TIMEOUT"


def set_control(kv):
    for k, v in kv.items():
        con.execute("INSERT OR REPLACE INTO heal.main.control (key, value, updated_at, updated_by) VALUES (?, ?, now(), 'runner')", [k, str(v)])


def human_patch(spec, scenario):
    """Direct mode: a 'human deploy' that changes pipeline code is an active code_patch with no incident."""
    ref = registry()["base_branch"]
    work = pathlib.Path("/tmp/heal_runner_repo")
    subprocess.run(f"rm -rf {work} && git clone -q --depth 5 --branch {ref} https://github.com/{registry()['repo']} {work}", shell=True, check=True)
    for pid, patch in con.execute("SELECT patch_id, patch FROM heal.main.code_patches WHERE ref = ? AND status = 'active' ORDER BY patch_id", [ref]).fetchall():
        (work / f"p{pid}.diff").write_text(patch)
        subprocess.run(["git", "-C", str(work), "apply", f"p{pid}.diff"], check=True)
        (work / f"p{pid}.diff").unlink()
    path = work / registry()["project_path"] / "pipelines" / spec["pipeline"] / "main.py"
    old, new = spec["replace"]
    text = path.read_text()
    if old not in text:
        raise SystemExit(f"{scenario}: text to replace not found in {path}")
    path.write_text(text.replace(old, new))
    patch = subprocess.run(["git", "-C", str(work), "diff"], capture_output=True, text=True, check=True).stdout
    pid = con.execute("""INSERT INTO heal.main.code_patches (incident_id, ref, base_sha, patch, status, title, activated_at)
                         VALUES (NULL, ?, 'runner', ?, 'active', ?, now()) RETURNING patch_id""",
                      [ref, patch, f"{scenario}: human deploy ({spec['pipeline']})"]).fetchone()[0]
    log(f"{scenario}: injected code change as active patch {pid}")
    return pid


def inject(name, s):
    inj = s.get("inject") or {}
    for w in inj.get("world", []):
        con.execute("INSERT OR REPLACE INTO heal_chaos.main.world (pipeline, knob, value, runs_remaining, scenario) VALUES (?, ?, ?, ?, ?)",
                    [w["pipeline"], w["knob"], w["value"], w.get("runs"), name])
    if inj.get("sql"):
        con.execute(inj["sql"])
    if inj.get("control"):
        set_control(inj["control"])
    if inj.get("commit"):
        human_patch(inj["commit"], name)
    if inj.get("same_as"):
        inject(name, SC[inj["same_as"]])
    if inj.get("issue"):
        subprocess.run(["gh", "issue", "create", "-R", registry()["fixtures_repo"], "-t", inj["issue"]["title"], "-b", inj["issue"]["body"]],
                       check=True, capture_output=True)
        log(f"{name}: created fixtures issue")
    if inj.get("bad_fix_for"):
        seed_bad_fix(name, inj["bad_fix_for"])
    return inj.get("run_config") or {}


def seed_bad_fix(name, of):
    """S13: re-break the code an earlier scenario fixed and record it as that incident's (bad) fix."""
    inc = con.execute("""SELECT i.incident_id, i.fix_sha FROM heal.main.incidents i WHERE i.scenario = ? AND i.status = 'resolved'
                         ORDER BY incident_id DESC LIMIT 1""", [of]).fetchone()
    if not inc or not (inc[1] or "").startswith("direct:"):
        raise SystemExit(f"{name}: needs a resolved {of} incident with a direct patch")
    pid = int(inc[1].split(":")[1])
    # The bad "auto-fix": deactivate the good patch and activate a no-op patch recorded as the incident's fix.
    con.execute("UPDATE heal.main.code_patches SET status = 'reverted', reason = 'S13 seeded bad fix' WHERE patch_id = ?", [pid])
    bad = con.execute("""INSERT INTO heal.main.code_patches (incident_id, ref, base_sha, patch, status, title, activated_at)
                         VALUES (?, ?, 'runner', '', 'active', 'S13 seeded bad fix (drops the parse fix)', now()) RETURNING patch_id""",
                      [inc[0], registry()["base_branch"]]).fetchone()[0]
    con.execute("UPDATE heal.main.incidents SET fix_sha = ? WHERE incident_id = ?", [f"direct:{bad}", inc[0]])
    log(f"{name}: seeded bad fix patch {bad} for incident {inc[0]} (good patch {pid} reverted)")


def reset(s):
    con.execute("DELETE FROM heal_chaos.main.world")
    for sql in [x.get("cleanup_sql") for x in SC.values() if x.get("cleanup_sql")]:
        con.execute(sql)
    keep = set(s.get("requires") or [])
    if not keep:
        n = con.execute("""UPDATE heal.main.code_patches SET status = 'retired', reason = 'runner reset to baseline code'
                           WHERE status IN ('active', 'proposed') RETURNING patch_id""").fetchall()
        if n:
            log(f"retired {len(n)} code patches (baseline code)")
    set_control({"checker_force_fail": "off", "kill_switch": "off", "dispatch_paused": "off", "budget_usd": "10", "max_attempts": "2"})


def incidents_since(t0):
    cur = con.execute("SELECT * FROM heal.main.incidents WHERE created_at >= ? ORDER BY incident_id", [t0])
    cols = [d[0] for d in cur.description]
    return [dict(zip(cols, r)) for r in cur.fetchall()]


def settle(name, t0, timeout_s, quiet_ticks):
    """Tick the checker until incidents opened since t0 settle. A watching incident with no fixer counts
    as settled after `quiet_ticks` ticks without change (transients that the checker keeps re-running)."""
    deadline, last, same = time.time() + timeout_s, None, 0
    while time.time() < deadline:
        st = run_and_wait("checker")
        incs = incidents_since(t0)
        fixers = [r for r in flights.runs(con, fid("fixer"), limit=5) if r["status"] not in flights.TERMINAL]
        snap = [(i["incident_id"], i["status"], i["event_count"], i["green_runs"]) for i in incs]
        log(f"{name}: checker {st}; incidents {snap}; fixers running {len(fixers)}")
        if fixers:
            same = 0
            time.sleep(30)
            continue
        same = same + 1 if snap == last else 0
        last = snap
        if incs and all(i["status"] in SETTLED for i in incs):
            return incs
        if same >= quiet_ticks:
            return incs
        time.sleep(20)
    log(f"{name}: settle timeout")
    return incidents_since(t0)


def score(name, s, incs, t0, level):
    exp = s.get("expect", {})
    obs, checks = {}, {}
    roots = [i for i in incs if i["pipeline"] != "healer"]
    obs["incidents"] = len(roots)
    obs["statuses"] = {i["incident_id"]: i["status"] for i in roots}
    if "incidents" in exp:
        checks["incident_count"] = obs["incidents"] == exp["incidents"]
    if roots:
        r = roots[0]
        obs.update(category=r["category"], cls=r["class"], disposition=r["disposition"], level=r["level"], muted=r["muted"],
                   pipelines=r["pipelines"], event_count=r["event_count"], attempts=r["attempts"], cost=r["cost_usd"])
        if "category" in exp:
            checks["category"] = r["category"] == exp["category"]
        if "classes" in exp:
            checks["class"] = r["class"] in exp["classes"]
        if "action" in exp:
            checks["action"] = r["disposition"] == exp["action"]
        if "by_level" in exp and level in exp["by_level"]:
            want = exp["by_level"][level]
            done = con.execute("SELECT count(*) FROM heal.main.incident_transitions WHERE incident_id = ? AND to_status = ?",
                               [r["incident_id"], want]).fetchone()[0]
            checks[f"reached_{want}"] = done > 0
            if want == "merged":
                checks["resolved_after_fix"] = r["status"] == "resolved"
        if exp.get("resolves_without_fixer"):
            checks["resolved_without_fixer"] = r["status"] == "resolved" and (r["attempts"] or 0) == 0
        if "symptoms_grouped" in exp:
            checks["symptoms_grouped"] = set(exp["symptoms_grouped"]) <= set(r["pipelines"] or [])
        if "pipelines" in exp:
            checks["shared_resource_grouped"] = set(exp["pipelines"]) <= set(r["pipelines"] or [])
        if "event_count" in exp:
            checks["event_count"] = r["event_count"] >= exp["event_count"]
        if "muted" in exp:
            checks["muted"] = bool(r["muted"]) == exp["muted"]
        if "fixers" in exp:
            n = con.execute("SELECT count(*) FROM heal.main.fixer_runs WHERE incident_id = ?", [r["incident_id"]]).fetchone()[0]
            obs["fixers"] = n
            checks["fixers"] = n == exp["fixers"]
        if "final_status" in exp:
            checks["final_status"] = r["status"] == exp["final_status"]
        if "attempts" in exp:
            checks["attempts"] = (r["attempts"] or 0) >= exp["attempts"]
    elif "fixers" in exp:
        checks["fixers"] = exp["fixers"] == 0
    if "guard_violations" in exp:
        v = con.execute("""SELECT count(*) FROM heal.main.actions a JOIN heal.main.fixer_runs f USING (fixer_run_id)
                           WHERE f.started_at >= ? AND a.kind = 'guard' AND a.verdict = 'violations'""", [t0]).fetchone()[0]
        obs["guard_violations"] = v
        checks["no_guard_violations"] = v == 0
    if exp.get("quarantined"):
        q = con.execute("SELECT count(*) FROM heal_lake.p3_github.issues__quarantine WHERE _q_ts >= ?", [t0]).fetchone()[0]
        obs["quarantined"] = q
        checks["quarantined"] = q > 0
    if exp.get("fallback_ran"):
        fb = con.execute("SELECT count(*) FROM heal.main.classifications WHERE ts >= ? AND fallback_ran", [t0]).fetchone()[0]
        obs["fallbacks"] = fb
        checks["fallback_ran"] = fb > 0
    if "link" in exp or "links_exactly" in exp or "guide_reads_include" in exp:
        score_memory(exp, roots, obs, checks)
    cost = con.execute("SELECT coalesce(sum(cost_usd), 0) FROM heal.main.fixer_runs WHERE started_at >= ?", [t0]).fetchone()[0]
    det = con.execute("""SELECT min(ts) FROM heal.main.events WHERE ts >= ?""", [t0]).fetchone()[0]
    res = con.execute("SELECT max(resolved_at) FROM heal.main.incidents WHERE created_at >= ?", [t0]).fetchone()[0]
    return obs, checks, cost, det, res


def guide_of(scen):
    row = con.execute("""SELECT guide_id::VARCHAR FROM heal.main.incidents WHERE scenario = ? AND guide_id IS NOT NULL
                         ORDER BY incident_id DESC LIMIT 1""", [scen]).fetchone()
    return row[0] if row else None


def score_memory(exp, roots, obs, checks):
    if not roots:
        return
    inc = roots[0]["incident_id"]
    reads = {r[0] for r in con.execute("SELECT guide_id::VARCHAR FROM heal.main.guide_reads WHERE incident_id = ?", [inc]).fetchall()}
    links = {(r[0], r[1]) for r in con.execute("SELECT to_guide_id::VARCHAR, how_used FROM heal.main.guide_links WHERE incident_id = ?", [inc]).fetchall()}
    obs["guide_reads"], obs["guide_links"] = sorted(reads), sorted(links)
    if "link" in exp:
        g = guide_of(exp["link"]["to"])
        checks["guide_read"] = g in reads
        checks["link_reused_fix"] = (g, exp["link"]["how_used"]) in links
    if "guide_reads_include" in exp:
        checks["guide_reads"] = all(guide_of(s) in reads for s in exp["guide_reads_include"])
    if "links_exactly" in exp:
        want = {guide_of(s) for s in exp["links_exactly"]}
        checks["link_precision"] = {g for g, _ in links} == want


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("scenarios", nargs="+")
    ap.add_argument("--level", default="L1", choices=["L1", "L2", "L3"])
    ap.add_argument("--campaign", default=datetime.now(timezone.utc).strftime("c%Y%m%d%H%M"))
    ap.add_argument("--timeout", type=int, default=3600)
    ap.add_argument("--quiet-ticks", type=int, default=4)
    a = ap.parse_args()
    for name in a.scenarios:
        s = SC[name]
        log(f"=== {name} ({a.level}): {s['title']}")
        reset(s)
        set_control({"autonomy_cap": a.level})
        t0 = con.execute("SELECT now()").fetchone()[0]
        run_cfg = inject(name, s)
        con.execute("UPDATE heal.main.control SET value = ? WHERE key = 'current_scenario'", [name])
        set_control({"current_scenario": name})
        for _ in range(s.get("repeat", 1)):
            for p in s.get("runs", []):
                st = run_and_wait(p, run_cfg.get(p))
                log(f"{name}: {p} -> {st}")
        # Tag incidents opened by this scenario (the answer key and S13/S19/S21 look them up by scenario).
        incs = settle(name, t0, a.timeout, a.quiet_ticks)
        con.execute("UPDATE heal.main.incidents SET scenario = ? WHERE created_at >= ? AND scenario IS NULL", [name, t0])
        incs = incidents_since(t0)
        obs, checks, cost, det, res = score(name, s, incs, t0, a.level)
        passed = all(checks.values()) if checks else False
        con.execute("""INSERT INTO heal.eval.scenario_runs (campaign, scenario, level, started_at, ended_at, injected_at, detected_at, resolved_at,
                       incident_ids, expected, observed, scores, passed, cost_usd) VALUES (?, ?, ?, ?, now(), ?, ?, ?, ?, ?::JSON, ?::JSON, ?::JSON, ?, ?)""",
                    [a.campaign, name, a.level, t0, t0, det, res, [i["incident_id"] for i in incs], json.dumps(s.get("expect")),
                     json.dumps(obs, default=str), json.dumps(checks), passed, cost])
        log(f"=== {name}: {'PASS' if passed else 'FAIL'} {checks} cost=${cost:.2f}")
    con.execute("DELETE FROM heal_chaos.main.world")
    set_control({"current_scenario": ""})


if __name__ == "__main__":
    main()
