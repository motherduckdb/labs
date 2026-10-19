"""Incident memory in MotherDuck Guides (§08).

Topics:   self-healing/incidents/<category>   one Guide per resolved incident group
          self-healing/playbooks/<category>   one Guide per category (fixer drafts, a human approves)
Reads go through get(), which logs every open to heal.guide_reads. Links ("Related guides") are only
the Guides the fixer declared helpful, after deterministic validation and approver review.
"""
import json
import pathlib
from datetime import datetime, timezone

from healkit import db, jev
from healkit.registry import registry

TEMPLATE = (pathlib.Path(__file__).parent / "templates/incident.md").read_text()
HOW_USED = {"reused_fix", "same_root_cause", "pointed_to_location", "ruled_out_hypothesis"}
S = db.STATE_DB


def incident_topic(category: str) -> str:
    return f"self-healing/incidents/{category}"


def playbook_topic(category: str) -> str:
    return f"self-healing/playbooks/{category}"


def _refs_sql(pipeline_flight_id, tables: list[str], linked: list[dict]) -> str:
    """Build the references list literal (flight uuids and guide ids are validated server-side)."""
    parts = []
    if pipeline_flight_id:
        parts.append(f"{{type: 'flight', uuid: '{pipeline_flight_id}'::UUID}}")
    for t in tables:
        schema, table = t.split(".")
        parts.append(f"{{type: 'catalog', url: 'md:{registry()['data_db']}', \"schema\": '{schema}', \"table\": '{table}'}}")
    for l in linked:
        parts.append(f"{{type: 'guide', uuid: '{l['guide_id']}'::UUID, description: '{l['how_used']}'}}")
    return "[" + ", ".join(parts) + "]"


# ---------------------------------------------------------------------------------------------- read
def get(con, guide_id: str, incident_id: int, fixer_run_id: str, version: int | None = None) -> dict:
    """The only way the fixer opens a Guide: MD_GET_GUIDE + a row in heal.guide_reads."""
    q = "SELECT id, topic, title, description, version, content FROM MD_GET_GUIDE(id := ?::UUID" + (", version := ?)" if version else ")")
    row = con.execute(q, [guide_id, version] if version else [guide_id]).fetchone()
    if not row:
        raise KeyError(guide_id)
    con.execute(f"INSERT INTO {S}.main.guide_reads (incident_id, fixer_run_id, guide_id, guide_version) VALUES (?, ?, ?::UUID, ?)",
                [incident_id, fixer_run_id, str(row[0]), row[4]])
    return {"guide_id": str(row[0]), "topic": row[1], "title": row[2], "description": row[3], "version": row[4], "content": row[5]}


def shortlist(con, incident: dict, k: int = 5) -> list[dict]:
    """Candidate Guides for an incident, best first: own category, then same pipeline in any category.
    Ranked in guide_index by embedding similarity + small helpful_count boost - regressed penalty, then
    Jev `guide_applies` (p >= 0.6); if Jev is unsure about all, the top 3 by rank."""
    query = f"{incident.get('title', '')}\n{incident.get('norm_msg', '')}"
    cands = con.execute(f"""
        WITH listed AS (
            SELECT id FROM MD_LIST_GUIDES(topic := ?)
            UNION SELECT id FROM MD_LIST_GUIDES(topic := 'self-healing/incidents') gi
                  WHERE id IN (SELECT guide_id FROM {S}.main.guide_index WHERE pipeline = ?)
        ), q AS (SELECT embedding(?) AS e)
        SELECT g.guide_id::VARCHAR, g.version, g.title, g.description, g.category, g.outcome, g.helpful_count,
               array_cosine_similarity(g.embedding, q.e) AS sim,
               array_cosine_similarity(g.embedding, q.e) + 0.02 * least(g.helpful_count, 10)
                 - CASE WHEN g.outcome = 'regressed' THEN 0.2 ELSE 0 END AS score
        FROM {S}.main.guide_index g JOIN listed l ON g.guide_id = l.id, q
        WHERE g.incident_id IS DISTINCT FROM ?
        ORDER BY score DESC LIMIT ?""",
                        [incident_topic(incident["category"]), incident.get("pipeline"), query, incident.get("incident_id"), k * 2]).fetchall()
    rows = [dict(zip(["guide_id", "version", "title", "description", "category", "outcome", "helpful_count", "sim", "score"], r)) for r in cands]
    if not rows:
        return []
    texts = [f"Incident: {query}\n\nGuide: {r['title']}\n{r['description']}" for r in rows]
    answers = jev.jev_batch(con, "guide_applies", texts)
    for r, p in zip(rows, answers):
        r["jev_p"] = p
        jev.log(con, "guide_applies", r["title"][:80], "applies" if (p or 0) >= 0.6 else "no", p, p, False)
    picked = [r for r in rows if r["jev_p"] is not None and r["jev_p"] >= jev.TASKS["guide_applies"]["accept"]["p_gte"]]
    return (picked or rows[:3])[:k]


def playbook(con, category: str):
    row = con.execute("SELECT id FROM MD_LIST_GUIDES(topic := ?) LIMIT 1", [playbook_topic(category)]).fetchone()
    return str(row[0]) if row else None


# -------------------------------------------------------------------------------------------- links
def validate_links(con, incident_id: int, fixer_run_id: str, helpful: list[dict]) -> tuple[list[dict], list[dict]]:
    """Deterministic checks (§08 step 3). Returns (kept, dropped-with-reason)."""
    reads = {(str(g), v) for g, v in con.execute(
        f"SELECT guide_id, guide_version FROM {S}.main.guide_reads WHERE incident_id = ? AND fixer_run_id = ?",
        [incident_id, fixer_run_id]).fetchall()}
    read_ids = {g for g, _ in reads}
    outcomes = dict(con.execute(f"SELECT guide_id::VARCHAR, outcome FROM {S}.main.guide_index").fetchall())
    kept, dropped = [], []
    for h in helpful or []:
        gid, how, reason = str(h.get("guide_id", "")), h.get("how_used"), (h.get("reason") or "").strip()
        ver = h.get("version")
        why = None
        if gid not in read_ids:
            why = "not in guide_reads for this fixer run"
        elif ver is not None and (gid, int(ver)) not in reads:
            why = f"version {ver} was not the version read"
        elif how not in HOW_USED:
            why = f"invalid how_used {how!r}"
        elif not reason:
            why = "empty reason"
        elif outcomes.get(gid) == "regressed" and how != "ruled_out_hypothesis":
            why = "a regressed Guide may only be linked as ruled_out_hypothesis"
        if why:
            dropped.append({**h, "dropped_because": why})
        else:
            if ver is None:
                ver = max(v for g, v in reads if g == gid)
            kept.append({"guide_id": gid, "version": int(ver), "how_used": how, "reason": reason[:300]})
    return kept, dropped


def _render_links(con, links: list[dict]) -> str:
    if not links:
        return "_None. No earlier Guide changed the diagnosis or the fix._"
    titles = dict(con.execute(f"SELECT guide_id::VARCHAR, title FROM {S}.main.guide_index").fetchall())
    return "\n".join(f"- [{titles.get(l['guide_id'], l['guide_id'])}](guide:{l['guide_id']}@v{l['version']}) "
                     f"— {l['how_used']}: {l['reason']}" for l in links)


# -------------------------------------------------------------------------------------------- write
def render(con, inc: dict, draft: dict, links: list[dict], outcome: str, history: list[str]) -> str:
    md = TEMPLATE
    vals = {
        "category": inc["category"], "cls": inc["class"], "pipeline": inc["pipeline"], "incident_id": inc["incident_id"],
        "fingerprint": inc["fingerprint"], "outcome": outcome, "level": inc["level"], "fix_sha": inc.get("fix_sha") or "",
        "fix_pr": inc.get("gh_pr") or "", "cost_usd": round(inc.get("cost_usd") or 0, 2), "title": inc["title"],
        "symptoms": draft.get("symptoms") or inc.get("norm_msg") or "", "root_cause": draft.get("root_cause") or "_unknown_",
        "fix": draft.get("fix") or "_none_", "verification": draft.get("verification") or "",
        "approver_notes": draft.get("approver_notes") or "_n/a_", "outcome_history": "\n".join(f"- {h}" for h in history),
        "related_guides": _render_links(con, links),
    }
    for k, v in vals.items():
        md = md.replace("{" + k + "}", str(v))
    return md


def write_incident_guide(con, inc: dict, draft: dict, links: list[dict], pipeline_flight_id: str | None) -> str:
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    history = [f"{now}: {('fixed' if inc.get('fix_sha') else 'resolved')} at {inc['level']} "
               f"(PR #{inc.get('gh_pr') or '-'}, sha {(inc.get('fix_sha') or '-')[:10]}, ${inc.get('cost_usd') or 0:.2f})"]
    outcome = "fixed" if inc.get("fix_sha") else ("escalated" if inc.get("status") == "escalated" else "fixed")
    content = render(con, inc, draft, links, outcome, history)
    description = (draft.get("summary") or f"{inc['class']} in {inc['pipeline']}: {inc['title']}")[:500]
    tables = [a for a in (draft.get("assets") or []) if "." in a][:5]
    row = con.execute(f"""SELECT id, current_version FROM MD_CREATE_GUIDE(topic := ?, title := ?, description := ?, content := ?,
                              external_id := ?, change_comment := ?, "references" := {_refs_sql(pipeline_flight_id, tables, links)})""",
                      [incident_topic(inc["category"]), f"#{inc['incident_id']} {inc['title']}"[:200], description, content,
                       inc.get("fix_sha") or f"incident-{inc['incident_id']}", f"incident {inc['incident_id']} resolved"]).fetchone()
    gid, ver = str(row[0]), row[1]
    con.execute(f"""INSERT OR REPLACE INTO {S}.main.guide_index (guide_id, version, topic, category, fingerprint, class, pipeline,
                    outcome, incident_id, title, description, embedding) SELECT ?::UUID, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, embedding(?)""",
                [gid, ver, incident_topic(inc["category"]), inc["category"], inc["fingerprint"], inc["class"], inc["pipeline"], outcome,
                 inc["incident_id"], f"#{inc['incident_id']} {inc['title']}"[:200], description, f"{inc['title']}\n{description}\n{inc.get('norm_msg', '')}"])
    for l in links:
        con.execute(f"""INSERT INTO {S}.main.guide_links (from_guide_id, to_guide_id, to_version, how_used, reason, incident_id)
                        VALUES (?::UUID, ?::UUID, ?, ?, ?, ?)""", [gid, l["guide_id"], l["version"], l["how_used"], l["reason"], inc["incident_id"]])
        con.execute(f"UPDATE {S}.main.guide_index SET helpful_count = helpful_count + 1 WHERE guide_id = ?::UUID", [l["guide_id"]])
    con.execute(f"UPDATE {S}.main.incidents SET guide_id = ?::UUID WHERE incident_id = ?", [gid, inc["incident_id"]])
    return gid


def add_outcome_version(con, guide_id: str, outcome: str, note: str):
    """Regression or recurrence: a new version with the outcome changed; Related guides carry over."""
    cur = con.execute("SELECT content FROM MD_GET_GUIDE(id := ?::UUID)", [guide_id]).fetchone()[0]
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    lines = cur.splitlines()
    lines = [f"outcome: {outcome}" if l.startswith("outcome: ") else l for l in lines]
    content = "\n".join(lines).replace("## Outcome history\n", f"## Outcome history\n- {now}: {outcome} - {note}\n", 1)
    row = con.execute("SELECT current_version FROM MD_UPDATE_GUIDE(id := ?::UUID, content := ?, change_comment := ?)",
                      [guide_id, content, f"{outcome}: {note}"[:200]]).fetchone()
    con.execute(f"UPDATE {S}.main.guide_index SET outcome = ?, version = ?, updated_at = now() WHERE guide_id = ?::UUID",
                [outcome, row[0] if row else None, guide_id])


def as_json(x) -> str:
    return json.dumps(x, default=str)
