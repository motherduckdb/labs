"""Checker Flight: detect -> classify -> group -> act. One tick per run, target < 30 s.

Per tick:
 1. heartbeat; honor checker_force_fail (scenario S17)
 2. new terminal runs of every pipeline / fixer flight (statuses as FAILED and RUN_STATUS_*)
 3. failed run -> HEAL_EVENTs (table, else the last 200 log lines, else the log tail) -> events
    -> grouping funnel -> attach or new incident (Jev class/disposition/severity, LLM fallback)
 4. green run -> watching/verifying/escalated incidents count green runs, resolve after K
 5. warn-level test events -> Jev "real problem or natural variation / intentional change?"
 6. merged -> verifying (+ trigger the verification run); watching -> backoff re-runs
 7. leases: expired -> re-dispatch (attempt+1) or escalate; fixer run failures release the lease
 8. dispatch fixers for queued incidents (kill switch, spend cap, concurrency cap)
 9. watchdog silence; `other`-category proposal job
The checker never treats its own fixer runs as pipeline failures (no self-trigger loop): they only
release leases and count as healer faults on the incident they were working on.
"""
import json
import os
import sys
import time
import traceback

from healkit import db, flights, jev
from healkit.registry import (category_of, class_info, effective_level, registry)

from healer.checker import grouping, lifecycle
from healer.checker.normalize import fingerprint, normalize
from healer.memory import guides

S = db.STATE_DB
K = int(os.environ.get("HEAL_GREEN_RUNS", registry()["defaults"]["green_runs_to_resolve"]))
N = int(os.environ.get("HEAL_WATCH_RUNS", registry()["defaults"]["watch_runs_before_fix"]))
FLAP_WINDOW = int(os.environ.get("HEAL_FLAP_WINDOW", "21"))
FLAP_RATE = float(os.environ.get("HEAL_FLAP_RATE", "0.3"))
BACKOFF_BASE_S = int(os.environ.get("HEAL_BACKOFF_BASE_S", "60"))
LEASE_S = int(os.environ.get("HEAL_LEASE_S", "900"))
WATCHDOG_SILENT_S = int(os.environ.get("HEAL_WATCHDOG_SILENT_S", "2700"))
SEVERITY_ORDER = {"high": 0, "med": 1, "low": 2}
LEVELS = ["L3", "L2", "L1"]
stats = {"runs": 0, "events": 0, "new_incidents": 0, "attached": 0, "dispatched": 0, "resolved": 0}


def control(con) -> dict:
    return dict(con.execute(f"SELECT key, value FROM {S}.main.control").fetchall())


def heartbeat(con, phase: str, detail: dict):
    ctx = db.run_context()
    con.execute(f"INSERT INTO {S}.main.heartbeats (component, run_number, sha, detail) VALUES ('checker', ?, ?, ?::JSON)",
                [ctx["run_number"], ctx["sha"], json.dumps({"phase": phase, **detail}, default=str)])


# ------------------------------------------------------------------------------------- run intake
def components(con) -> dict[str, dict]:
    """flight_id -> {kind: pipeline|fixer, name}. Flights are found by name, so ids never live in git."""
    by_name = flights.by_name(con)
    out = {}
    for name, p in registry()["pipelines"].items():
        f = by_name.get(p["flight_name"])
        if f:
            out[f["flight_id"]] = {"kind": "pipeline", "name": name, "flight_id": f["flight_id"]}
    fx = by_name.get(registry()["healer"]["fixer"]["flight_name"])
    if fx:
        out[fx["flight_id"]] = {"kind": "fixer", "name": "fixer", "flight_id": fx["flight_id"]}
    return out


def new_runs(con, comps: dict) -> list[dict]:
    done = {(str(f), n) for f, n in con.execute(f"""SELECT flight_id, run_number FROM {S}.main.processed_runs
                                                     WHERE processed_at > now() - INTERVAL 3 DAY""").fetchall()}
    out = []
    for fid, comp in comps.items():
        for r in flights.runs(con, fid, limit=30):
            if r["status"] in flights.TERMINAL and (fid, r["run_number"]) not in done:
                out.append({**r, "component": comp})
    return sorted(out, key=lambda r: (r["ended_at"] or r["created_at"]))


def run_sha(con, fid, run_number):
    row = con.execute(f"SELECT sha FROM {S}.main.code_versions WHERE flight_id = ?::UUID AND run_number = ? ORDER BY ts DESC LIMIT 1",
                      [fid, run_number]).fetchone()
    return row[0] if row else None


def run_events(con, run: dict) -> list[dict]:
    cur = con.execute(f"""SELECT * FROM {S}.main.pipeline_events WHERE flight_id = ?::UUID AND run_number = ? ORDER BY ts""",
                      [run["flight_id"], run["run_number"]])
    cols = [d[0] for d in cur.description]
    evs = [dict(zip(cols, r)) for r in cur.fetchall()]
    for e in evs:
        e["detail"] = json.loads(e["detail"]) if isinstance(e.get("detail"), str) else e.get("detail")
        e["run_config"] = json.loads(e["run_config"]) if isinstance(e.get("run_config"), str) else e.get("run_config")
    return evs


def events_for_failed_run(con, run: dict) -> list[dict]:
    evs = [e for e in run_events(con, run) if e["severity"] == "error"]
    if evs:
        return evs
    try:
        lines = flights.logs(con, run["flight_id"], run["run_number"])
    except Exception as e:
        lines = [f"(could not read logs: {e})"]
    from_logs = [e for e in flights.heal_events_from_logs(lines) if e.get("severity") == "error"]
    if from_logs:
        return from_logs
    tail = [l for l in reversed(lines) if l.strip()][-40:]
    last = next((l for l in reversed(tail) if "Error" in l or "error" in l or "Exception" in l), tail[-1] if tail else "no output")
    status = run["status"]
    etype = "RunCancelled" if status.startswith("CANCEL") else ("RunTimeout" if status == "TIMED_OUT" else "RunFailed")
    return [{"kind": "error", "severity": "error", "error_type": etype, "message": last, "frames": [],
             "event_uid": f"{run['run_id']}:synthetic", "detail": {"log_tail": "\n".join(tail)[-3000:]}}]


# ------------------------------------------------------------------------------------ classification
def code_change_note(con, pipeline: str, sha: str | None) -> str:
    row = con.execute(f"""SELECT p.sha FROM {S}.main.processed_runs p
                          WHERE p.component = ? AND p.status = 'SUCCEEDED' AND p.sha IS NOT NULL ORDER BY p.processed_at DESC LIMIT 1""",
                      [pipeline]).fetchone()
    if not row or not sha:
        return "code changed since last green run: unknown"
    if row[0] == sha:
        return f"code changed since last green run: no (sha {sha[:10]})"
    note = f"code changed since last green run: yes ({row[0][:10]} -> {sha[:10]})"
    g = lifecycle.gh()
    if g.enabled:
        try:
            files = [f["filename"] for f in g.compare(row[0], sha).get("files", [])][:20]
            note += "; changed files: " + ", ".join(files)
        except Exception:
            pass
    return note


def classify(con, ev: dict, note: str) -> dict:
    text = f"{grouping.event_text(ev)}\n{note}\nraw: {ev['raw_excerpt'][:1500]}"
    if ev.get("forced_class"):
        cls = {"label": ev["forced_class"], "confidence": 1.0, "fallback_ran": False}
    else:
        cls = jev.decide(con, "failure_class", [text], [ev["fingerprint"]])[0]
    label = cls["label"] if cls["label"] in registry_classes() else "unclassified"
    disp = jev.decide(con, "disposition", [text], [ev["fingerprint"]])[0]["label"]
    sev = jev.decide(con, "severity", [text], [ev["fingerprint"]])[0]
    info = class_info(label)
    # Class semantics win over a free-standing disposition answer: transient classes are watched
    # first, credential failures always go to a human, persistent classes are fixed.
    if info["kind"] == "T" and disp == "fix":
        disp = "watch"
    if info["kind"] == "P" and disp == "watch":
        disp = info["disposition"]
    if label in ("auth_failure", "healer_fixer_fault", "healer_checker_fault", "unclassified"):
        disp = "escalate" if label != "unclassified" else disp
    severity = sev["label"] if not sev.get("unsure") and sev["label"] in SEVERITY_ORDER else info["severity"]
    return {"class": label, "disposition": disp, "severity": severity, "class_conf": cls["confidence"],
            "fallback": cls["fallback_ran"]}


def registry_classes():
    from healkit.registry import categories
    return categories()["classes"]


def level_for(con, pipeline: str, cls: str) -> str | None:
    lvl = effective_level(pipeline, cls)
    if lvl is None:
        return None
    cap = control(con).get("autonomy_cap", "L1")
    return min(lvl, cap, key=LEVELS.index)


# ---------------------------------------------------------------------------------------- ingest
def ingest(con, raw: dict, run: dict | None, comp: dict):
    pipeline = raw.get("pipeline") or comp["name"]
    message = raw.get("message") or ""
    norm = normalize(message)
    frames = raw.get("frames") or []
    etype = raw.get("error_type")
    ev = {"pipeline": pipeline, "error_type": etype, "norm_msg": norm, "frames": frames, "asset": raw.get("asset"),
          "resource": raw.get("resource"), "http_status": raw.get("http_status"), "detail": raw.get("detail") or {},
          "raw_excerpt": (message + "\n" + json.dumps(raw.get("detail") or {}, default=str))[:4000],
          "forced_class": raw.get("forced_class")}
    ev["fingerprint"] = fingerprint(pipeline, etype, norm, frames)
    uid = raw.get("event_uid") or f"{run and run['run_id']}:{ev['fingerprint']}"
    if con.execute(f"SELECT 1 FROM {S}.main.events WHERE event_uid = ?", [uid]).fetchone():
        return
    sha = run_sha(con, run["flight_id"], run["run_number"]) if run else None
    d = grouping.decide(con, ev)
    stats["events"] += 1
    con.execute(f"""INSERT INTO {S}.main.events (source, pipeline, flight_id, run_number, sha, error_class, norm_msg, top_frames, asset,
                    resource, fingerprint, raw_excerpt, incident_id, attach_reason, event_uid)
                    VALUES (?, ?, ?::UUID, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                [raw.get("kind", "run"), pipeline, run and run["flight_id"], run and run["run_number"], sha, etype, norm, frames,
                 ev["asset"], ev["resource"], ev["fingerprint"], ev["raw_excerpt"], d.incident_id, d.reason, uid])
    eid = con.execute(f"SELECT event_id FROM {S}.main.events WHERE event_uid = ?", [uid]).fetchone()[0]
    print(f"  event {eid} {pipeline} {etype}: {norm[:120]} -> {d.reason} {d.incident_id or ''} {d.detail or ''}", flush=True)

    if d.incident_id is None:
        new_incident(con, ev, eid, sha, run)
        return
    stats["attached"] += 1
    inc = lifecycle.incident(con, d.incident_id)
    con.execute(f"""UPDATE {S}.main.incidents SET event_count = event_count + 1, last_event_at = now(), updated_at = now(),
                    pipelines = list_distinct(list_append(coalesce(pipelines, []), ?)) WHERE incident_id = ?""", [pipeline, d.incident_id])
    if d.reason not in ("fingerprint", "regressed"):
        con.execute(f"INSERT OR IGNORE INTO {S}.main.fingerprints (fingerprint, incident_id, norm_msg, embedding) SELECT ?, ?, ?, embedding(?)",
                    [ev["fingerprint"], d.incident_id, norm, grouping.event_text(ev)])
    if d.reason == "lineage":
        return  # a symptom: counted on the root, no action of its own
    if inc["status"] == "resolved" or (inc["status"] in ("verifying", "merged") and pipeline == inc["pipeline"]):
        regress(con, inc, f"same fingerprint recurred in {pipeline} run {run and run['run_number']}")
    elif inc["status"] == "watching":
        red = (inc["red_runs"] or 0) + 1
        con.execute(f"UPDATE {S}.main.incidents SET red_runs = ?, green_runs = 0 WHERE incident_id = ?", [red, inc["incident_id"]])
        check_flapping(con, inc["incident_id"], pipeline)
        if red >= N and not lifecycle.incident(con, inc["incident_id"])["muted"]:
            persisted(con, inc["incident_id"], red)
    elif inc["status"] == "verifying":
        con.execute(f"UPDATE {S}.main.incidents SET green_runs = 0 WHERE incident_id = ?", [inc["incident_id"]])


def new_incident(con, ev: dict, eid: int, sha: str | None, run: dict | None):
    note = code_change_note(con, ev["pipeline"], sha)
    c = classify(con, ev, note)
    cat = category_of(c["class"])
    level = level_for(con, ev["pipeline"], c["class"]) if not c["class"].startswith("healer_") else "L3"
    title = f"{c['class'].replace('_', ' ')}: {ev['norm_msg'][:90]}"
    status = {"watch": "watching", "escalate": "escalated", "fix": "open"}[c["disposition"]]
    if status == "open" and level is None:
        status = "watching"
    inc_id = con.execute(f"""INSERT INTO {S}.main.incidents (status, pipeline, pipelines, class, category, disposition, severity, level,
                             title, fingerprint, resource, first_sha, last_event_at, red_runs, scenario)
                             VALUES (?, ?, [?], ?, ?, ?, ?, ?, ?, ?, ?, ?, now(), 1, ?) RETURNING incident_id""",
                         [status, ev["pipeline"], ev["pipeline"], c["class"], cat, c["disposition"], c["severity"], level, title,
                          ev["fingerprint"], ev.get("resource"), sha, (ev["detail"].get("scenario") if isinstance(ev["detail"], dict) else None)]).fetchone()[0]
    con.execute(f"UPDATE {S}.main.events SET incident_id = ? WHERE event_id = ?", [inc_id, eid])
    con.execute(f"INSERT OR REPLACE INTO {S}.main.fingerprints (fingerprint, incident_id, norm_msg, embedding) SELECT ?, ?, ?, embedding(?)",
                [ev["fingerprint"], inc_id, ev["norm_msg"], grouping.event_text(ev)])
    con.execute(f"INSERT INTO {S}.main.incident_transitions (incident_id, from_status, to_status, reason, actor) VALUES (?, NULL, ?, ?, 'checker')",
                [inc_id, status, f"new {c['class']} ({c['class_conf']:.2f}{', llm fallback' if c['fallback'] else ''}) -> {c['disposition']}; {note}"])
    stats["new_incidents"] += 1
    print(f"  NEW incident {inc_id}: {c} level={level} status={status}", flush=True)
    if status != "watching":
        lifecycle.open_issue(con, inc_id, {**ev, "raw_excerpt": ev["raw_excerpt"]})
    if run:
        check_flapping(con, inc_id, ev["pipeline"])


def persisted(con, inc_id: int, red: int):
    inc = lifecycle.incident(con, inc_id)
    lifecycle.open_issue(con, inc_id)
    if inc["level"] is None:
        lifecycle.transition(con, inc_id, "escalated", f"transient {inc['class']} persisted for {red} runs; no fixer for this class")
    else:
        lifecycle.transition(con, inc_id, "watching", f"transient persisted for {red} runs; queueing a fixer", disposition="fix")


def check_flapping(con, inc_id: int, pipeline: str):
    rows = con.execute(f"""SELECT status FROM {S}.main.processed_runs WHERE component = ? ORDER BY run_number DESC LIMIT ?""",
                       [pipeline, FLAP_WINDOW]).fetchall()
    sts = [r[0] == "SUCCEEDED" for r in rows]
    if len(sts) < FLAP_WINDOW:
        return
    changes = sum(1 for a, b in zip(sts, sts[1:]) if a != b)
    if changes / (len(sts) - 1) >= FLAP_RATE:
        inc = lifecycle.incident(con, inc_id)
        if not inc["muted"]:
            con.execute(f"UPDATE {S}.main.incidents SET muted = true, notes = ? WHERE incident_id = ?",
                        [f"flapping: {changes} state changes in last {len(sts)} runs", inc_id])
            lifecycle.open_issue(con, inc_id)
            lifecycle.sync_issue(con, inc_id, f"Flapping: {changes} state changes over {len(sts)} runs. Notifications muted.")
            if inc["status"] in ("open", "watching"):
                lifecycle.transition(con, inc_id, "watching", "flapping; muted, watching only", disposition="watch")


def regress(con, inc: dict, why: str):
    lifecycle.transition(con, inc["incident_id"], "regressed", why, green_runs=0)
    if inc.get("guide_id"):
        try:
            guides.add_outcome_version(con, str(inc["guide_id"]), "regressed", why)
        except Exception as e:
            print(f"  guide version failed: {e}", flush=True)


# ---------------------------------------------------------------------------------------- greens
def on_green(con, pipeline: str, run: dict, sha: str | None, comps: dict):
    incs = con.execute(f"""SELECT incident_id FROM {S}.main.incidents WHERE pipeline = ? AND status IN ('watching', 'verifying', 'escalated')""",
                       [pipeline]).fetchall()
    for (inc_id,) in incs:
        inc = lifecycle.incident(con, inc_id)
        if inc["status"] == "verifying" and inc["merged_at"] and run["started_at"] and run["started_at"] < inc["merged_at"]:
            continue  # ran on pre-merge code
        greens = (inc["green_runs"] or 0) + 1
        con.execute(f"UPDATE {S}.main.incidents SET green_runs = ?, red_runs = 0 WHERE incident_id = ?", [greens, inc_id])
        if greens >= K:
            resolve(con, inc_id, f"{greens} green runs (last: run {run['run_number']} at sha {(sha or '?')[:10]})", comps)
        elif inc["status"] == "verifying":
            trigger_pipeline(con, comps, pipeline, f"verification run {greens + 1}/{K} for incident {inc_id}")


def resolve(con, inc_id: int, why: str, comps: dict):
    inc = lifecycle.incident(con, inc_id)
    if not lifecycle.transition(con, inc_id, "resolved", why):
        return
    stats["resolved"] += 1
    try:
        write_guide(con, inc_id, comps)
    except Exception as e:
        print(f"  guide write failed for {inc_id}: {e}", flush=True)
        traceback.print_exc()
    # Re-run downstream pipelines that showed symptoms so their marts heal too.
    for p in set(inc.get("pipelines") or []) - {inc["pipeline"]}:
        trigger_pipeline(con, comps, p, f"downstream refresh after incident {inc_id} resolved")


def write_guide(con, inc_id: int, comps: dict):
    inc = lifecycle.incident(con, inc_id)
    if inc.get("guide_id"):
        guides.add_outcome_version(con, str(inc["guide_id"]), "fixed", "verified again after regression")
        return
    row = con.execute(f"""SELECT summary FROM {S}.main.fixer_runs WHERE incident_id = ? AND outcome IN ('merged', 'proposed')
                          ORDER BY ended_at DESC LIMIT 1""", [inc_id]).fetchone()
    draft = json.loads(row[0]) if row and row[0] else {}
    ev = con.execute(f"SELECT norm_msg, raw_excerpt FROM {S}.main.events WHERE incident_id = ? ORDER BY event_id LIMIT 1", [inc_id]).fetchone()
    inc["norm_msg"] = ev[0] if ev else ""
    if not draft:
        n = con.execute(f"SELECT count(*) FROM {S}.main.events WHERE incident_id = ?", [inc_id]).fetchone()[0]
        draft = {"symptoms": f"{n} failure events. First: `{inc['norm_msg']}`",
                 "root_cause": f"Transient {inc['class'].replace('_', ' ')} upstream; no code change." if inc["disposition"] == "watch"
                               else "Resolved outside the fixer (see the GitHub issue).",
                 "fix": "None - watched with backoff until it cleared." if inc["disposition"] == "watch" else "See the GitHub issue.",
                 "verification": f"{K} consecutive green runs.", "assets": registry()["pipelines"].get(inc["pipeline"], {}).get("assets", [])}
    links = draft.get("validated_links") or []
    fid = next((c["flight_id"] for c in comps.values() if c["name"] == inc["pipeline"]), None)
    gid = guides.write_incident_guide(con, inc, draft, links, fid)
    print(f"  wrote Guide {gid} for incident {inc_id} ({len(links)} related links)", flush=True)
    lifecycle.sync_issue(con, inc_id, f"Incident Guide written: `{gid}` under `{guides.incident_topic(inc['category'])}`.")


def warn_events(con, run: dict):
    warns = [e for e in run_events(con, run) if e["severity"] == "warn" and e["kind"] == "test"]
    if not warns:
        return
    texts = [f"pipeline: {e['pipeline']}\ntest: {e['test']}\nresult: {e['message']}\nrun config: {json.dumps(e.get('run_config'))}\n"
             f"run log context: {json.dumps((e.get('detail') or {}))}" for e in warns]
    for e, r in zip(warns, jev.decide(con, "warn_is_real", texts, [e["test"] for e in warns])):
        real = r["label"] in ("yes",) if r["fallback_ran"] else (r["p"] or 0) > jev.TASKS["warn_is_real"]["accept"]["p_lte"]
        print(f"  warn {e['pipeline']} {e['test']}: {'REAL' if real else 'ignored'} ({r})", flush=True)
        if real:
            ingest(con, {**e, "severity": "error", "message": f"[warn test judged real] {e['message']}"}, run,
                   {"name": e["pipeline"], "kind": "pipeline"})


# --------------------------------------------------------------------------------- action phases
def trigger_pipeline(con, comps: dict, pipeline: str, why: str):
    fid = next((c["flight_id"] for c in comps.values() if c["name"] == pipeline), None)
    if not fid:
        return
    active = [r for r in flights.runs(con, fid, limit=5) if r["status"] in ("PENDING", "RUNNING", "QUEUED", "STARTING")]
    if active:
        return
    r = flights.trigger(con, fid)
    print(f"  triggered {pipeline} run {r['run_number']}: {why}", flush=True)


def verify_and_watch(con, comps: dict):
    # L3 proposals: a human merging the PR moves the incident to merged.
    g = lifecycle.gh()
    for inc_id, pr in con.execute(f"SELECT incident_id, gh_pr FROM {S}.main.incidents WHERE status = 'proposed' AND gh_pr IS NOT NULL").fetchall():
        if not g.enabled:
            break
        p = g.pr(pr)
        if p.get("merged"):
            lifecycle.transition(con, inc_id, "merged", f"PR #{pr} merged by {(p.get('merged_by') or {}).get('login', 'a human')}",
                                 fix_sha=p["merge_commit_sha"], merged_at="now()")
        elif p.get("state") == "closed":
            lifecycle.transition(con, inc_id, "escalated", f"proposal PR #{pr} was closed without merging")
    for (inc_id,) in con.execute(f"SELECT incident_id FROM {S}.main.incidents WHERE status = 'merged'").fetchall():
        inc = lifecycle.incident(con, inc_id)
        lifecycle.transition(con, inc_id, "verifying", f"fix {(inc['fix_sha'] or '')[:10]} merged; verifying on the next runs", green_runs=0)
        trigger_pipeline(con, comps, inc["pipeline"], f"verification run 1/{K} for incident {inc_id}")
    # Transient incidents: re-run with exponential backoff (pipelines may not be scheduled in tests).
    rows = con.execute(f"""SELECT incident_id, pipeline, red_runs, date_diff('second', last_event_at, now()) FROM {S}.main.incidents
                           WHERE status = 'watching' AND disposition = 'watch'""").fetchall()
    for inc_id, pipeline, red, age in rows:
        if age >= BACKOFF_BASE_S * 2 ** max(0, (red or 1) - 1):
            trigger_pipeline(con, comps, pipeline, f"watch re-run for incident {inc_id} (red runs {red})")


def fixer_run_finished(con, run: dict):
    """A fixer run ended. Failures release the lease so the next tick re-dispatches (or escalates)."""
    inc_id = int((run.get("config") or {}).get("INCIDENT_ID") or 0)
    if not inc_id:
        return
    inc = lifecycle.incident(con, inc_id)
    if run["status"] != "SUCCEEDED" and inc and inc["status"] == "investigating":
        con.execute(f"UPDATE {S}.main.incidents SET lease_expires = now() - INTERVAL 1 SECOND WHERE incident_id = ?", [inc_id])
        con.execute(f"""INSERT INTO {S}.main.events (source, pipeline, flight_id, run_number, error_class, norm_msg, incident_id, attach_reason, event_uid)
                        VALUES ('healer', 'healer', ?::UUID, ?, 'healer_fixer_fault', ?, ?, 'fixer_run', ?)""",
                    [run["flight_id"], run["run_number"], f"fixer run {run['run_number']} ended {run['status']}", inc_id, f"{run['run_id']}:fixer"])
        print(f"  fixer run {run['run_number']} for incident {inc_id} ended {run['status']}; lease released", flush=True)


def leases_and_dispatch(con, comps: dict):
    ctl = control(con)
    max_attempts = int(ctl.get("max_attempts", 2))
    for inc_id, attempts in con.execute(f"""SELECT incident_id, attempts FROM {S}.main.incidents
                                            WHERE status = 'investigating' AND lease_expires < now()""").fetchall():
        if attempts >= max_attempts:
            lifecycle.transition(con, inc_id, "escalated", f"lease expired after {attempts} attempts (max {max_attempts})",
                                 lease_owner=None)
        else:
            con.execute(f"UPDATE {S}.main.incidents SET lease_owner = NULL WHERE incident_id = ?", [inc_id])
            print(f"  incident {inc_id}: lease expired, re-dispatch as attempt {attempts + 1}", flush=True)

    fixer = next((c for c in comps.values() if c["kind"] == "fixer"), None)
    if not fixer:
        return
    if ctl.get("kill_switch") == "on" or ctl.get("dispatch_paused") == "on":
        print("  dispatch paused (kill switch / dispatch_paused)", flush=True)
        return
    spent = con.execute(f"SELECT coalesce(sum(cost_usd), 0) FROM {S}.main.fixer_runs WHERE started_at >= current_date").fetchone()[0]
    if spent >= float(ctl.get("daily_spend_cap_usd", 50)):
        print(f"  dispatch paused: daily spend ${spent:.2f} >= cap", flush=True)
        return
    running = con.execute(f"SELECT count(*) FROM {S}.main.incidents WHERE status = 'investigating' AND lease_expires > now()").fetchone()[0]
    slots = int(ctl.get("max_concurrent_fixers", 3)) - running
    queue = con.execute(f"""SELECT incident_id, status, severity, level FROM {S}.main.incidents
        WHERE level IS NOT NULL AND NOT muted AND (
              (status = 'open' AND disposition = 'fix')
           OR (status = 'watching' AND disposition = 'fix')
           OR status = 'regressed'
           OR (status = 'investigating' AND lease_owner IS NULL))
        ORDER BY CASE severity WHEN 'high' THEN 0 WHEN 'med' THEN 1 ELSE 2 END, created_at""").fetchall()
    for inc_id, status, sev, level in queue[:max(0, slots)]:
        mode = "revert" if status == "regressed" else "fix"
        inc = lifecycle.incident(con, inc_id)
        cfg = {"INCIDENT_ID": inc_id, "AUTONOMY": level, "MODE": mode, "ATTEMPT": (inc["attempts"] or 0) + 1,
               "BUDGET_USD": ctl.get("budget_usd", "10"), "APPROVER_ROUNDS": ctl.get("approver_rounds", "2")}
        r = flights.trigger(con, fixer["flight_id"], cfg)
        if status != "investigating":
            lifecycle.transition(con, inc_id, "investigating", f"fixer dispatched (run {r['run_number']}, {mode}, {level}, attempt {cfg['ATTEMPT']})")
        con.execute(f"""UPDATE {S}.main.incidents SET attempts = attempts + 1, lease_owner = ?, lease_expires = now() + to_seconds(?)
                        WHERE incident_id = ?""", [f"fixer-run:{r['run_number']}", LEASE_S, inc_id])
        stats["dispatched"] += 1
        print(f"  dispatched fixer run {r['run_number']} for incident {inc_id} {cfg}", flush=True)


def healer_watch(con):
    last = con.execute(f"SELECT max(ts), date_diff('second', max(ts), now()) FROM {S}.main.heartbeats WHERE component = 'watchdog'").fetchone()
    if last[0] is not None and last[1] > WATCHDOG_SILENT_S:
        flag = control(con).get("watchdog_silent_issue")
        if not flag:
            g = lifecycle.gh()
            if g.enabled:
                issue = g.create_issue("[heal] watchdog is silent", f"No watchdog heartbeat for {last[1]} s (last {last[0]}).",
                                       ["heal", "healer:watchdog-silent", "category:healer-and-platform"])
                con.execute(f"INSERT OR REPLACE INTO {S}.main.control (key, value, updated_by) VALUES ('watchdog_silent_issue', ?, 'checker')",
                            [str(issue["number"])])
    elif last[0] is not None:
        con.execute(f"DELETE FROM {S}.main.control WHERE key = 'watchdog_silent_issue'")


def other_category_proposals(con, comps: dict):
    """3+ resolved `other` incidents that share a fingerprint or look alike -> an L3 categories.yaml PR."""
    rows = con.execute(f"""
        WITH o AS (SELECT i.incident_id, f.embedding FROM {S}.main.incidents i JOIN {S}.main.fingerprints f USING (incident_id)
                   WHERE i.category = 'other' AND i.status = 'resolved')
        SELECT a.incident_id, count(DISTINCT b.incident_id) AS n_similar FROM o a JOIN o b
          ON a.incident_id <> b.incident_id AND array_cosine_similarity(a.embedding, b.embedding) >= 0.85
        GROUP BY ALL HAVING n_similar >= 2 ORDER BY n_similar DESC LIMIT 1""").fetchall()
    if not rows or control(con).get("category_proposal_open"):
        return
    fixer = next((c for c in comps.values() if c["kind"] == "fixer"), None)
    if fixer:
        r = flights.trigger(con, fixer["flight_id"], {"INCIDENT_ID": rows[0][0], "AUTONOMY": "L3", "MODE": "category_proposal", "ATTEMPT": 1})
        con.execute(f"INSERT OR REPLACE INTO {S}.main.control (key, value, updated_by) VALUES ('category_proposal_open', ?, 'checker')",
                    [f"fixer-run:{r['run_number']}"])


def main():
    t0 = time.time()
    con = db.connect()
    heartbeat(con, "start", {})
    if control(con).get("checker_force_fail") == "on":
        raise RuntimeError("checker_force_fail is on in heal.control (forced failure for scenario S17)")
    comps = components(con)
    for run in new_runs(con, comps):
        comp = run["component"]
        stats["runs"] += 1
        sha = run_sha(con, run["flight_id"], run["run_number"])
        print(f"run {comp['name']}#{run['run_number']} {run['status']} sha={(sha or '-')[:10]}", flush=True)
        try:
            if comp["kind"] == "fixer":
                fixer_run_finished(con, run)
            else:
                # Loader-level healer faults (GitHub unreachable -> ran cached code) arrive on any run.
                for e in run_events(con, run):
                    if e["kind"] == "healer":
                        ingest(con, {**e, "forced_class": "healer_checker_fault", "pipeline": "healer"}, run, comp)
                if run["status"] == "SUCCEEDED":
                    on_green(con, comp["name"], run, sha, comps)
                    warn_events(con, run)
                else:
                    for e in events_for_failed_run(con, run):
                        ingest(con, e, run, comp)
        except Exception:
            traceback.print_exc()
            print(f"  error handling run {comp['name']}#{run['run_number']}; will retry next tick", flush=True)
            continue
        con.execute(f"INSERT OR IGNORE INTO {S}.main.processed_runs (flight_id, run_number, component, status, sha) VALUES (?::UUID, ?, ?, ?, ?)",
                    [run["flight_id"], run["run_number"], comp["name"], run["status"], sha])
    for phase in (verify_and_watch, leases_and_dispatch, other_category_proposals):
        try:
            phase(con, comps)
        except Exception:
            traceback.print_exc()
    try:
        healer_watch(con)
    except Exception:
        traceback.print_exc()
    stats["tick_s"] = round(time.time() - t0, 1)
    heartbeat(con, "end", stats)
    print(f"checker tick done: {stats}", flush=True)


if __name__ == "__main__":
    main()
