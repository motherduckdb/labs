"""P2: NWS api.weather.gov 7-day forecast periods for a few grid points.

forecast_periods is the latest snapshot (replaced each run); forecast_history keeps every fetch.
"""
import json

from healkit import pipeline, tests
from healkit.execute import execute
from healkit.http import Http

NAME = "p2_nws"
GRIDS = {"seattle": "SEW/125,68", "new_york": "OKX/33,42", "los_angeles": "LOX/155,45"}
USER_AGENT = "motherduck-labs-self-healing-p2/1.0 (https://github.com/motherduckdb/labs)"


def load(ctx):
    con = ctx.con
    http = Http(NAME, user_agent=USER_AGENT)
    rows = []
    for city, grid in GRIDS.items():
        doc = http.get_json(f"https://api.weather.gov/gridpoints/{grid}/forecast", headers={"Accept": "application/geo+json"})
        for p in doc["properties"]["periods"]:
            rows.append((city, grid, p["number"], p["name"], p["startTime"], p["endTime"], p["isDaytime"],
                         json.dumps(p.get("temperature")), p.get("temperatureUnit"), p.get("windSpeed"), p.get("shortForecast")))
    con.execute("""CREATE OR REPLACE TEMP TABLE stg_periods (city VARCHAR, grid VARCHAR, number INTEGER, name VARCHAR,
        start_time TIMESTAMPTZ, end_time TIMESTAMPTZ, is_daytime BOOLEAN, temperature_raw VARCHAR, temperature_unit VARCHAR,
        wind_speed VARCHAR, short_forecast VARCHAR)""")
    con.executemany("INSERT INTO stg_periods VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", rows)
    select = """SELECT city, grid, number, name, start_time, end_time, is_daytime,
                       TRY_CAST(temperature_raw AS DOUBLE) AS temperature, temperature_unit, temperature_raw, wind_speed, short_forecast,
                       now() AS fetched_at FROM stg_periods"""
    execute(con, f"CREATE OR REPLACE TABLE {ctx.table(NAME + '.forecast_periods')} AS {select}")
    execute(con, f"CREATE TABLE IF NOT EXISTS {ctx.table(NAME + '.forecast_history')} AS {select} LIMIT 0")
    execute(con, f"INSERT INTO {ctx.table(NAME + '.forecast_history')} {select}")
    tests.record_volume(con, f"{NAME}.forecast_periods", len(rows))
    ctx.stats.update(rows=len(rows), requests=http.requests_made)


if __name__ == "__main__":
    # Not transactional on purpose: a bad snapshot lands and downstream marts see it (the cascade case).
    pipeline.main(NAME, load)
