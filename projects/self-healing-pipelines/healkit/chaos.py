"""World config: the stand-in for upstream behaviour during scenarios.

Knobs live in heal_chaos.main.world, keyed by (pipeline, knob); pipeline '*' applies to all. A knob
with runs_remaining counts down once per production run and disappears at 0.

The fixer can never read this table: its SQL broker rejects any reference to heal_chaos, and its
sandbox runs receive a snapshot through HEAL_CHAOS_SNAPSHOT that the broker reads on its behalf, so a
fix can only change how the pipeline copes with the world, never the world.

Knobs understood by healkit.http (host is the request's hostname):
  headers.<host>    JSON object of headers the "upstream" now requires/sends (e.g. NWS Feature-Flags)
  route.<host>      replace scheme+host+path with this URL (e.g. https://httpbingo.org/status/503)
  flaky.<host>      probability 0..1 that a request is routed to httpbingo /status/503
  ratelimit.<host>  N: the first N attempts of each distinct URL get a real 429 from httpbingo
  auth.<host>       'bad' replaces the Authorization header with an invalid token
Pipeline-specific knobs (articles, windows, fixture paths) are read by the pipeline with chaos.get().
"""
import functools
import json
import os

from . import db


@functools.lru_cache(maxsize=None)
def world(pipeline: str) -> dict:
    if os.environ.get("HEAL_CHAOS", "on") == "off":
        return {}
    snap = os.environ.get("HEAL_CHAOS_SNAPSHOT")
    if snap is not None:
        return json.loads(snap or "{}")
    try:
        con = db.shared()
        rows = con.execute(
            f"""SELECT knob, value FROM {db.CHAOS_DB}.main.world
                WHERE pipeline IN (?, '*') AND coalesce(runs_remaining, 1) > 0
                ORDER BY pipeline = '*' DESC""", [pipeline]).fetchall()
        if rows and not db.run_context()["sandbox"]:
            con.execute(f"""UPDATE {db.CHAOS_DB}.main.world SET runs_remaining = runs_remaining - 1
                            WHERE pipeline IN (?, '*') AND runs_remaining IS NOT NULL""", [pipeline])
            con.execute(f"DELETE FROM {db.CHAOS_DB}.main.world WHERE runs_remaining <= 0")
    except Exception:
        return {}
    return {k: v for k, v in rows}


def get(pipeline: str, knob: str, default=None):
    return world(pipeline).get(knob, default)
