# /// script
# requires-python = ">=3.10"
# dependencies = ["duckdb==1.5.6"]
# ///
"""Mirror a DuckLake to the laptop: a local copy of the catalog plus a byte-for-byte copy of
only the files the current snapshot uses.

    uv run --python 3.13 09-local-dev-best-practices/mirror_ducklake.py SOURCE CATALOG DATA_PATH

SOURCE    what you would put after `ducklake:` in ATTACH, e.g.
          https://raw.githubusercontent.com/marhar/frozen/main/space.ducklake,
          md:__ducklake_metadata_my_lake, or data/some_lake.ducklake
CATALOG   the local catalog file to create (replaced if it exists)
DATA_PATH the local folder for the data files. Stored in the catalog as given, so a relative
          path resolves against the working directory, like DuckLake's DATA_PATH.

Steps:
1. Copy the source catalog to CATALOG (COPY FROM DATABASE, one consistent read).
2. Check the catalog schema version. This script edits DuckLake's internal catalog tables,
   so it only accepts the version it was tested with.
3. From the LOCAL copy, list the active data and delete files (end_snapshot IS NULL), so the
   list matches the copied catalog exactly. Resolve each full remote path from data_path,
   the schema path, the table path and the file path.
4. Point the catalog at DATA_PATH and rewrite the paths of the active files.
5. History: by default, expire every older snapshot in the mirror, so it references only local
   files. With --keep-history, older files keep pointing at their remote location instead, so
   time travel still works when the remote files are reachable.
6. Download the files in parallel and check each size against file_size_bytes.

Downloads: http(s):// with urllib (stdlib), s3:// with boto3 (add `--with boto3` to uv run;
it uses the AWS credential chain, or --aws-profile), and local paths with a file copy. Files
already present with the right size are skipped, so re-running only fetches new files, and
--prune deletes the local files the new snapshot no longer uses.
"""

import argparse
import concurrent.futures
import os
import shutil
import sys
import time
import urllib.parse
import urllib.request

import duckdb

SUPPORTED_CATALOG_VERSIONS = {"1.0"}


def is_url(p):
    return "://" in p


def is_absolute(p):
    return is_url(p) or os.path.isabs(p)


def with_slash(p):
    return p if p.endswith("/") else p + "/"


def sql_str(s):
    return "'" + s.replace("'", "''") + "'"


def download(remote, local, size, s3_client_factory):
    if os.path.exists(local) and os.path.getsize(local) == size:
        return 0
    os.makedirs(os.path.dirname(local), exist_ok=True)
    tmp = local + ".part"
    if remote.startswith(("http://", "https://")):
        with urllib.request.urlopen(remote) as r, open(tmp, "wb") as f:
            shutil.copyfileobj(r, f, 1 << 20)
    elif remote.startswith(("s3://", "s3a://")):
        u = urllib.parse.urlparse(remote)
        s3_client_factory().download_file(u.netloc, u.path.lstrip("/"), tmp)
    elif remote.startswith("file://"):
        shutil.copyfile(urllib.request.url2pathname(urllib.parse.urlparse(remote).path), tmp)
    elif not is_url(remote):
        shutil.copyfile(remote, tmp)
    else:
        raise ValueError(f"unsupported scheme: {remote}")
    got = os.path.getsize(tmp)
    if got != size:
        os.remove(tmp)
        raise ValueError(f"{remote}: got {got} bytes, catalog says {size}")
    os.replace(tmp, local)
    return got


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("source")
    ap.add_argument("catalog")
    ap.add_argument("data_path")
    ap.add_argument("--source-data-path",
                    help="the source's data path, if the catalog stores a relative one that "
                         "can't be resolved from here (like DuckLake's OVERRIDE_DATA_PATH)")
    ap.add_argument("--keep-history", action="store_true",
                    help="keep older snapshots; their files keep pointing at the source")
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--aws-profile", help="AWS profile for s3:// downloads (boto3)")
    ap.add_argument("--prune", action="store_true",
                    help="delete files under DATA_PATH that the mirrored snapshot doesn't use")
    a = ap.parse_args()

    source = a.source[len("ducklake:"):] if a.source.startswith("ducklake:") else a.source
    data_path = with_slash(a.data_path.replace("\\", "/"))
    t0 = time.time()

    # 1. Copy the catalog.
    for p in (a.catalog, a.catalog + ".wal"):
        if os.path.exists(p):
            os.remove(p)
    if os.path.dirname(a.catalog):
        os.makedirs(os.path.dirname(a.catalog), exist_ok=True)
    con = duckdb.connect()
    con.execute(f"ATTACH {sql_str('ducklake:' + source)} AS src (READ_ONLY)")
    con.execute(f"ATTACH {sql_str(a.catalog)} AS cat")
    con.execute("COPY FROM DATABASE __ducklake_metadata_src TO cat")
    con.execute("DETACH src")
    t_catalog = time.time() - t0

    # 2. Check the catalog schema version.
    meta = dict(con.execute(
        "SELECT key, value FROM cat.ducklake_metadata WHERE scope IS NULL").fetchall())
    version = meta.get("version")
    if version not in SUPPORTED_CATALOG_VERSIONS:
        sys.exit(f"DuckLake catalog version {version!r} is not supported (expected "
                 f"{sorted(SUPPORTED_CATALOG_VERSIONS)}). This script edits internal catalog "
                 "tables, so check it against the new version first.")
    snapshot = con.execute("SELECT max(snapshot_id) FROM cat.ducklake_snapshot").fetchone()[0]

    src_data_path = a.source_data_path or meta.get("data_path", "")
    if src_data_path and not is_absolute(src_data_path):
        if is_url(source) or source.startswith("md:"):
            src_data_path = None  # relative to the writer's working directory: unknown here
        else:
            src_data_path = os.path.abspath(src_data_path)
    if src_data_path:
        src_data_path = with_slash(src_data_path.replace("\\", "/"))

    # 3. Active files, from the local copy, with their schema and table paths.
    rows = con.execute("""
        WITH t AS (SELECT * FROM cat.ducklake_table WHERE end_snapshot IS NULL),
             s AS (SELECT * FROM cat.ducklake_schema WHERE end_snapshot IS NULL),
             f AS (SELECT 'data' AS kind, data_file_id AS id, table_id, path, path_is_relative,
                          file_size_bytes
                   FROM cat.ducklake_data_file WHERE end_snapshot IS NULL
                   UNION ALL
                   SELECT 'delete', delete_file_id, table_id, path, path_is_relative,
                          file_size_bytes
                   FROM cat.ducklake_delete_file WHERE end_snapshot IS NULL)
        SELECT f.kind, f.id, f.table_id, f.path, f.path_is_relative, f.file_size_bytes,
               t.path, t.path_is_relative, s.schema_id, s.path, s.path_is_relative
        FROM f JOIN t USING (table_id) JOIN s ON s.schema_id = t.schema_id
        ORDER BY ALL""").fetchall()

    def remote_path(fpath, frel, tpath, trel, spath, srel):
        if not frel:
            return fpath
        base = tpath if not trel else None
        if base is None:
            sbase = spath if not srel else (src_data_path + spath if src_data_path else None)
            if sbase is None:
                sys.exit("The catalog stores a relative data_path that can't be resolved from "
                         "here. Pass --source-data-path with the source's data folder.")
            base = with_slash(sbase) + tpath
        return with_slash(base) + fpath

    # Local layout: keep relative schema/table/file paths as they are, so most rows don't
    # change. Absolute schema and table paths become <name>/, absolute files go into their
    # table's folder under their own file name.
    names = dict(con.execute(
        "SELECT schema_id, schema_name FROM cat.ducklake_schema WHERE end_snapshot IS NULL"
    ).fetchall())
    tnames = dict(con.execute(
        "SELECT table_id, table_name FROM cat.ducklake_table WHERE end_snapshot IS NULL"
    ).fetchall())
    plan, file_updates, schema_updates, table_updates, used = [], [], {}, {}, set()
    for kind, fid, tid, fpath, frel, size, tpath, trel, sid, spath, srel in rows:
        remote = remote_path(fpath, frel, tpath, trel, spath, srel)
        lspath = spath if srel else names[sid] + "/"
        ltpath = tpath if trel else tnames[tid] + "/"
        if not srel:
            schema_updates[sid] = lspath
        if not trel:
            table_updates[tid] = ltpath
        if frel and srel and trel:
            lfpath = fpath
        else:
            lfpath = os.path.basename(urllib.parse.urlparse(remote).path) or f"{kind}-{fid}"
            if (tid, lfpath) in used:
                lfpath = f"{kind}-{fid}-{lfpath}"
            file_updates.append((kind, fid, lfpath))
        used.add((tid, lfpath))
        local = os.path.normpath(os.path.join(data_path + with_slash(lspath) + with_slash(ltpath),
                                              lfpath))
        plan.append((remote, local, size))

    # 4 + 5. Rewrite the catalog in one transaction.
    con.execute("BEGIN")
    if a.keep_history:
        # Older files keep their remote location as an absolute path.
        hist = con.execute("""
            SELECT 'data', d.data_file_id, d.path, d.path_is_relative, t.path,
                   t.path_is_relative, s.path, s.path_is_relative
            FROM cat.ducklake_data_file d
            JOIN (SELECT DISTINCT ON (table_id) * FROM cat.ducklake_table
                  ORDER BY table_id, begin_snapshot DESC) t USING (table_id)
            JOIN (SELECT DISTINCT ON (schema_id) * FROM cat.ducklake_schema
                  ORDER BY schema_id, begin_snapshot DESC) s ON s.schema_id = t.schema_id
            WHERE d.end_snapshot IS NOT NULL
            UNION ALL
            SELECT 'delete', d.delete_file_id, d.path, d.path_is_relative, t.path,
                   t.path_is_relative, s.path, s.path_is_relative
            FROM cat.ducklake_delete_file d
            JOIN (SELECT DISTINCT ON (table_id) * FROM cat.ducklake_table
                  ORDER BY table_id, begin_snapshot DESC) t USING (table_id)
            JOIN (SELECT DISTINCT ON (schema_id) * FROM cat.ducklake_schema
                  ORDER BY schema_id, begin_snapshot DESC) s ON s.schema_id = t.schema_id
            WHERE d.end_snapshot IS NOT NULL""").fetchall()
        for kind, fid, fpath, frel, tpath, trel, spath, srel in hist:
            if frel:
                file_updates.append(
                    (kind, fid, remote_path(fpath, frel, tpath, trel, spath, srel), False))
    for sid, p in schema_updates.items():
        con.execute("UPDATE cat.ducklake_schema SET path = ?, path_is_relative = true "
                    "WHERE schema_id = ?", [p, sid])
    for tid, p in table_updates.items():
        con.execute("UPDATE cat.ducklake_table SET path = ?, path_is_relative = true "
                    "WHERE table_id = ?", [p, tid])
    for u in file_updates:
        kind, fid, p = u[:3]
        rel = u[3] if len(u) > 3 else True
        tbl, col = (("ducklake_data_file", "data_file_id") if kind == "data"
                    else ("ducklake_delete_file", "delete_file_id"))
        con.execute(f"UPDATE cat.{tbl} SET path = ?, path_is_relative = ? WHERE {col} = ?",
                    [p, rel, fid])
    con.execute("UPDATE cat.ducklake_metadata SET value = ? "
                "WHERE key = 'data_path' AND scope IS NULL", [data_path])
    # Files the source scheduled for deletion are not the mirror's to delete.
    con.execute("DELETE FROM cat.ducklake_files_scheduled_for_deletion")
    con.execute("COMMIT")
    con.execute("DETACH cat")

    if not a.keep_history:
        con.execute(f"ATTACH {sql_str('ducklake:' + a.catalog)} AS m")
        con.execute("CALL ducklake_expire_snapshots('m', older_than => now())")
        con.execute("DELETE FROM __ducklake_metadata_m.ducklake_files_scheduled_for_deletion")
        con.execute("DETACH m")
    con.close()

    # 6. Download in parallel.
    s3 = {}

    def s3_client():
        if "c" not in s3:
            try:
                import boto3
            except ImportError:
                sys.exit("s3:// files need boto3: add `--with boto3` to `uv run`.")
            s3["c"] = boto3.Session(profile_name=a.aws_profile).client("s3")
        return s3["c"]

    if any(r.startswith(("s3://", "s3a://")) for r, _, _ in plan):
        s3_client()  # create once, before the threads start
    t1 = time.time()
    with concurrent.futures.ThreadPoolExecutor(a.workers) as pool:
        fetched = sum(pool.map(lambda p: download(p[0], p[1], p[2], s3_client), plan))
    t_files = time.time() - t1
    pruned = 0
    if a.prune:
        keep = {os.path.normcase(os.path.abspath(local)) for _, local, _ in plan}
        for root, _, files in os.walk(data_path):
            for name in files:
                p = os.path.join(root, name)
                if os.path.normcase(os.path.abspath(p)) not in keep:
                    os.remove(p)
                    pruned += 1
    total = sum(size for _, _, size in plan)
    print(f"Mirrored snapshot {snapshot} (catalog version {version}) to {a.catalog}: "
          f"{len(plan)} files, {total:,} bytes ({fetched:,} downloaded) in {t_files:.1f} s, "
          f"catalog copy {t_catalog:.1f} s, "
          f"history {'kept (older files stay remote)' if a.keep_history else 'expired'}"
          + (f", {pruned} unused local files deleted." if a.prune else "."))


if __name__ == "__main__":
    main()
