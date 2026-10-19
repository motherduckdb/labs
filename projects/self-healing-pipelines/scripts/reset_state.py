"""Reset healer state between dev iterations / test campaigns.

    reset_state.py            incidents, events, fingerprints, judgments, fixer runs, actions, transitions,
                              processed runs, classifications, chaos world (keeps Guides + guide_index + reads/links)
    reset_state.py --guides   also delete every self-healing/* Guide and the Guide tables
Never touches heal.control, code cache or eval results.
"""
import pathlib
import sys

import duckdb

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
from healkit import flights  # noqa: E402
from healkit.registry import registry  # noqa: E402

TABLES = ["events", "fingerprints", "pair_judgments", "incidents", "incident_transitions", "fixer_runs", "actions",
          "processed_runs", "classifications", "pipeline_events", "heartbeats"]
con = duckdb.connect("md:")
con.execute("SET TimeZone='UTC'")
for t in TABLES:
    con.execute(f"DELETE FROM heal.main.{t}")
con.execute("DELETE FROM heal_chaos.main.world")
if "--guides" in sys.argv:
    for (gid,) in con.execute("SELECT id FROM MD_LIST_GUIDES(topic := 'self-healing')").fetchall():
        con.execute("SELECT * FROM MD_DELETE_GUIDE(id := ?::UUID)", [str(gid)]).fetchall()
    for t in ("guide_index", "guide_reads", "guide_links"):
        con.execute(f"DELETE FROM heal.main.{t}")
# Existing runs are history, not new failures: mark them processed so the next tick starts clean.
comp_of = {p["flight_name"]: k for k, p in registry()["pipelines"].items()}
comp_of.update({h["flight_name"]: k for k, h in registry()["healer"].items()})
for name, f in flights.by_name(con).items():
    if name in comp_of:
        for r in flights.runs(con, f["flight_id"], limit=50):
            if r["status"] in flights.TERMINAL:
                con.execute("INSERT OR IGNORE INTO heal.main.processed_runs (flight_id, run_number, component, status) VALUES (?::UUID, ?, ?, ?)",
                            [f["flight_id"], r["run_number"], comp_of[name], r["status"]])
print("reset:", TABLES, "+ chaos world", "+ guides" if "--guides" in sys.argv else "")
