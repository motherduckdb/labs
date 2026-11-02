"""Save Flight for editable slide-deck Dives.

The deck Dive batches every edit into one override bag (useDiveState("ov")). Its Save button runs
this Flight with that bag; the Flight bakes the bag into the Dive's SCENE and writes a new Dive
version. Only the SCENE block between the sentinels changes — the framework code is never touched.

The bake runs the merge core INLINED IN THE LIVE DIVE SOURCE (between __MERGE_CORE_START__ and
__MERGE_CORE_END__), under Node. That is the same code the browser editor ran, so the bake here and
the preview there cannot disagree, and a Dive assembled from an older template bakes with its own
older core.

Config (all strings, all supplied by the Dive on each run — treat as untrusted):
  DIVE_ID       UUID of the deck Dive to write
  BASE_VERSION  SCENE.version the edits were made against (stale-save guard)
  OVERRIDES     the override bag, JSON

Exit codes the Dive maps to messages:
  2 bad input · 3 stale (someone saved first) · 4 edits rejected by the bake
  5 result too large · 6 Dive not allowed / not an editable deck · 1 anything else
"""

# @flight
#   flowchart TD
#     validate[Validate config]:::check --> fetch[Fetch live Dive source]:::extract
#     fetch --> guard{Version matches?}:::check
#     guard --> bake[Bake edits with the Dive's own merge core]:::transform
#     bake --> write[Write new Dive version]:::load
#     write --> verify[Re-read and compare]:::check
# @end-flight

import json
import os
import re
import sys
import tempfile
import time

import duckdb
from nodejs_wheel import node

# Deployment host. Hardcoded on purpose: config is caller-controlled, and a caller-chosen host
# would receive the owner's token. Set this to the MotherDuck API host of the deployment the
# decks live in (production: api.motherduck.com).
MOTHERDUCK_HOST = "api.motherduck.com"

# Dives this Flight may write. Anyone with RUN on this Flight writes with the OWNER's token, so the
# list is what bounds a run grant. Empty = any editable deck the owner owns (fine while unshared).
ALLOWED_DIVE_IDS = {
    # "<dive uuid>",  # <deck title>   (add one line per deck this Flight may write)
}

LOG_DB = "editable_deck_saves"
MAX_OVERRIDE_BYTES = 65536
MAX_SOURCE_BYTES = 1024 * 1024
SCENE_START = "// __SCENE_START__"
SCENE_END = "// __SCENE_END__"
CORE_START = "// __MERGE_CORE_START__"
CORE_END = "// __MERGE_CORE_END__"
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")

# Runs bakeScene from the Dive's own core and serializes the result exactly as the Vercel Save
# service does (source.mjs serializeSceneLiteral): JSON, plus escapes so no string can become code
# or a second sentinel.
BAKE_DRIVER = r"""
const input = JSON.parse(require("fs").readFileSync(0, "utf8"));
try {
  const baked = bakeScene(input.scene, input.overrides, { maxOverrideBytes: 65536 });
  const literal = JSON.stringify(baked.scene, null, 2)
    .replaceAll("// __SCENE_START__", "\\/\\/ __SCENE_START__")
    .replaceAll("// __SCENE_END__", "\\/\\/ __SCENE_END__")
    .replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  const resources = mapRequiredResources(input.resources);
  process.stdout.write(JSON.stringify({ ok: true, literal, summary: baked.summary, resources }));
} catch (e) {
  process.stdout.write(JSON.stringify({ ok: false, code: (e && e.code) || "BAKE_FAILED", message: String((e && e.message) || e) }));
}
"""


class SaveError(Exception):
    def __init__(self, exit_code, message):
        super().__init__(message)
        self.exit_code = exit_code


def step(node_id, state, **fields):
    extra = " ".join(f'{k}="{v}"' if " " in str(v) else f"{k}={v}" for k, v in fields.items())
    print(f"@flight-run {node_id} {state} {extra}".rstrip(), flush=True)


def unique_index(source, marker):
    first = source.find(marker)
    if first < 0 or source.find(marker, first + len(marker)) >= 0:
        raise SaveError(6, f"the Dive source must contain exactly one {marker!r}")
    return first


def extract_scene(source):
    start = unique_index(source, SCENE_START) + len(SCENE_START)
    end = unique_index(source, SCENE_END)
    body = source[start:end].strip()
    if not body.startswith("const SCENE = ") or not body.endswith(";"):
        raise SaveError(6, "the Dive's scene block is not canonical JSON")
    return json.loads(body[len("const SCENE = "):-1]), start, end


def read_config():
    dive_id = os.environ.get("DIVE_ID", "").strip().lower()
    base = os.environ.get("BASE_VERSION", "").strip()
    raw = os.environ.get("OVERRIDES", "")
    if not UUID_RE.match(dive_id):
        raise SaveError(2, "DIVE_ID is not a UUID")
    if not base.isdigit():
        raise SaveError(2, "BASE_VERSION is not a non-negative integer")
    if not raw or len(raw.encode("utf-8")) > MAX_OVERRIDE_BYTES:
        raise SaveError(5 if raw else 2, "OVERRIDES is empty or over 64 KB")
    try:
        overrides = json.loads(raw)
    except ValueError:
        raise SaveError(2, "OVERRIDES is not JSON")
    if not isinstance(overrides, dict):
        raise SaveError(2, "OVERRIDES must be a JSON object")
    if ALLOWED_DIVE_IDS and dive_id not in ALLOWED_DIVE_IDS:
        raise SaveError(6, "this Flight is not allowed to write that Dive")
    return dive_id, int(base), overrides


def bake(source, scene, overrides, resources):
    core = source[unique_index(source, CORE_START):unique_index(source, CORE_END)]
    with tempfile.TemporaryDirectory() as tmp:
        script = os.path.join(tmp, "bake.cjs")
        with open(script, "w") as f:
            f.write(core + "\n" + BAKE_DRIVER)
        proc = node(
            [script],
            return_completed_process=True,
            input=json.dumps({"scene": scene, "overrides": overrides, "resources": resources}),
            capture_output=True,
            text=True,
            timeout=60,
        )
    if proc.returncode != 0:
        raise SaveError(1, f"bake process failed: {proc.stderr[-500:]}")
    out = json.loads(proc.stdout)
    if not out["ok"]:
        code = 3 if out["code"] == "STALE_BASE" else 5 if out["code"] == "PAYLOAD_TOO_LARGE" else 4
        raise SaveError(code, f"{out['code']}: {out['message']}")
    return out


def main():
    started = time.time()
    run_id = os.environ.get("MOTHERDUCK_FLIGHT_RUN_ID", "")
    os.environ["motherduck_host"] = MOTHERDUCK_HOST
    con = None
    dive_id, base = None, None
    try:
        step("validate", "running")
        dive_id, base, overrides = read_config()
        step("validate", "ok")

        step("fetch", "running")
        con = duckdb.connect(f"md:{LOG_DB}?attach_mode=single")
        row = con.execute(
            "SELECT content, current_version, to_json(version_required_resources) "
            "FROM MD_GET_DIVE(id := ?::UUID)",
            [dive_id],
        ).fetchone()
        if row is None:
            raise SaveError(6, "Dive not found")
        source, dive_version, resources_json = row
        if len(source.encode("utf-8")) > MAX_SOURCE_BYTES:
            raise SaveError(6, "the live Dive source is over 1 MB")
        scene, body_start, body_end = extract_scene(source)
        step("fetch", "ok", dive_version=dive_version)

        step("guard", "running")
        if str(scene.get("diveId", "")).lower() != dive_id:
            raise SaveError(6, "the Dive's SCENE.diveId does not match DIVE_ID")
        if scene.get("version") != base:
            raise SaveError(3, f"stale: edits were made on scene version {base}, the Dive is now at {scene.get('version')}")
        step("guard", "ok")

        step("bake", "running")
        resources = json.loads(resources_json) if resources_json else []
        out = bake(source, scene, overrides, resources)
        content = source[:body_start] + "\nconst SCENE = " + out["literal"] + ";\n" + source[body_end:]
        if len(content.encode("utf-8")) > MAX_SOURCE_BYTES:
            raise SaveError(5, "the saved Dive would be over 1 MB")
        step("bake", "ok")

        step("write", "running")
        res = out["resources"]
        con.execute(
            "SELECT version FROM MD_UPDATE_DIVE_CONTENT(id := ?::UUID, content := ?, "
            "required_resources := ?::STRUCT(url VARCHAR, alias VARCHAR)[])",
            [dive_id, content, [{"url": r["url"], "alias": r["alias"]} for r in res]],
        ).fetchone()
        step("write", "ok")

        step("verify", "running")
        stored = con.execute("SELECT content FROM MD_GET_DIVE(id := ?::UUID)", [dive_id]).fetchone()[0]
        if stored != content:
            raise SaveError(1, "re-read after write does not match what was written")
        step("verify", "ok")

        summary = out["summary"]
        log(con, run_id, dive_id, base, "SAVED", json.dumps(summary), started)
        print("SAVED", json.dumps(summary), flush=True)
        step("@flight", "ok")
    except SaveError as e:
        print(f"SAVE FAILED ({e.exit_code}): {e}", flush=True)
        log(con, run_id, dive_id, base, f"FAILED_{e.exit_code}", str(e), started)
        step("@flight", "failed", exit=e.exit_code)
        sys.exit(e.exit_code)
    except Exception as e:
        print(f"SAVE FAILED (1): {type(e).__name__}: {e}", flush=True)
        log(con, run_id, dive_id, base, "FAILED_1", f"{type(e).__name__}: {e}", started)
        step("@flight", "failed", exit=1)
        sys.exit(1)


def log(con, run_id, dive_id, base, outcome, detail, started):
    if con is None:
        return
    try:
        con.execute(
            f'INSERT INTO "{LOG_DB}".main.save_log VALUES (now(), ?, ?, ?, ?, ?, ?)',
            [run_id, dive_id, base, outcome, detail[:2000], round(time.time() - started, 2)],
        )
    except Exception as e:  # the log is a convenience; never fail a save over it
        print("log insert failed:", e, flush=True)


if __name__ == "__main__":
    main()
