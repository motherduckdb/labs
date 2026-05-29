"""Bootstrapper for the nba_backfill Flight.

Thin, stable bootstrapper (see flights/nba_nightly/main.py for the full
rationale): clones the labs repo at a branch, `uv sync`s the pipeline
package, and runs the backfill entrypoint from the synced venv.

Env vars consumed here:
  NBA_FLIGHT_REPO_BRANCH   branch to clone (default: nba-migration)
Required by the entrypoint (pass through to the subprocess):
  NBA_BACKFILL_START_SEASON / NBA_BACKFILL_END_SEASON
Plus the usual NBA_INGEST_* / MOTHERDUCK_TOKEN.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

REPO_URL = "https://github.com/motherduckdb/labs"
DEFAULT_BRANCH = "nba-migration"
REPO_DIR = Path("/app/labs")
PROJECT_SUBDIR = REPO_DIR / "projects" / "nba-box-scores-pipeline"
ENTRYPOINT_COMMAND = "backfill"


def sh(cmd, cwd=None, env=None, check=True):
    print("$ " + cmd, flush=True)
    merged = dict(os.environ)
    merged.update(env or {})
    r = subprocess.run(
        cmd, shell=True, cwd=str(cwd) if cwd else None,
        env=merged, capture_output=True, text=True,
    )
    if r.stdout:
        print(r.stdout, flush=True)
    if r.stderr:
        print("STDERR:", r.stderr, flush=True)
    if check and r.returncode != 0:
        raise RuntimeError("command failed rc=" + str(r.returncode) + ": " + cmd)
    return r


def ensure_git():
    if shutil.which("git"):
        return
    sh("apt-get update -y", check=False)
    sh("apt-get install -y --no-install-recommends git ca-certificates")


def main():
    print("python:", sys.version, flush=True)
    branch = os.environ.get("NBA_FLIGHT_REPO_BRANCH", DEFAULT_BRANCH)

    ensure_git()
    if REPO_DIR.exists():
        shutil.rmtree(REPO_DIR)
    sh(f"git clone --depth 1 --branch {branch} {REPO_URL} {REPO_DIR}")
    sh("git log -1 --oneline", cwd=REPO_DIR)

    sh("uv sync", cwd=PROJECT_SUBDIR, env={"UV_LINK_MODE": "copy"})
    sh(
        f".venv/bin/python -m nba_box_scores_pipeline.entrypoints {ENTRYPOINT_COMMAND}",
        cwd=PROJECT_SUBDIR,
    )


if __name__ == "__main__":
    main()
