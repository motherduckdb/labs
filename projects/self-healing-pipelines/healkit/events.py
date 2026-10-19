"""HEAL_EVENT: one structured line per failure or test result, printed to the Flight log and stored in heal.

    HEAL_EVENT {"v":1,"kind":"error","severity":"error","pipeline":"p1_wiki","asset":"p1_wiki.pageviews",...}

The checker reads `heal.pipeline_events` first and falls back to scanning the last 200 log lines, so a
run that dies before healkit can write still gets classified.
"""
import json
import os
import sys
import traceback
import uuid
from datetime import datetime, timezone

from . import db
from .redact import redact

PREFIX = "HEAL_EVENT "
_seq = 0


def top_frames(tb, limit: int = 5) -> list[str]:
    """Innermost project frames as `path:function`, newest first; line numbers dropped so a fingerprint
    survives unrelated edits above the failing line."""
    frames = []
    for fs in reversed(traceback.extract_tb(tb)):
        path = fs.filename
        if "site-packages" in path or path.startswith("<"):
            continue
        marker = "self-healing-pipelines/"
        path = path.split(marker, 1)[1] if marker in path else os.path.basename(path)
        frames.append(f"{path}:{fs.name}")
        if len(frames) >= limit:
            break
    return frames


def emit(kind: str, severity: str, message: str, *, asset=None, test=None, resource=None, error_type=None,
         http_status=None, frames=None, detail=None) -> dict:
    global _seq
    _seq += 1
    ctx = db.run_context()
    ev = {
        "v": 1, "event_uid": f"{ctx['run_id'] or uuid.uuid4()}:{_seq}",
        "ts": datetime.now(timezone.utc).isoformat(), "kind": kind, "severity": severity,
        "pipeline": ctx["pipeline"], "flight_id": ctx["flight_id"], "run_number": ctx["run_number"],
        "run_id": ctx["run_id"], "sha": ctx["sha"], "asset": asset, "test": test, "resource": resource,
        "error_type": error_type, "http_status": http_status, "message": redact(message)[:2000],
        "frames": frames or [], "detail": json.loads(redact(json.dumps(detail, default=str))) if detail else None,
        "run_config": {k: v for k, v in os.environ.items() if k.startswith("RUN_")} or None,
    }
    print(PREFIX + json.dumps(ev, default=str), flush=True)
    # Sandbox runs (fixer repro/verify) must never look like production failures to the checker.
    if not ctx["sandbox"] and os.environ.get("HEAL_EVENTS_SINK", "table") == "table":
        try:
            db.shared().execute(
                f"""INSERT OR IGNORE INTO {db.STATE_DB}.main.pipeline_events
                    SELECT ?, ?::TIMESTAMPTZ, ?, ?::UUID, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::JSON, ?::JSON""",
                [ev["event_uid"], ev["ts"], ev["pipeline"], ev["flight_id"], ev["run_number"], ev["run_id"], ev["sha"],
                 kind, severity, asset, test, resource, error_type, http_status, ev["message"], ev["frames"],
                 json.dumps(ev["detail"]) if ev["detail"] is not None else None,
                 json.dumps(ev["run_config"]) if ev["run_config"] else None])
        except Exception as e:  # logging must never be the thing that breaks a pipeline
            print(f"healkit: could not store HEAL_EVENT ({type(e).__name__}: {e})", file=sys.stderr, flush=True)
    return ev


def parse_line(line: str):
    i = line.find(PREFIX)
    if i < 0:
        return None
    try:
        return json.loads(line[i + len(PREFIX):])
    except json.JSONDecodeError:
        return None
