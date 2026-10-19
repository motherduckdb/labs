"""Bootstrap loader: the only code stored in each self-healing Flight.

Every run: shallow sparse clone of HEAL_REPO@HEAL_REF -> install the component's requirements -> run
HEAL_ENTRY -> record the sha in heal.code_versions. After a green run the code is cached in
heal.code_cache; if GitHub is unreachable the run uses that cache and reports a class-17 healer fault.
Config: HEAL_COMPONENT, HEAL_ENTRY, HEAL_REF, HEAL_REPO, HEAL_PROJECT_PATH. Optional secret `github`.
"""
import io, json, os, subprocess, sys, tarfile, uuid
import duckdb

E = os.environ
REPO, REF = E.get("HEAL_REPO", "motherduckdb/labs"), E.get("HEAL_REF", "main")
PROJ, COMP, ENTRY = E.get("HEAL_PROJECT_PATH", "projects/self-healing-pipelines"), E["HEAL_COMPONENT"], E["HEAL_ENTRY"]
TOKEN = E.get("github_GITHUB_TOKEN", "")
WORK, con = "/tmp/heal_src", duckdb.connect("md:")
con.execute("SET TimeZone='UTC'")
run_no, fid = E.get("MOTHERDUCK_FLIGHT_RUN_NUMBER"), E.get("MOTHERDUCK_FLIGHT_ID")
CACHE_KEY = f"{REF}#{COMP}"  # last good code per component: one green pipeline must not vouch for another


def sh(cmd, **kw):
    return subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=180, **kw)


auth = f"x-access-token:{TOKEN}@" if TOKEN else ""
r = sh(f"rm -rf {WORK} && git clone -q --depth 1 --filter=blob:none --sparse --branch {REF} https://{auth}github.com/{REPO} {WORK}"
       f" && git -C {WORK} sparse-checkout set {PROJ} && git -C {WORK} rev-parse HEAD")
if r.returncode == 0:
    sha, source = r.stdout.strip().splitlines()[-1], "git"
else:
    err = r.stderr.replace(TOKEN, "<token>") if TOKEN else r.stderr
    print(f"loader: clone of {REPO}@{REF} failed: {err.strip()[-400:]}", flush=True)
    row = con.execute("SELECT sha, tarball FROM heal.main.code_cache WHERE ref = ?", [CACHE_KEY]).fetchone()
    if not row:
        sys.exit(f"loader: GitHub unreachable and no cached code for {REF}")
    sha, source = row[0], "cache"
    os.makedirs(f"{WORK}/{PROJ}", exist_ok=True)
    tarfile.open(fileobj=io.BytesIO(row[1])).extractall(f"{WORK}/{PROJ}", filter="data")
    ev = {"v": 1, "event_uid": f"{E.get('MOTHERDUCK_FLIGHT_RUN_ID', uuid.uuid4())}:loader", "kind": "healer", "severity": "error",
          "pipeline": COMP, "error_type": "GitHubUnreachable", "message": f"clone of {REPO}@{REF} failed; ran cached sha {sha[:10]}"}
    print("HEAL_EVENT " + json.dumps(ev), flush=True)
    con.execute("""INSERT OR IGNORE INTO heal.main.pipeline_events (event_uid, ts, pipeline, flight_id, run_number, run_id, sha, kind,
                   severity, error_type, message) VALUES (?, now(), ?, ?::UUID, ?, ?, ?, 'healer', 'error', 'GitHubUnreachable', ?)""",
                [ev["event_uid"], COMP, fid, run_no, E.get("MOTHERDUCK_FLIGHT_RUN_ID"), sha, ev["message"]])

root = f"{WORK}/{PROJ}"
if source == "git":  # direct mode: apply active healer patches (a cached tarball already contains them)
    applied = []
    for pid, patch in con.execute("SELECT patch_id, patch FROM heal.main.code_patches WHERE ref = ? AND status = 'active' ORDER BY patch_id",
                                  [REF]).fetchall():
        open(f"/tmp/heal_patch_{pid}.diff", "w").write(patch)
        ok = sh(f"git -C {WORK} apply --whitespace=nowarn /tmp/heal_patch_{pid}.diff")
        print(f"loader: patch {pid} {'applied' if ok.returncode == 0 else 'FAILED: ' + ok.stderr.strip()[-300:]}", flush=True)
        if ok.returncode == 0:
            applied.append(str(pid))
    if applied:
        sha = f"{sha}+p{'.'.join(applied)}"
con.execute("INSERT INTO heal.main.code_versions (component, flight_id, run_number, ref, sha, source) VALUES (?, ?::UUID, ?, ?, ?, ?)",
            [COMP, fid, run_no, REF, sha, source])
print(f"loader: {COMP} {REPO}@{REF} sha={sha} source={source}", flush=True)
req = os.path.join(root, os.path.dirname(ENTRY), "requirements.txt")
if os.path.exists(req):
    pip = sh(f"uv pip install -q -r {req} || python -m pip install -q -r {req}")
    if pip.returncode:
        print(pip.stdout[-2000:], pip.stderr[-2000:], flush=True)
        sys.exit(f"loader: dependency install failed for {req}")
env = {**E, "HEAL_SHA": sha, "HEAL_REF": REF, "HEAL_CODE_SOURCE": source, "HEAL_ROOT": root,
       "PYTHONPATH": root + os.pathsep + E.get("PYTHONPATH", "")}
code = subprocess.run([sys.executable, "-u", os.path.join(root, ENTRY)], cwd=root, env=env).returncode
if code == 0 and source == "git":
    cached = con.execute("SELECT sha FROM heal.main.code_cache WHERE ref = ?", [CACHE_KEY]).fetchone()
    if not cached or cached[0] != sha:
        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode="w:gz") as tf:
            tf.add(root, arcname=".", filter=lambda ti: None if "/.git" in ti.name else ti)
        con.execute("INSERT OR REPLACE INTO heal.main.code_cache (ref, sha, tarball, cached_at) VALUES (?, ?, ?, now())",
                    [CACHE_KEY, sha, buf.getvalue()])
sys.exit(code)
