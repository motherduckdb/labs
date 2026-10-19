"""Incident lifecycle (§09): allowed transitions, transition log, GitHub issue sync.

Every transition is recorded in heal.incident_transitions (the Dive board reads it) and mirrored to
the incident's GitHub issue as a comment + status label. Muted (flapping) incidents skip comments.
"""
import json

from healkit import db
from healkit.gh import GitHub
from healkit.registry import registry

S = db.STATE_DB
ALLOWED = {
    "open": {"watching", "investigating", "escalated"},
    "watching": {"resolved", "investigating", "escalated", "watching"},
    "investigating": {"investigating", "proposed", "merged", "escalated", "verifying"},
    "proposed": {"merged", "escalated", "investigating"},
    "merged": {"verifying", "regressed"},
    "verifying": {"resolved", "regressed", "verifying"},
    "regressed": {"investigating", "escalated"},
    "resolved": {"regressed"},
    "escalated": {"resolved", "investigating"},
}
TERMINAL = {"resolved"}
ACTIVE = {"open", "watching", "investigating", "proposed", "merged", "verifying", "regressed", "escalated"}
INVESTIGATING = {"investigating", "proposed", "merged", "verifying"}


def gh() -> GitHub:
    return GitHub(registry()["repo"])


def incident(con, inc_id: int) -> dict:
    cur = con.execute(f"SELECT * FROM {S}.main.incidents WHERE incident_id = ?", [inc_id])
    cols = [d[0] for d in cur.description]
    row = cur.fetchone()
    return dict(zip(cols, row)) if row else None


def transition(con, inc_id: int, to: str, reason: str, actor: str = "checker", **fields) -> bool:
    inc = incident(con, inc_id)
    frm = inc["status"]
    if to != frm and to not in ALLOWED.get(frm, set()):
        print(f"  incident {inc_id}: refusing {frm} -> {to} ({reason})", flush=True)
        return False
    sets = {"status": to, **fields}
    if to == "resolved":
        sets.setdefault("resolved_at", "now()")
    assign = ", ".join(f"{k} = now()" if v == "now()" else f"{k} = ?" for k, v in sets.items())
    con.execute(f"UPDATE {S}.main.incidents SET {assign}, updated_at = now() WHERE incident_id = ?",
                [v for v in sets.values() if v != "now()"] + [inc_id])
    con.execute(f"INSERT INTO {S}.main.incident_transitions (incident_id, from_status, to_status, reason, actor) VALUES (?, ?, ?, ?, ?)",
                [inc_id, frm, to, reason[:1000], actor])
    print(f"  incident {inc_id}: {frm} -> {to} ({reason[:160]})", flush=True)
    sync_issue(con, inc_id, f"**{frm} → {to}** ({actor}): {reason}")
    return True


def issue_body(inc: dict, first_event: dict | None) -> str:
    ev = first_event or {}
    return f"""Automated incident from the self-healing checker.

| | |
|---|---|
| incident | `{inc['incident_id']}` |
| pipeline | `{inc['pipeline']}` |
| class / category | `{inc['class']}` / `{inc['category']}` |
| disposition / severity | `{inc['disposition']}` / `{inc['severity']}` |
| autonomy | `{inc['level'] or 'no fixer'}` |
| fingerprint | `{inc['fingerprint']}` |
| resource | `{inc['resource'] or '-'}` |

**Normalized error**

```
{(ev.get('norm_msg') or '')[:1500]}
```

**Raw excerpt (redacted)**

```
{(ev.get('raw_excerpt') or '')[:3000]}
```

Status changes are posted below. Board: the "Self-healing incidents" Dive on `md:heal`.
"""


def open_issue(con, inc_id: int, first_event: dict | None = None):
    g = gh()
    inc = incident(con, inc_id)
    if not g.enabled or inc.get("gh_issue"):
        return inc.get("gh_issue")
    labels = ["heal", f"incident:{inc_id}", f"category:{inc['category']}", f"status:{inc['status']}"]
    if inc.get("level"):
        labels.append(f"level:{inc['level']}")
    try:
        issue = g.create_issue(f"[heal #{inc_id}] {inc['pipeline']}: {inc['title']}", issue_body(inc, first_event), labels)
    except Exception as e:
        print(f"  github: could not open issue for {inc_id}: {e}", flush=True)
        return None
    con.execute(f"UPDATE {S}.main.incidents SET gh_issue = ? WHERE incident_id = ?", [issue["number"], inc_id])
    return issue["number"]


def sync_issue(con, inc_id: int, note: str):
    inc = incident(con, inc_id)
    g = gh()
    if not g.enabled or not inc.get("gh_issue"):
        return
    try:
        if not inc.get("muted"):
            g.comment(inc["gh_issue"], note)
        g.set_labels(inc["gh_issue"], add=[f"status:{inc['status']}"],
                     remove=[f"status:{s}" for s in ALLOWED if s != inc["status"]])
        if inc["status"] == "resolved":
            g.close_issue(inc["gh_issue"])
        elif inc["status"] == "regressed":
            g.reopen_issue(inc["gh_issue"])
    except Exception as e:
        print(f"  github: sync failed for incident {inc_id}: {e}", flush=True)


def summary(inc: dict) -> str:
    return json.dumps({k: inc[k] for k in ("incident_id", "status", "pipeline", "class", "category", "level") if k in inc}, default=str)
