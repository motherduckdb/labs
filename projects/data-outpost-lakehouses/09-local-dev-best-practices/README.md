# 9. Best practices for local development with agents

Agents explore by running many small queries: list the tables, describe a table, sample some
rows, try a join, fix it, try again. When every one of those goes to object storage or the
cloud, the agent waits on the network and you pay for it. Keeping data and metadata local
makes that loop fast.

The four patterns below go from simplest to most complete. Run every command from the
workshop folder (`labs/projects/data-outpost-lakehouses`). Everything they create under
`data/` is already ignored by git. The commands use only `uvx`/`uv` and the DuckDB CLI, so
they run on macOS, Linux and Windows (PowerShell). Where a step downloads a file, the guide
shows both a `curl` command and a Python one-liner run with `uv run --python 3.13 python -c
"..."`. The `uv` form works on every OS, including Windows.

> TODO: These patterns were drafted from the outline and the DuckDB/DuckLake docs. Check
> them against what the presenters plan to show.

## 1. Local caching (create local tables)

Copy the remote data you need into local DuckDB tables once, then let the agent query the
copy. You did this in section 1: [`mcp/build_workshop_db.sql`](../mcp/build_workshop_db.sql)
attaches the public Hugging Face Iceberg catalog from [section 3](../03-iceberg/README.md)
and copies 9 columns of `nvidia.personas_brazil` (all 1,000,000 rows) into
`data/workshop.duckdb`. This is the core of it:

```sql
ATTACH IF NOT EXISTS 'https://kszucs-catalog.hf.space' AS hf (
    TYPE iceberg,
    ENDPOINT 'https://kszucs-catalog.hf.space',
    AUTHORIZATION_TYPE 'none'
);
SET VARIABLE snapshot = (SELECT max_by(snapshot_id, sequence_number)
                         FROM iceberg_snapshots(hf.nvidia.personas_brazil));
BEGIN;
CREATE OR REPLACE TABLE personas AS
SELECT uuid, sex, age, marital_status, education_level, occupation, municipality, state,
       persona
FROM hf.nvidia.personas_brazil AT (VERSION => getvariable('snapshot'));
CREATE OR REPLACE TABLE copy_info AS
SELECT 'personas' AS table_name,
       'hf.nvidia.personas_brazil (Iceberg, https://kszucs-catalog.hf.space)' AS source,
       getvariable('snapshot') AS snapshot_id,
       now() AS copied_at;
COMMIT;
```

Three details make the copy safe to rely on:

- **One transaction.** The tables are replaced together at `COMMIT`. If the download fails
  halfway, DuckDB rolls back and the file keeps its previous tables, so the agent never sees a
  half-built cache. The CLI stops at the first error when it runs a script with `-f`.
- **One snapshot.** `AT (VERSION => ...)` reads the table as of one Iceberg snapshot, even if
  someone commits to it during the copy. This table has a single snapshot, `1`.
- **A record of what was copied.** `copy_info` stores the source, the snapshot and the time,
  and the script adds a `COMMENT ON TABLE` to each table, so the agent can tell where a table
  came from and how old it is.

The same question then costs no network round trip. The five largest states take a few
seconds and about 70 Hugging Face requests against the remote table, and milliseconds against
the copy:

```sql
SELECT state, count(*) AS personas, round(avg(age), 1) AS avg_age
FROM personas
GROUP BY ALL ORDER BY personas DESC LIMIT 5;
```

Expected: São Paulo 224,991 (45.0), Minas Gerais 103,935 (45.3), Rio de Janeiro 81,718
(45.9), Bahia 68,851 (44.2), Paraná 57,084 (44.8), the same as the remote query in section 3.

**Refresh.** To check whether the copy is stale, compare the recorded snapshot with the
source's current one (this needs the `hf` catalog attached, as above):

```sql
SELECT snapshot_id AS copied_snapshot, copied_at::DATE AS copied_on,
       (SELECT max_by(snapshot_id, sequence_number)
        FROM iceberg_snapshots(hf.nvidia.personas_brazil)) AS source_snapshot
FROM copy_info WHERE table_name = 'personas';
```

Expected: `copied_snapshot` and `source_snapshot` are both `1`, so the copy is current. When
they differ, re-run the build script (step 4 of section 1). It reads the whole table again
and swaps the tables in one transaction. Stop the MCP server first, because it holds the file
open.

- Good for: data that changes rarely and fits on your laptop, from any source DuckDB can read.
- Cost: every refresh re-reads everything. To apply only what changed, see pattern 4.
- Tip: copy only the columns the agent needs. The build script leaves the long persona texts
  in the remote table, which keeps the file at about 125 MB and the build at about 200
  requests.

### Try it with your agent

Paste this into your coding agent (it needs a shell, uv and the DuckDB CLI 1.5.6), run
from the workshop folder:

```text
Make a local cache of a remote table for fast agent queries. The source is the public
Iceberg table nvidia.personas_brazil in the Iceberg REST catalog
https://kszucs-catalog.hf.space (no authentication). Copy all rows of only the columns uuid,
sex, age, state and occupation into a table named personas in data/agent_cache.duckdb. Read
the source at one snapshot (its current one), and do the whole copy in one transaction so a
failed copy leaves nothing half-built. In the same transaction, record the source, the
snapshot id and the copy time in a small table named copy_info. Then run the same query
(personas per state, top 5) on the remote table and on the local copy, and report both
timings.
```

Expected: `personas` with 1,000,000 rows, `copy_info` with snapshot `1`, and the top-5 query
in a few seconds remotely versus a few milliseconds locally.

## 2. Local catalog for fast quick lookups

Keep only the catalog local and leave the data in object storage. The agent's metadata
questions (which tables exist, their columns, how many files and rows, which snapshots) are
answered from a local file, and only real data scans go to the network.

A frozen DuckLake is this pattern. Download the catalog of the space-missions DuckLake from
[section 4](../04-ducklake/README.md) (about 5 MB) and attach the local copy. Its data files
stay on GitHub, because the catalog stores their absolute URLs.

macOS / Linux (curl):

```bash
curl -L -o data/space.ducklake https://raw.githubusercontent.com/marhar/frozen/main/space.ducklake
```

Any OS, including Windows (uv), runs a short Python snippet that works the same in
PowerShell, cmd and bash:

```bash
uv run --python 3.13 python -c "import os, urllib.request; os.makedirs('data', exist_ok=True); urllib.request.urlretrieve('https://raw.githubusercontent.com/marhar/frozen/main/space.ducklake', 'data/space.ducklake')"
```

```sql
ATTACH 'ducklake:data/space.ducklake' AS space (READ_ONLY);
FROM space.snapshots();
SELECT table_name, count(*) AS files, sum(record_count) AS rows
FROM __ducklake_metadata_space.ducklake_data_file JOIN __ducklake_metadata_space.ducklake_table USING (table_id)
GROUP BY ALL ORDER BY ALL;
```

Both queries come straight from the local file: 14 snapshots, and `astronauts` 2 files / 85
rows, `mission_crew` 4 / 156, `missions` 2 / 68, `spacecraft` 1 / 32. Only a query that reads
table data goes to the network.

### Try it with your agent

Paste this into your coding agent (it needs a shell, uv and the DuckDB CLI 1.5.6), run
from the workshop folder:

```text
Set up a local catalog with remote data. Download the catalog file of the public frozen
DuckLake https://raw.githubusercontent.com/marhar/frozen/main/space.ducklake to
data/space.ducklake, and attach the local file read-only as a DuckLake; its data files stay
on GitHub. From the local file only, list the snapshots and, for each table, its number of
data files and rows, using the catalog metadata rather than scanning the data. Prove those
answers are local by running them again with DuckDB's HTTP file access turned off. Then,
with HTTP back on, run one query that reads table data: astronauts per nationality.
```

Expected: the 14 snapshots and the file and row counts above, the same with HTTP off, then
USA 43, China 11, Russia 9 at the top of the nationality query.

### With a DuckLake on MotherDuck: bring your own bucket

> **Optional.** This part needs your own AWS account and an S3 bucket you can write to. If you
> don't have one, skip it: the rest of the workshop doesn't depend on it.

A fully managed DuckLake on MotherDuck keeps its Parquet files in MotherDuck's storage, and
MotherDuck doesn't hand out credentials for it. A laptop can copy that catalog, but any query
that reads table data fails with an S3 *"No credentials are provided"* error. Only metadata
questions work.

A [bring-your-own-bucket](https://motherduck.com/docs/integrations/file-formats/ducklake/)
DuckLake fixes this. MotherDuck still hosts the catalog, but the data files go to an S3 bucket
you control. Your laptop can then read them directly with your own cloud credentials.

Use DuckDB's AWS **credential chain** for both sides, so no keys are pasted anywhere. It picks
up whatever your AWS CLI is already logged in with: environment variables, a profile, or an
SSO session. For an SSO profile, run `aws sso login --profile <profile>` first and add
`CHAIN 'sso', PROFILE '<profile>'` to each secret below.

1. In a MotherDuck session (`duckdb "md:"`), store an S3 secret in MotherDuck and create the
   DuckLake in your bucket. MotherDuck uses this secret to write and read the data files.

   ```sql
   INSTALL aws; LOAD aws;
   CREATE SECRET my_bucket IN MOTHERDUCK (
       TYPE S3, PROVIDER credential_chain, REGION '<region>', SCOPE 's3://<bucket>'
   );
   CREATE DATABASE my_lake (TYPE DUCKLAKE, DATA_PATH 's3://<bucket>/<prefix>/');
   ```

   The credential chain is resolved on your machine when the secret is created, and MotherDuck
   stores the resulting credentials. Temporary credentials, such as an SSO session's, expire,
   so re-create the secret when they do.
2. Copy the catalog to a local file. This needs the MotherDuck token, and takes about 2 s for a
   1M-row table (a 4.5 MB file):

   ```sql
   ATTACH 'ducklake:md:__ducklake_metadata_my_lake' AS remote (READ_ONLY);
   ATTACH 'data/my_lake_catalog.duckdb' AS cat;
   COPY FROM DATABASE __ducklake_metadata_remote TO cat;
   ```

3. Query from the laptop with a local S3 secret from the same credential chain. This session
   doesn't need MotherDuck at all:

   ```sql
   INSTALL aws; LOAD aws;
   CREATE SECRET (TYPE S3, PROVIDER credential_chain, REGION '<region>');
   ATTACH 'ducklake:data/my_lake_catalog.duckdb' AS lake (READ_ONLY);
   FROM lake.snapshots();                                  -- from the local file
   SELECT state, count(*) FROM lake.personas GROUP BY ALL; -- reads Parquet straight from S3
   ```

Measured with a 1M-row table (one 37 MB Parquet file), DuckDB 1.5.6, MotherDuck and the bucket
both in `us-east-1`:

| Query | Time |
|---|---|
| `count(*)`, snapshots, `DESCRIBE` (local catalog) | about 20 ms or less |
| Group-by over all rows, laptop reading S3, first run | 0.9 s |
| The same query again (DuckDB caches the remote file) | a few ms |
| The same query on MotherDuck, next to the data | 0.14 s |

- **Freshness:** the copied catalog is a snapshot. Rows added on MotherDuck later appear only
  after you re-copy it. To always see the latest data, attach the live catalog with
  `ATTACH 'ducklake:md:__ducklake_metadata_my_lake' AS live (READ_ONLY)` instead of copying
  it. Each query then costs a round trip to MotherDuck for metadata (about 1.5 s for the
  group-by above), with the data still read from S3 on the laptop.
- **Access control stays with the bucket:** someone with a catalog copy but no S3 credentials
  sees the metadata and nothing else.
- **Good for:** agents that ask many schema and metadata questions, and want to run real
  queries on the laptop without copying the data.

## 3. Local catalog and files

Keep both the catalog and the Parquet files local: a DuckLake whose catalog is a file on your
laptop and whose `DATA_PATH` is a local folder. The agent's queries never leave the machine,
you can write to it, and you still get snapshots and time travel.

**Mirror the lake, don't glob its folder.** A lake's folder holds more than the current table:
rows removed by a `DELETE` or `UPDATE` stay in their old data files (the catalog masks them
with delete files), and compaction leaves superseded files behind until someone cleans them
up. Only the catalog knows which files and rows are current. In our tests, a glob over one
table's folder returned 84,000 rows for a table of 26,400 (after deletes, updates and a
compaction), and 2,096,197 rows for the 1,043,368-row bring-your-own-bucket table from
pattern 2.

[`mirror_ducklake.py`](mirror_ducklake.py) copies the catalog and downloads only the files the
current snapshot uses, byte for byte:

1. Copies the source catalog to a local file with `COPY FROM DATABASE`, as in pattern 2, and
   stops unless its schema version is `1.0`, because the next steps edit DuckLake's internal
   catalog tables.
2. Lists the active data and delete files (`end_snapshot IS NULL`) from the **local copy**, so
   the list matches the copied catalog exactly, and resolves each file's full path.
3. Points the copy at the local folder: it sets the catalog's `data_path` and rewrites the
   paths of the active files. Absolute ones, like the frozen lake's GitHub URLs, go into
   their table's folder.
4. Expires every older snapshot in the mirror, so it references only local files.
5. Downloads the files in parallel (8 threads) and checks each size against the catalog.

Inlined rows, the small inserts and updates that DuckLake keeps inside the catalog, come along
with the catalog copy. The script runs on any OS through uv, which installs its one
dependency (DuckDB 1.5.6) from the header of the script. Mirror the space-missions DuckLake
from pattern 2:

```bash
uv run --python 3.13 09-local-dev-best-practices/mirror_ducklake.py https://raw.githubusercontent.com/marhar/frozen/main/space.ducklake data/space_mirror.ducklake data/space_mirror_files/
```

Expected: `Mirrored snapshot 13 (catalog version 1.0) to data/space_mirror.ducklake: 9 files,
26,504 bytes (26,504 downloaded) in 0.2 s, catalog copy 0.8 s, history expired.` (times vary).
The files land in `data/space_mirror_files/main/<table>/`.

Query it with the network switched off, to prove it is all local:

```bash
uvx --from duckdb-cli==1.5.6 duckdb -c "
SET disabled_filesystems = 'HTTPFileSystem';
ATTACH 'ducklake:data/space_mirror.ducklake' AS mirror (READ_ONLY);
SELECT snapshot_id, changes FROM mirror.snapshots();
SELECT (FROM mirror.astronauts SELECT count(*)) AS astronauts, (FROM mirror.mission_crew SELECT count(*)) AS mission_crew,
       (FROM mirror.missions SELECT count(*)) AS missions, (FROM mirror.spacecraft SELECT count(*)) AS spacecraft;"
```

Expected: a single snapshot, 13, with the same id as in the source, then 85 astronauts, 156
crew rows, 68 missions and 32 spacecraft, the same counts as in pattern 2.

**Refresh:** run the same command again. Data files never change, so files already present
with the right size are skipped and only new ones are downloaded. Add `--prune` to delete the
local files the new snapshot no longer uses. The mirror's catalog is replaced, so anything you
wrote to the mirror (as in pattern 4) is discarded.

**Other sources:** the script downloads `https://` and `http://` files with Python's standard
library, and copies local paths. For `s3://` files it needs boto3: add `--with boto3` to `uv
run`. It then uses the AWS credential chain, or the profile you pass with `--aws-profile`. For
the bring-your-own-bucket lake from pattern 2, with your MotherDuck token set:

```bash
uv run --python 3.13 --with boto3 09-local-dev-best-practices/mirror_ducklake.py md:__ducklake_metadata_my_lake data/my_lake_mirror.ducklake data/my_lake_mirror_files/ --aws-profile <profile>
```

A lake created with a relative `DATA_PATH` stores it as given, and DuckLake resolves it against
the working directory. If you mirror such a lake from elsewhere, pass its data folder with
`--source-data-path`.

Measured with DuckDB 1.5.6 on a laptop:

| Source | Mirror |
|---|---|
| Frozen space missions (341 rows, files on GitHub) | 1.1 s, 9 files, 26 KB |
| Bring-your-own-bucket lake (1.04M rows in S3, `us-east-1`) | 5 to 9 s in all (2 to 4 s catalog, 3 to 4 s files), 42.2 MB |
| The same lake again, nothing new | 2.1 s, nothing downloaded |

The mirror matched the source at the same snapshot, in row count and in a checksum of every
row (`sum(hash(row))`) per table, with every deleted row still deleted, and its files were
byte-identical to the source's. We checked the frozen lake, a local test lake with deletes,
updates, inlined rows and two compactions (read from disk and over HTTP), and the
bring-your-own-bucket lake after a delete, an update, a rewrite and another delete.

**Verdict:** mirror a DuckLake when you want all of it on the laptop, with the source's
snapshot ids, row ids and files, and cheap refreshes of a large lake. To cache a few tables, or
to copy from a fully managed DuckLake on MotherDuck, copy the tables you need with pattern 1
instead. Its risks:

- **Internal tables:** it edits DuckLake's catalog tables directly. A new catalog version can
  change them, which is why the script refuses anything but 1.0. Re-test it before allowing a
  new version.
- **Credentials:** it reads the data files directly, so it works for frozen lakes and
  bring-your-own-bucket lakes, but not for a fully managed DuckLake on MotherDuck, whose files
  you have no credentials for.
- **History that points at the source:** `--keep-history` keeps older snapshots, and their
  files keep their remote paths. Never run `ducklake_expire_snapshots` and
  `ducklake_cleanup_old_files` on such a mirror with write credentials, because the cleanup
  would delete the source's files. The default mirror has no remote paths.
- **Paths:** relative data paths resolve against the working directory, so run the script and
  open the mirror from the same folder, as everywhere in this guide.

A DuckDB-file catalog allows one writing process at a time
([choosing a catalog database](https://ducklake.select/docs/stable/duckdb/usage/choosing_a_catalog_database)).
Close the CLI before the MCP server attaches the catalog read-write, or attach it
`READ_ONLY` from every process.

### Try it with your agent

Paste this into your coding agent (it needs a shell, uv and the DuckDB CLI 1.5.6), run
from the workshop folder:

```text
Mirror a DuckLake to this laptop with the script
09-local-dev-best-practices/mirror_ducklake.py (run it with uv; its header explains the
arguments). The source is
https://raw.githubusercontent.com/marhar/frozen/main/space.ducklake. Put the catalog in
data/space_mirror.ducklake and the files in data/space_mirror_files/. Then prove the mirror
is fully local by querying it with DuckDB's HTTP file access turned off, and show it matches
the source: for every table, compare the row count and a checksum of all rows in the mirror
with the source at the same snapshot.
```

Expected: snapshot 13 and the same row counts and checksums in the mirror and the source.

## 4. Local catalog and files and syncing with the data change feed

Keep a local copy, and update it with only what changed upstream instead of rebuilding it.
DuckLake's [data change feed](https://ducklake.select/docs/stable/duckdb/advanced_features/data_change_feed)
returns the rows inserted, deleted and updated between two snapshots:

```sql
FROM lake.table_changes('astronauts', 14, 14);
```

Each row has the table's columns plus `snapshot_id`, `rowid` and `change_type` (`insert`,
`delete`, `update_preimage` or `update_postimage`).

The sketch below keeps a local cache in `data/cache.duckdb`, synced from the mirror of pattern
3. The mirror stands in for the upstream lake: it is a writable DuckLake, so you can change it
and watch the changes reach the cache. The cache stores DuckLake's `rowid` with each row so
deletes and updates can be matched.

Start the CLI on the cache, attach the mirror, and make the first full copy:

```bash
uvx --from duckdb-cli==1.5.6 duckdb data/cache.duckdb
```

```sql
ATTACH 'ducklake:data/space_mirror.ducklake' AS lake;
CREATE TABLE astronauts AS SELECT rowid AS lake_rowid, * FROM lake.astronauts;
CREATE TABLE sync_state AS SELECT max(snapshot_id) AS last_snapshot FROM lake.snapshots();
```

`sync_state` starts at snapshot 13. Now change the lake, as an upstream writer would. Run this
in the same session:

```sql
DELETE FROM lake.astronauts WHERE status = 'Deceased';
UPDATE lake.astronauts SET total_flights = total_flights + 1 WHERE name = 'Buzz Aldrin';
INSERT INTO lake.astronauts (astronaut_id, name, nationality, agency, status)
  VALUES (86, 'Ada Pilot', 'UK', 'ESA', 'Active');
CALL ducklake_rewrite_data_files('lake', 'astronauts', delete_threshold => 0.0);
```

That makes four snapshots: 14 deletes 19 astronauts, 15 updates one, 16 inserts one, and 17
compacts the table (`rewrite_delete`). Apply them to the cache **one snapshot at a time**:

```sql
-- Apply the snapshot after sync_state.last_snapshot, all or nothing.
BEGIN;
SET VARIABLE s = (SELECT last_snapshot + 1 FROM sync_state);
-- Compaction keeps every row and its rowid, so skip it (see below).
SET VARIABLE skip = (SELECT list_has_all(['rewrite_delete', 'merge_adjacent'], map_keys(changes))
                     FROM lake.snapshots() WHERE snapshot_id = getvariable('s'));
DELETE FROM astronauts WHERE NOT getvariable('skip') AND lake_rowid IN (
  SELECT rowid FROM lake.table_changes('astronauts', getvariable('s'), getvariable('s'))
  WHERE change_type IN ('delete', 'update_preimage'));
INSERT INTO astronauts
  SELECT * EXCLUDE (snapshot_id, change_type) RENAME (rowid AS lake_rowid)
  FROM lake.table_changes('astronauts', getvariable('s'), getvariable('s'))
  WHERE NOT getvariable('skip') AND change_type IN ('insert', 'update_postimage');
UPDATE sync_state SET last_snapshot = getvariable('s');
COMMIT;
```

Repeat until `last_snapshot` equals `SELECT max(snapshot_id) FROM lake.snapshots()`, four times
here. Asking for a snapshot past the latest one fails with *No snapshot found at version 18*,
and the transaction leaves `sync_state` unchanged. Then check that the cache matches the lake:

```sql
SELECT (FROM astronauts SELECT count(*)) AS cache_rows,
       (FROM lake.astronauts SELECT count(*)) AS lake_rows,
       (FROM (FROM lake.astronauts EXCEPT ALL SELECT * EXCLUDE (lake_rowid) FROM astronauts) SELECT count(*)) AS missing,
       (FROM (SELECT * EXCLUDE (lake_rowid) FROM astronauts EXCEPT ALL FROM lake.astronauts) SELECT count(*)) AS extra;
```

Expected: 67 rows in both, nothing missing and nothing extra.

- **Why one snapshot at a time:** over a wider range, a row inserted in one snapshot and
  deleted in a later one shows up as both an `insert` and a `delete`. Applying all deletes
  first and then all inserts would bring that row back. In our tests, a range that spanned a
  compaction also attributed a later delete to the wrong snapshot. Single snapshots were
  always right.
- **Why skip compaction:** `ducklake_rewrite_data_files` and `ducklake_merge_adjacent_files`
  rewrite files but keep each row and its `rowid`, so the table doesn't change. The feed still
  reports a rewrite as an update of every rewritten row, which costs as much as a full copy. In
  DuckDB 1.5.6, when the table also has inlined rows (here, the update and the insert), it
  reports some rows as deleted that weren't, such as Buzz Aldrin's updated row. Applying that
  snapshot leaves the cache with 66 rows instead of 67. Merging and flushing inlined data
  report no changes.
- **When to fall back to a full copy:** after `ducklake_expire_snapshots` removes a snapshot
  the cache hasn't applied yet, `table_changes` fails with *No snapshot found at version N*.
  Drop the cache and copy it again. Do the same after re-running the mirror of pattern 3,
  which replaces the lake's catalog and discards these changes.
- **With a DuckLake on MotherDuck:** the same SQL works through
  `ATTACH 'ducklake:md:__ducklake_metadata_<database_name>' AS lake`. We tested it on a
  bring-your-own-bucket lake: per snapshot, it returned 3,803 deletes, 3,288 updates, a
  rewrite as 1,042,909 updates, and 2,829 deletes. The feed reads the data files, so for a
  bring-your-own-bucket lake the laptop also needs S3 credentials, as in pattern 2.

### Try it with your agent

Paste this into your coding agent (it needs a shell, uv and the DuckDB CLI 1.5.6), run
from the workshop folder:

```text
Build a local cache that stays in sync with a DuckLake through its change feed
(table_changes). Do these steps in order:
1. Make a writable local lake: mirror
   https://raw.githubusercontent.com/marhar/frozen/main/space.ducklake with
   09-local-dev-best-practices/mirror_ducklake.py into data/space_mirror.ducklake and
   data/space_mirror_files/.
2. Copy its astronauts table into data/cache.duckdb, keeping each row's DuckLake rowid, and
   record the lake's latest snapshot as the last one synced.
3. Change the lake in separate commits: delete some rows, update one, insert one. Then sync.
4. Change it again: update another row, then compact the table (rewrite its data files).
   Then sync again.
To sync, apply each snapshot after the last one synced, one at a time, each in its own
transaction: remove the deleted rows and the old versions of updated rows, add the inserted
rows and the new versions, and move the last-synced snapshot forward. A snapshot that only
compacts files changes no rows, so apply nothing for it, but still move the last-synced
snapshot past it. After each sync, check that the cache and the lake hold exactly the same
rows.
```

Expected: after each sync the cache and the lake hold the same rows, and the last-synced
snapshot ends at the lake's latest one, past the compaction.

## References

- [DuckLake data change feed](https://ducklake.select/docs/stable/duckdb/advanced_features/data_change_feed)
- [Choosing a catalog database](https://ducklake.select/docs/stable/duckdb/usage/choosing_a_catalog_database)
- [Frozen DuckLake](https://ducklake.select/2025/10/24/frozen-ducklake/)
- [DuckLake on MotherDuck](https://motherduck.com/docs/integrations/file-formats/ducklake/)

Next: [10. Bonus round: DuckDB 2.0's Async IO and Lakehouses](../10-bonus-async-io/README.md).
