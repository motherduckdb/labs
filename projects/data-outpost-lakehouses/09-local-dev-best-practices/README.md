# 9. Best practices for local development with agents

Agents explore by running many small queries: list the tables, describe a table, sample some
rows, try a join, fix it, try again. When every one of those goes to object storage or the
cloud, the agent waits on the network and you pay for it. Keeping data and metadata local
makes that loop fast.

The four patterns below go from simplest to most complete. Run every command from the
workshop folder (`labs/projects/data-outpost-lakehouses`). Everything they create under
`data/` is already ignored by git.

> TODO: These patterns were drafted from the outline and the DuckDB/DuckLake docs. Check
> them against what the presenters plan to show, especially patterns 3 and 4.

## 1. Local caching (create local tables)

Copy the remote data you need into a local DuckDB table once, then let the agent query the
copy. You did this in section 1: [`mcp/build_workshop_db.sql`](../mcp/build_workshop_db.sql)
attaches the public Hugging Face Iceberg catalog from [section 3](../03-iceberg/README.md)
and copies 9 columns of `nvidia.personas_brazil` (all 1,000,000 rows) into
`data/workshop.duckdb`:

```sql
ATTACH IF NOT EXISTS 'https://kszucs-catalog.hf.space' AS hf (
    TYPE iceberg,
    ENDPOINT 'https://kszucs-catalog.hf.space',
    AUTHORIZATION_TYPE 'none'
);

CREATE OR REPLACE TABLE personas AS
SELECT uuid, sex, age, marital_status, education_level, occupation, municipality, state,
       persona
FROM hf.nvidia.personas_brazil;
```

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

- Good for: data that changes rarely and fits on your laptop.
- Cost: the copy goes stale. Rebuild it, or move to pattern 4.
- Tip: add a `COMMENT ON TABLE` with the source table, as the build script does, so the
  agent can tell where each table came from.
- Tip: copy only the columns the agent needs. The build script leaves the long persona texts
  in the remote table, which keeps the file at about 125 MB and the build at about 200
  requests.

## 2. Local catalog for fast quick lookups

Keep only the catalog local and leave the data in object storage. The agent's metadata
questions (which tables exist, their columns, how many files and rows, which snapshots) are
answered from a local file, and only real data scans go to the network.

The frozen DuckLake from [section 4](../04-ducklake/README.md) is this pattern:
`data/hacker_news.ducklake` is a local catalog over Parquet files in S3. These come straight
from the local file:

```sql
ATTACH 'ducklake:data/hacker_news.ducklake' AS hn (READ_ONLY);
FROM hn.snapshots();
SELECT table_name, count(*) AS files, sum(record_count) AS rows
FROM __ducklake_metadata_hn.ducklake_data_file JOIN __ducklake_metadata_hn.ducklake_table USING (table_id)
GROUP BY ALL ORDER BY ALL;
```

The second query is the last statement of
[`frozen/build_frozen_ducklake.sql`](../frozen/build_frozen_ducklake.sql).

## 3. Local catalog and files

Keep both the catalog and the Parquet files local: a DuckLake whose `DATA_PATH` is a folder on
your laptop. Unlike a frozen DuckLake, you can write to it, and you still get snapshots and
time travel.

```bash
uvx --from duckdb-cli==1.5.6 duckdb -c "
INSTALL ducklake; INSTALL httpfs; LOAD ducklake; LOAD httpfs;
ATTACH 'ducklake:data/local_lake.ducklake' AS lake (DATA_PATH 'data/local_lake_files/');
CREATE TABLE lake.stories AS FROM read_parquet('s3://us-prd-motherduck-open-datasets/hacker_news/parquet/comments_stories/stories/dt=2024-12-*/*.parquet', hive_partitioning = false);
INSERT INTO lake.stories FROM read_parquet('s3://us-prd-motherduck-open-datasets/hacker_news/parquet/comments_stories/stories/dt=2025-01-*/*.parquet', hive_partitioning = false);
SELECT snapshot_id, changes FROM lake.snapshots();
SELECT count(*) FROM lake.stories;"
```

Expected: 3 snapshots (0 creates the schema, 1 creates and fills the table with 6,892 rows,
2 inserts 15,268 rows) and 22,160 stories. The Parquet files land in `data/local_lake_files/`
(about 7 MB).

A DuckDB-file catalog allows one writing process at a time
([choosing a catalog database](https://ducklake.select/docs/stable/duckdb/usage/choosing_a_catalog_database)).
Close the CLI before the MCP server attaches the catalog read-write, or attach it
`READ_ONLY` from every process.

## 4. Local catalog and files and syncing with the data change feed

Keep a local copy, and update it with only what changed upstream instead of rebuilding it.
DuckLake's [data change feed](https://ducklake.select/docs/stable/duckdb/advanced_features/data_change_feed)
returns the rows inserted, deleted and updated between two snapshots:

```sql
FROM lake.table_changes('stories', 2, 2);
```

Each row has the table's columns plus `snapshot_id`, `rowid` and `change_type` (`insert`,
`delete`, `update_preimage` or `update_postimage`).

The sketch below keeps a local cache in `data/cache.duckdb`, synced from the DuckLake in
pattern 3. It stores DuckLake's `rowid` with each row so deletes and updates can be matched.

Start the CLI on the cache, attach the lake, and make the first full copy:

```bash
uvx --from duckdb-cli==1.5.6 duckdb data/cache.duckdb
```

```sql
LOAD ducklake;
ATTACH 'ducklake:data/local_lake.ducklake' AS lake;
CREATE TABLE stories AS SELECT rowid AS lake_rowid, * FROM lake.stories;
CREATE TABLE sync_state AS SELECT max(snapshot_id) AS last_snapshot FROM lake.snapshots();
```

Then, after the lake changes, apply the changes **one snapshot at a time**:

```sql
-- Apply the snapshot after sync_state.last_snapshot.
SET VARIABLE s = (SELECT last_snapshot + 1 FROM sync_state);
DELETE FROM stories WHERE lake_rowid IN (
  SELECT rowid FROM lake.table_changes('stories', getvariable('s'), getvariable('s'))
  WHERE change_type IN ('delete', 'update_preimage'));
INSERT INTO stories
  SELECT * EXCLUDE (snapshot_id, change_type) RENAME (rowid AS lake_rowid)
  FROM lake.table_changes('stories', getvariable('s'), getvariable('s'))
  WHERE change_type IN ('insert', 'update_postimage');
UPDATE sync_state SET last_snapshot = getvariable('s');
```

Repeat until `last_snapshot` equals `SELECT max(snapshot_id) FROM lake.snapshots()`. Asking
for a snapshot past the latest one fails with *No snapshot found at version N*.

Why one snapshot at a time: over a wider range, a row inserted in one snapshot and deleted in
a later one shows up as both an `insert` and a `delete`. Applying all deletes first and then
all inserts would bring that row back.

Tested on 2026-11-02 with DuckDB 1.5.6 against the local DuckLake from pattern 3. After the
first copy, the lake took a `DELETE FROM lake.stories WHERE score < 2` and an `UPDATE` of 10
rows (snapshots 3 and 4). After two sync steps, the cache matched the lake row for row (16,371
rows). A second run that synced an insert, a delete and an update also matched.

> TODO: Not tested against a DuckLake on MotherDuck. The MotherDuck docs attach one from
> local DuckDB with `ATTACH 'ducklake:md:__ducklake_metadata_<database_name>' AS <alias>;`
> ([DuckLake on MotherDuck](https://motherduck.com/docs/integrations/file-formats/ducklake/)).
> Verify that `table_changes` works through that attach before teaching this as the
> MotherDuck-to-laptop sync.

> TODO: Expired snapshots or compaction can remove history the feed needs. Add guidance for
> when to fall back to a full copy.

## References

- [DuckLake data change feed](https://ducklake.select/docs/stable/duckdb/advanced_features/data_change_feed)
- [Choosing a catalog database](https://ducklake.select/docs/stable/duckdb/usage/choosing_a_catalog_database)
- [Frozen DuckLake](https://ducklake.select/2025/10/24/frozen-ducklake/)
- [DuckLake on MotherDuck](https://motherduck.com/docs/integrations/file-formats/ducklake/)

Next: [10. Bonus round: DuckDB 2.0's Async IO and Lakehouses](../10-bonus-async-io/README.md).
