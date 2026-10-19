"""MotherDuck Flights helpers: name -> id, runs, logs, trigger, cancel. Statuses are normalized because the
API returns both `FAILED` and `RUN_STATUS_FAILED` spellings."""
from .events import parse_line

TERMINAL = {"SUCCEEDED", "FAILED", "CANCELLED", "CANCELED", "TIMED_OUT", "ERROR"}
RUN_COLS = ["run_id", "flight_id", "flight_name", "flight_version", "config", "run_number", "is_scheduled", "status",
            "created_at", "started_at", "ended_at", "scheduled_at", "cancelled_at", "exit_code"]


def norm_status(s: str | None) -> str:
    s = (s or "").upper()
    return s[len("RUN_STATUS_"):] if s.startswith("RUN_STATUS_") else s


def by_name(con) -> dict[str, dict]:
    rows = con.execute("SELECT flight_id::VARCHAR, flight_name, schedule_cron, schedule_status, status FROM MD_LIST_FLIGHTS(owner_only := true)").fetchall()
    return {r[1]: {"flight_id": r[0], "name": r[1], "schedule_cron": r[2], "schedule_status": r[3], "status": r[4]} for r in rows}


def runs(con, flight_id: str, limit: int = 50) -> list[dict]:
    cur = con.execute("SELECT * FROM MD_LIST_FLIGHT_RUNS(flight_id := ?::UUID, \"limit\" := ?)", [flight_id, limit])
    cols = [d[0] for d in cur.description]
    out = []
    for row in cur.fetchall():
        r = dict(zip(cols, row))
        r["status"] = norm_status(r.get("status"))
        r["flight_id"] = str(r["flight_id"])
        out.append(r)
    return out


def logs(con, flight_id: str, run_number: int, limit: int = 200) -> list[str]:
    """Newest first, last `limit` lines."""
    rows = con.execute("""SELECT line_number, line FROM MD_GET_FLIGHT_LOGS(flight_id := ?::UUID, run_number := ?, "limit" := ?, "order" := 'desc')""",
                       [flight_id, run_number, limit]).fetchall()
    # Don't trust the API's ordering argument; sort on line_number ourselves.
    return [r[1] for r in sorted(rows, key=lambda r: r[0], reverse=True)]


def heal_events_from_logs(lines: list[str]) -> list[dict]:
    return [e for e in (parse_line(l) for l in lines) if e]


def trigger(con, flight_id: str, config: dict | None = None) -> dict:
    if config:
        keys, vals = list(config), [str(v) for v in config.values()]
        cur = con.execute("SELECT run_number, status FROM MD_RUN_FLIGHT(flight_id := ?::UUID, config := MAP(?::VARCHAR[], ?::VARCHAR[]))",
                          [flight_id, keys, vals])
    else:
        cur = con.execute("SELECT run_number, status FROM MD_RUN_FLIGHT(flight_id := ?::UUID)", [flight_id])
    rn, st = cur.fetchone()
    return {"run_number": rn, "status": norm_status(st)}


def cancel(con, flight_id: str, run_number: int):
    con.execute("SELECT * FROM MD_CANCEL_FLIGHT_RUN(flight_id := ?::UUID, run_number := ?)", [flight_id, run_number]).fetchall()
