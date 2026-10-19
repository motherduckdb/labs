"""MotherDuck connections and run context shared by pipelines, checker, fixer and watchdog."""
import functools
import os

import duckdb

STATE_DB = os.environ.get("HEAL_STATE_DB", "heal")
CHAOS_DB = os.environ.get("HEAL_CHAOS_DB", "heal_chaos")


def data_db() -> str:
    """Where pipelines write. The fixer's sandbox runs point this at a zero-copy clone."""
    return os.environ.get("HEAL_DATA_DB", "heal_lake")


def connect(read_only_token: bool = False) -> duckdb.DuckDBPyConnection:
    con = duckdb.connect("md:")
    # Flights report TZ as Etc/Unknown, which breaks every TIMESTAMPTZ fetch; pin UTC.
    con.execute("SET TimeZone='UTC'")
    return con


@functools.lru_cache(maxsize=1)
def shared() -> duckdb.DuckDBPyConnection:
    return connect()


def run_context() -> dict:
    """What this Flight run is: ids from the Flights runtime, sha and ref from the loader."""
    env = os.environ
    return {
        "flight_id": env.get("MOTHERDUCK_FLIGHT_ID"),
        "run_number": int(env["MOTHERDUCK_FLIGHT_RUN_NUMBER"]) if env.get("MOTHERDUCK_FLIGHT_RUN_NUMBER") else None,
        "run_id": env.get("MOTHERDUCK_FLIGHT_RUN_ID"),
        "sha": env.get("HEAL_SHA"),
        "ref": env.get("HEAL_REF"),
        "pipeline": env.get("HEAL_PIPELINE"),
        "sandbox": env.get("HEAL_SANDBOX") == "1",
    }
