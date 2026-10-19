"""CI: run the deterministic guard report on a heal PR and fail on hard violations.

    python scripts/ci_guard.py --base <sha> --head-ref heal/7-a1 --body-file body.md
A heal PR is one from a `heal/*` branch (labels are added after the PR opens, so they can't be relied
on at the first CI run); its level is the "**Autonomy:** `Lx`" line the fixer writes in the body.
Non-heal PRs (humans) only get unit tests; the guard is for automated fixes.
"""
import argparse
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from healer.guards import guards  # noqa: E402
from healkit.registry import registry  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("--base", required=True)
ap.add_argument("--head-ref", required=True)
ap.add_argument("--body-file", required=True)
a = ap.parse_args()
if not a.head_ref.startswith("heal/"):
    print("not a heal PR; guard skipped")
    sys.exit(0)
import re  # noqa: E402
body = pathlib.Path(a.body_file).read_text()
m = re.search(r"\*\*Autonomy:\*\* `(L[123])`", body)
level = m.group(1) if m else "L3"
repo = subprocess.run(["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True, check=True).stdout.strip()
prefix = registry()["project_path"]
changed = subprocess.run(["git", "diff", "--name-only", a.base, "HEAD", "--", prefix], capture_output=True, text=True, cwd=repo).stdout.split()
pipes = sorted({p.split("/")[3] for p in changed if p.startswith(f"{prefix}/pipelines/") and len(p.split("/")) > 4})
healer_change = any(not p.startswith(f"{prefix}/pipelines/") for p in changed)
if a.head_ref.endswith("-revert"):
    print("revert PR: guard skipped (restores previously reviewed code)")
    sys.exit(0)
if len(pipes) > 1:
    print(f"FAIL: a heal PR may touch one pipeline, got {pipes}")
    sys.exit(1)
pipeline = pipes[0] if pipes else "healer"
subprocess.run(["git", "checkout", "-q", "HEAD"], cwd=repo)
r = guards.report(repo, a.base, pipeline, level, healer_incident=(pipeline == "healer" or healer_change))
print(guards.render(r))
if not r["ok"]:
    print("FAIL: hard guard violations")
    sys.exit(1)
if level == "L2" and r["l2_blocks"]:
    print("FAIL: L2 PR with L2 guard blocks (should have been an L3 proposal)")
    sys.exit(1)
print("guard OK")
