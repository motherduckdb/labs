# 4. Introduce DuckLake

[DuckLake](https://ducklake.select/) is an open lakehouse format. The catalog (tables,
schemas, snapshots, file lists, statistics) lives in a SQL database, and the data lives in
Parquet files. The catalog database can be DuckDB, SQLite or PostgreSQL, among
[others](https://ducklake.select/docs/stable/duckdb/usage/choosing_a_catalog_database), and
MotherDuck [hosts managed DuckLakes](https://motherduck.com/docs/integrations/file-formats/ducklake/).
DuckDB reads and writes DuckLake with its `ducklake` extension.

Run every command from the workshop folder (`labs/projects/data-outpost-lakehouses`).

## Frozen DuckLake

A [frozen DuckLake](https://ducklake.select/2025/10/24/frozen-ducklake/) is a read-only
DuckLake with no catalog server. The catalog is a single `.ducklake` file that points at
Parquet files already sitting in object storage. Readers attach the file and query; nothing
runs except the storage. To publish one, copy the `.ducklake` file to any bucket or web
server. Readers can attach it over `https://` or `s3://` too.

We'll build one over the Hacker News Parquet files in MotherDuck's public bucket: 60 daily
files, `stories` (22,160 rows) and `comments` (253,097 rows), Dec 21, 2024 to Jan 19, 2025.
The build script is [`frozen/build_frozen_ducklake.sql`](../frozen/build_frozen_ducklake.sql).

```bash
# Build data/hacker_news.ducklake (~15s). Registers the files with ducklake_add_data_files;
# no data is copied. Rebuild from scratch: delete data/hacker_news.ducklake first.
uvx --from duckdb-cli==1.5.6 duckdb -f frozen/build_frozen_ducklake.sql

# Query it read-only (no credentials needed)
uvx --from duckdb-cli==1.5.6 duckdb -c "ATTACH 'ducklake:data/hacker_news.ducklake' AS hn (READ_ONLY); USE hn;
SELECT s.title, count(c.id) AS comments FROM stories s JOIN comments c ON c.parent = s.id
GROUP BY ALL ORDER BY comments DESC LIMIT 3;"
```

Expected: *Ask HN: Who wants to be hired? (January 2025)* 493, *I am rich and have no idea
what to do* 430, *The Origins of Wokeness* 320.

The build registers December's files and January's files in separate snapshots, so you can
time travel. `FROM hn.snapshots()` lists 7 snapshots, and
`SELECT count(*) FROM hn.stories AT (VERSION => 3)` returns December only: 6,892 stories.

## Query a frozen DuckLake with the open source MCP

The MCP server opens a new connection for every query, so an `ATTACH` doesn't carry over to
the next tool call. Ask for the attach and the query in one call, with the absolute path
(`uv run mcp/print_configs.py` shows your workshop folder):

> Using the duckdb tools, run this as a single query:
> `ATTACH IF NOT EXISTS 'ducklake:<workshop>/data/hacker_news.ducklake' AS hn (READ_ONLY); SELECT count(*) FROM hn.stories`

Expected: 22,160. A `CREATE` or `INSERT` on `hn` fails with *attached in read-only mode*.

## Updating

Register only new files with another `ducklake_add_data_files` call, then republish the
`.ducklake` file. The call doesn't check for duplicates.

Next: [5. Use MotherDuck with motherduck.com/try](../05-motherduck-try/README.md).
