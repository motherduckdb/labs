"""P4: USGS earthquake catalog (FDSN event API) over a trailing window, upserted by event id.

Run config: RUN_BACKFILL_DAYS (intentional backfill; default 0).
"""
import os
from datetime import datetime, timedelta, timezone

from healkit import chaos, pipeline, tests
from healkit.execute import execute
from healkit.http import Http

NAME = "p4_usgs"
BASE = "https://earthquake.usgs.gov/fdsnws/event/1"


def load(ctx):
    con = ctx.con
    window_days = int(chaos.get(NAME, "window_days", "1"))
    min_mag = float(chaos.get(NAME, "min_magnitude", "2.5"))
    backfill = int(os.environ.get("RUN_BACKFILL_DAYS") or 0)
    if backfill:
        print(f"[{NAME}] intentional backfill requested: {backfill} days", flush=True)
        window_days = max(window_days, backfill)
    end = datetime.now(timezone.utc)
    start = end - timedelta(days=window_days)
    print(f"[{NAME}] window {start:%Y-%m-%d %H:%M} .. {end:%Y-%m-%d %H:%M} ({window_days} days), M>={min_mag}", flush=True)

    http = Http(NAME, user_agent="motherduck-labs-self-healing-p4/1.0 (https://github.com/motherduckdb/labs)", timeout=90)
    doc = http.get_json(f"{BASE}/query", params={"format": "geojson", "starttime": start.isoformat(timespec="seconds"),
                                                   "endtime": end.isoformat(timespec="seconds"), "minmagnitude": min_mag,
                                                   "orderby": "time"})
    rows = []
    for f in doc["features"]:
        p, (lon, lat, depth) = f["properties"], f["geometry"]["coordinates"]
        rows.append((f["id"], p["mag"], p["magType"], p["place"], datetime.fromtimestamp(p["time"] / 1000, timezone.utc),
                     datetime.fromtimestamp(p["updated"] / 1000, timezone.utc), lat, lon, depth, p.get("felt"), p.get("alert"),
                     p.get("tsunami"), p.get("status"), p.get("type")))
    tbl = ctx.table(NAME + ".earthquakes")
    execute(con, f"""CREATE TABLE IF NOT EXISTS {tbl} (id VARCHAR PRIMARY KEY, mag DOUBLE, mag_type VARCHAR, place VARCHAR,
        time TIMESTAMPTZ, updated TIMESTAMPTZ, lat DOUBLE, lon DOUBLE, depth_km DOUBLE, felt INTEGER, alert VARCHAR,
        tsunami INTEGER, status VARCHAR, event_type VARCHAR, loaded_at TIMESTAMPTZ DEFAULT now())""")
    con.execute(f"CREATE OR REPLACE TEMP TABLE stg_quakes AS SELECT * EXCLUDE (loaded_at) FROM {tbl} LIMIT 0")
    if rows:
        con.executemany("INSERT INTO stg_quakes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", rows)
        execute(con, f"INSERT OR REPLACE INTO {tbl} SELECT *, now() FROM stg_quakes")
    tests.record_volume(con, f"{NAME}.earthquakes", len(rows))
    ctx.stats.update(rows=len(rows), window_days=window_days, backfill_days=backfill, requests=http.requests_made)


if __name__ == "__main__":
    pipeline.main(NAME, load)
