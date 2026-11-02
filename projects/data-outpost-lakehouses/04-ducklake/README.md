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
Parquet files already sitting in object storage or on a web server. Readers attach the file
and query, and nothing runs except the storage.

We'll query one that already exists: the space-missions example from that post, published on
GitHub. It has 4 small tables: `missions` (68 rows), `astronauts` (85), `mission_crew` (156)
and `spacecraft` (32). The `.ducklake` catalog and its Parquet files are plain files on
`raw.githubusercontent.com`, so there is nothing to build and no credentials are needed.

```sql
INSTALL ducklake; LOAD ducklake; INSTALL httpfs; LOAD httpfs;
ATTACH 'ducklake:https://raw.githubusercontent.com/marhar/frozen/main/space.ducklake' AS space (READ_ONLY);
USE space;
SHOW TABLES;
```

Run the examples in the DuckDB CLI (`uvx --from duckdb-cli==1.5.6 duckdb`) after the `ATTACH`
above:

```sql
-- Missions per agency, and how many succeeded
SELECT agency, count(*) AS missions, count(*) FILTER (WHERE success_status = 'Success') AS successes
FROM missions GROUP BY agency ORDER BY missions DESC LIMIT 5;
```

Expected: NASA 29 (20 successes), CNSA 10 (10), NASA/SpaceX 7 (6), SpaceX 4 (3), NASA/ESA 3 (2).

```sql
-- The most internationally crewed missions (primary crew only)
SELECT m.name AS mission, count(DISTINCT a.nationality) AS nationalities,
       string_agg(DISTINCT a.nationality, ', ' ORDER BY a.nationality) AS countries
FROM missions m
JOIN mission_crew c ON c.mission_id = m.mission_id AND c.primary_crew
JOIN astronauts a ON a.astronaut_id = c.astronaut_id
GROUP BY m.name ORDER BY nationalities DESC, mission LIMIT 5;
```

Expected: International Space Station 7 (Denmark, France, Italy, Japan, Russia, UK, USA),
SpaceX Crew-5 5, SpaceX Crew-6 4, SpaceX Crew-7 4, Expedition 65 3.

```sql
-- Who has spent the most days in space
SELECT name, nationality, total_flights, total_space_days FROM astronauts
ORDER BY total_space_days DESC LIMIT 5;
```

Expected: Gennady Padalka 878, Sergey Krikalev 803, Peggy Whitson 665, Sergey Prokopyev 567,
Oleg Artemyev 561.

The catalog keeps its history. `FROM space.snapshots()` lists 14 snapshots, one per table
created or loaded, so DuckLake time travel (`AT (VERSION => n)`) works here too.

## Query a frozen DuckLake with the open source MCP

The MCP server opens a new connection for every query, so an `ATTACH` doesn't carry over to
the next tool call. Ask for the attach and the query in one call:

> Using the duckdb tools, run this as a single query:
> `ATTACH IF NOT EXISTS 'ducklake:https://raw.githubusercontent.com/marhar/frozen/main/space.ducklake' AS space (READ_ONLY); SELECT agency, count(*) AS missions FROM space.missions GROUP BY agency ORDER BY missions DESC LIMIT 3`

Expected: NASA 29, CNSA 10, NASA/SpaceX 7. A `CREATE` or `INSERT` on `space` fails with
*attached in read-only mode*.

## On MotherDuck

The same `ATTACH` works in a DuckDB session connected to MotherDuck (`duckdb "md:"`), but it
runs on your machine: `EXPLAIN` shows `DUCKLAKE_SCAN (L)`, not `(R)`. MotherDuck's
[DuckLake docs](https://motherduck.com/docs/integrations/file-formats/ducklake/) cover
DuckLakes whose catalog MotherDuck manages. They don't cover attaching an external
`.ducklake` file for server-side execution. To query this data on MotherDuck's servers, copy
it into a MotherDuck database first, for example
`CREATE TABLE my_db.main.missions AS FROM space.missions;`.

## Publishing your own

To freeze your own Parquet files, create a `.ducklake` file, register the existing files with
`ducklake_add_data_files` (no data is copied), and copy the `.ducklake` file to any bucket or
web server. The [frozen DuckLake post](https://ducklake.select/2025/10/24/frozen-ducklake/)
walks through it, including how this example was built.

Next: [5. Use MotherDuck with motherduck.com/try](../05-motherduck-try/README.md).
