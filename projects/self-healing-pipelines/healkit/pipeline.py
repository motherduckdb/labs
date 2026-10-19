"""Entry wrapper for every pipeline: load, run data tests, report failures as HEAL_EVENTs, exit non-zero.

    from healkit import pipeline
    def load(ctx): ...
    if __name__ == "__main__":
        pipeline.main("p1_wiki", load)
"""
import os
import sys
import time
import traceback
from dataclasses import dataclass, field

from . import db, events, tests
from .http import Http, HttpError
from .registry import pipeline as pipeline_cfg


@dataclass
class Context:
    name: str
    con: object
    db: str
    http: Http | None = None
    stats: dict = field(default_factory=dict)

    def table(self, rel: str) -> str:
        return f"{self.db}.{rel}"


def _resource_for(name: str, exc: BaseException) -> str | None:
    if not (isinstance(exc, HttpError) and exc.host):
        return None
    secrets = [r for r in pipeline_cfg(name).get("resources", []) if r.startswith("secret:")]
    if exc.status == 401 and secrets:
        return secrets[0]   # a 401 is about the credential, which other jobs may share
    return f"host:{exc.host}"


def main(name: str, load, transactional: bool = False):
    """transactional: load + tests run in one transaction that rolls back when an error test fails, so
    bad rows never land and watermarks don't advance. HEAL_EVENTs use a separate connection and persist."""
    os.environ.setdefault("HEAL_PIPELINE", name)
    t0 = time.time()
    con = db.connect()
    ctx = Context(name=name, con=con, db=db.data_db())
    con.execute(f"CREATE SCHEMA IF NOT EXISTS {ctx.db}.{name}")
    print(f"[{name}] sha={os.environ.get('HEAL_SHA')} data_db={ctx.db} sandbox={db.run_context()['sandbox']}", flush=True)
    try:
        if transactional:
            con.execute("BEGIN TRANSACTION")
        load(ctx)
        print(f"[{name}] load done in {time.time() - t0:.1f}s {ctx.stats}", flush=True)
        tests.run(con, name)
        if transactional:
            con.execute("COMMIT")
    except tests.DataTestFailed as e:
        if transactional:
            con.execute("ROLLBACK")
            print(f"[{name}] rolled back the load", flush=True)
        print(f"[{name}] FAILED data tests: {e}", flush=True)
        sys.exit(1)
    except BaseException as e:  # noqa: BLE001 - report everything, then fail the run
        if isinstance(e, SystemExit) and e.code in (0, None):
            raise
        if transactional:
            try:
                con.execute("ROLLBACK")
            except Exception:
                pass
        frames = events.top_frames(e.__traceback__)
        events.emit("error", "error", f"{type(e).__name__}: {e}", resource=_resource_for(name, e),
                    error_type=type(e).__name__, http_status=getattr(e, "status", None), frames=frames,
                    detail={"headers": getattr(e, "headers", None), "elapsed_s": round(time.time() - t0, 1)})
        traceback.print_exc()
        sys.exit(1)
    events.emit("info", "info", f"{name} green", detail={"elapsed_s": round(time.time() - t0, 1), **ctx.stats})
