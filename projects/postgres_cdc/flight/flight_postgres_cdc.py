"""MotherDuck Postgres-CDC replication proof (Flight).

Resolves the `etl-replicator` from the LATEST SUCCESSFUL CI build of the
`postgres_cdc-build.yml` workflow ON LABS (motherduckdb/labs), verified against
the commit SHA + a sha256 checksum via the rolling `postgres_cdc-replicator`
release + its `latest.json`, then replicates a small PlanetScale table
(`tpch.region`) into a NATIVE MotherDuck database using the in-place
DuckLake destination config with a `md:<database>` catalog URL:

  {"destination":{"ducklake":{
      "catalog_url":"md:<database>",
      "metadata_catalog_url":"postgres://…?sslmode=require",
      "metadata_schema":"…",
      "maintenance_mode":"disabled"}},
   "pipeline":{…}}

Proves backfill lands (row count in MotherDuck == source count). Non-destructive:
does not modify the source table. Never touches the `lineitem` table.
"""
import gzip, hashlib, json, os, shutil, subprocess, time, urllib.request, urllib.error
import certifi, duckdb, psycopg


def env(n, d=None):
    return os.environ.get(n, d)


H = env("PGHOST", "us-east-2.pg.psdb.cloud")
PORT = int(env("PGPORT", "5432"))
DB = env("PGDATABASE", "postgres")
U = env("PGUSER", "pscale_api_s6z748j4md6b.sbodytoesjz2")
MD_DB = env("MD_DB", "postgres_cdc_labs")
SRC_SCHEMA = env("SRC_SCHEMA", "tpch")
SRC_TABLE = env("SRC_TABLE", "region")
PID = int(env("PIPELINE_ID", "911"))
PUB = env("PUBLICATION_NAME", "postgres_cdc_labs_pub")
META_SCHEMA = env("METADATA_SCHEMA", "postgres_cdc_labs_meta")
BIN = "/tmp/etl-replicator-postgres-cdc"
CFG = "/tmp/etl_postgres_cdc_cfg"
# --- Resolver: pull the LATEST SUCCESSFUL CI build of the replicator ---
# Instead of a hardcoded release URL, resolve the binary from the newest green
# run of the build workflow, verified against the commit SHA + a sha256 checksum.
BUILD_REPO = env("BUILD_REPO", "motherduckdb/labs")
BUILD_WORKFLOW = env("BUILD_WORKFLOW", "postgres_cdc-build.yml")
BUILD_BRANCH = env("BUILD_BRANCH", "postgres_cdc")
RELEASE_TAG = env("RELEASE_TAG", "postgres_cdc-replicator")
PIN_SHA = env("PIN_SHA")  # optional: pin to a specific commit sha (skips the API)


def pw():
    return os.environ["planetscale_cdc_password"]


def pg():
    return psycopg.connect(
        host=H, port=PORT, dbname=DB, user=U, password=pw(),
        sslmode="require", autocommit=True,
    )


def md():
    return duckdb.connect("md:")


def meta_url():
    return f"postgres://{U}:{pw()}@{H}:{PORT}/{DB}?sslmode=require"


def _http(url, accept=None, binary=False):
    req = urllib.request.Request(url)
    if accept:
        req.add_header("Accept", accept)
    tok = env("GITHUB_TOKEN")  # optional: only raises API rate limits
    if tok:
        req.add_header("Authorization", f"Bearer {tok}")
    with urllib.request.urlopen(req, timeout=60) as r:
        data = r.read()
    return data if binary else data.decode("utf-8")


def _latest_green_run():
    """Return (head_sha, run_id, run_url) for the newest successful workflow run."""
    api = (
        f"https://api.github.com/repos/{BUILD_REPO}/actions/workflows/"
        f"{BUILD_WORKFLOW}/runs?branch={BUILD_BRANCH}&status=success&per_page=1"
    )
    payload = json.loads(_http(api, accept="application/vnd.github+json"))
    runs = payload.get("workflow_runs") or []
    if not runs:
        raise RuntimeError(
            f"no successful runs of {BUILD_WORKFLOW} on branch {BUILD_BRANCH} in {BUILD_REPO}"
        )
    r = runs[0]
    return r["head_sha"], r["id"], r.get("html_url")


def resolve_binary():
    """Resolve + verify the replicator binary from the latest successful CI build.

    Returns a metadata dict (sha/run_id/run_url/built_at) for traceability.
    Aborts (raises) on any resolution or verification failure so we never spawn
    the replicator with a stale or corrupt binary.
    """
    if PIN_SHA:
        target_sha, run_id, run_url = PIN_SHA, None, None
        print(f"[resolve] PIN_SHA set -> targeting sha {target_sha}", flush=True)
    else:
        target_sha, run_id, run_url = _latest_green_run()
        print(
            f"[resolve] latest green run: sha={target_sha} run_id={run_id} url={run_url}",
            flush=True,
        )

    # Fetch the release manifest (public, no auth needed).
    base = f"https://github.com/{BUILD_REPO}/releases/download/{RELEASE_TAG}"
    manifest = json.loads(_http(f"{base}/latest.json"))
    print(f"[resolve] latest.json: {json.dumps(manifest)}", flush=True)

    # Verify the release matches the target commit (reject stale-release race).
    if manifest.get("sha") != target_sha:
        raise RuntimeError(
            "release/target SHA mismatch: latest.json.sha="
            f"{manifest.get('sha')} != target={target_sha}. "
            "Release is stale vs the newest green build; refusing to run."
        )

    asset = manifest.get("asset", "etl-replicator-linux-amd64.gz")
    want_sha256 = manifest["sha256"]
    # run_id/run_url come from latest.json when pinning (API was skipped).
    if run_id is None:
        run_id, run_url = manifest.get("run_id"), manifest.get("run_url")

    # Cache by sha: skip re-download if the same sha is already local + valid.
    sha_marker = BIN + ".sha"
    if os.path.exists(BIN) and os.path.exists(sha_marker):
        if open(sha_marker).read().strip() == target_sha:
            print(f"[resolve] cache hit for sha {target_sha}; skipping download", flush=True)
            _log_resolved(target_sha, run_id, run_url, manifest.get("built_at"))
            return {"sha": target_sha, "run_id": run_id, "run_url": run_url,
                    "built_at": manifest.get("built_at"), "cached": True}

    # Download the .gz asset and verify its sha256 against the manifest.
    gz = BIN + ".gz"
    gz_bytes = _http(f"{base}/{asset}", binary=True)
    got_sha256 = hashlib.sha256(gz_bytes).hexdigest()
    if got_sha256 != want_sha256:
        raise RuntimeError(
            f"checksum mismatch for {asset}: got {got_sha256} != latest.json {want_sha256}"
        )
    print(f"[resolve] sha256 verified: {got_sha256}", flush=True)

    # Cross-check against SHA256SUMS too (best-effort; must agree if present).
    try:
        sums = _http(f"{base}/SHA256SUMS")
        for line in sums.splitlines():
            parts = line.split()
            if len(parts) == 2 and parts[1].lstrip("*").endswith(asset):
                if parts[0] != want_sha256:
                    raise RuntimeError(
                        f"SHA256SUMS disagrees with latest.json for {asset}: "
                        f"{parts[0]} != {want_sha256}"
                    )
                print("[resolve] SHA256SUMS cross-check OK", flush=True)
    except urllib.error.HTTPError:
        pass

    with open(gz, "wb") as f:
        f.write(gz_bytes)
    with gzip.open(gz, "rb") as i, open(BIN, "wb") as o:
        shutil.copyfileobj(i, o)
    os.chmod(BIN, 0o755)
    open(sha_marker, "w").write(target_sha)
    print(f"[binary] {os.path.getsize(BIN)} bytes (sha {target_sha})", flush=True)
    _log_resolved(target_sha, run_id, run_url, manifest.get("built_at"))
    return {"sha": target_sha, "run_id": run_id, "run_url": run_url,
            "built_at": manifest.get("built_at"), "cached": False}


def _log_resolved(sha, run_id, run_url, built_at):
    print(
        "[RESOLVED] " + json.dumps(
            {"sha": sha, "run_id": run_id, "run_url": run_url, "built_at": built_at}
        ),
        flush=True,
    )


def source_count():
    with pg() as c:
        cur = c.cursor()
        cur.execute(f'select count(*) from "{SRC_SCHEMA}"."{SRC_TABLE}"')
        return cur.fetchone()[0]


def prepare_source():
    # Create a publication for exactly the one small table, and clear any stale
    # replication slots from a previous run of this pipeline id. The source
    # table itself is never modified.
    with pg() as c:
        cur = c.cursor()
        cur.execute(
            "select pg_terminate_backend(active_pid) from pg_replication_slots "
            "where active_pid is not null and (slot_name like %s or slot_name like %s)",
            (f"supabase_etl_apply_{PID}", f"supabase_etl_table_sync_{PID}_%"),
        )
        time.sleep(1)
        cur.execute(
            "select pg_drop_replication_slot(slot_name) from pg_replication_slots "
            "where slot_name like %s or slot_name like %s",
            (f"supabase_etl_apply_{PID}", f"supabase_etl_table_sync_{PID}_%"),
        )
        cur.execute("drop schema if exists etl cascade")
        cur.execute(f"drop publication if exists {PUB}")
        cur.execute(f'create publication {PUB} for table "{SRC_SCHEMA}"."{SRC_TABLE}"')
    print(f"[source] publication {PUB} -> {SRC_SCHEMA}.{SRC_TABLE}", flush=True)


def prepare_dest():
    con = md()
    con.execute(f'CREATE DATABASE IF NOT EXISTS "{MD_DB}"')
    con.execute(f'DROP SCHEMA IF EXISTS "{MD_DB}"."{SRC_SCHEMA}" CASCADE')
    for mk in ("__etl_applied_table_batches", "__etl_streaming_progress"):
        try:
            con.execute(f'DROP TABLE IF EXISTS "{MD_DB}"."main"."{mk}"')
        except Exception:
            pass
    # Also clear the replay-epoch bookkeeping schema in the metadata catalog.
    with pg() as c:
        c.cursor().execute(f'drop schema if exists "{META_SCHEMA}" cascade')
    print(f"[dest] reset MotherDuck database {MD_DB}", flush=True)


def write_cfg():
    os.makedirs(CFG, exist_ok=True)
    base = {
        "destination": {
            "ducklake": {
                "catalog_url": f"md:{MD_DB}",
                "metadata_catalog_url": meta_url(),
                "metadata_schema": META_SCHEMA,
                "maintenance_mode": "disabled",
            }
        },
        "pipeline": {
            "id": PID,
            "publication_name": PUB,
            "memory_backpressure": None,
            "pg_connection": {
                "host": H, "port": PORT, "name": DB, "username": U, "password": pw(),
                "tls": {"enabled": True, "trusted_root_certs": open(certifi.where()).read()},
            },
        },
    }
    json.dump(base, open(CFG + "/base.json", "w"))
    open(CFG + "/prod.json", "w").write("{}")
    print("[config] wrote base.json/prod.json (ducklake variant, md: catalog)", flush=True)


def spawn():
    e = dict(os.environ)
    e["motherduck_token"] = os.environ["MOTHERDUCK_TOKEN"]
    e["APP_CONFIG_DIR"] = CFG
    e["APP_ENVIRONMENT"] = "prod"
    e["RUST_LOG"] = "info,etl=info,etl_destinations=info"
    return subprocess.Popen([BIN], env=e)


def dest_count():
    try:
        return md().execute(
            f'select count(*) from "{MD_DB}"."{SRC_SCHEMA}"."{SRC_TABLE}"'
        ).fetchone()[0]
    except Exception:
        return 0


def main():
    binary = resolve_binary()  # aborts before spawn on any verify failure
    src_n = source_count()
    print(f"[source] {SRC_SCHEMA}.{SRC_TABLE} has {src_n} rows", flush=True)
    prepare_source()
    prepare_dest()
    write_cfg()
    p = spawn()
    result = {"source_rows": src_n, "table": f"{SRC_SCHEMA}.{SRC_TABLE}",
              "md_db": MD_DB, "binary": binary}
    try:
        deadline = time.time() + 300
        landed = 0
        while time.time() < deadline:
            landed = dest_count()
            if landed >= src_n and src_n > 0:
                break
            time.sleep(2)
        result["dest_rows"] = landed
        result["backfill_ok"] = bool(src_n > 0 and landed == src_n)
        if result["backfill_ok"]:
            sample = md().execute(
                f'select * from "{MD_DB}"."{SRC_SCHEMA}"."{SRC_TABLE}" order by 1 limit 3'
            ).fetchall()
            result["sample"] = [list(map(str, r)) for r in sample]
    finally:
        if p.poll() is None:
            p.terminate()
            try:
                p.wait(timeout=25)
            except Exception:
                p.kill()
    result["pass"] = result.get("backfill_ok", False)
    print("[RESULT] " + json.dumps(result), flush=True)
    print(f"\nOVERALL: {'PASS' if result['pass'] else 'FAIL'}", flush=True)


if __name__ == "__main__":
    main()
