# 8. End to end agent example on MotherDuck

Use the remote MCP server from [section 7](../07-remote-mcp/README.md) to have your agent build
a small pipeline on MotherDuck:

1. **Load:** attach the public Iceberg table `nvidia.personas_brazil` (1,000,000 synthetic
   Brazilian personas, the main dataset from [section 3](../03-iceberg/README.md)) as a
   MotherDuck database, and copy it into a DuckLake database. A Flight can rerun the load.
2. **Transform:** SQL builds a summary table from the loaded data.
3. **Visualize:** a Dive charts the summary.

> TODO: This section is an outline. The load and transform SQL below was tested from the
> DuckDB CLI 1.5.6 connected to MotherDuck on 2026-11-02. The agent prompts, the Flight code
> and the Dive haven't been written or tested. Don't present the Flight and Dive steps as a
> tested recipe.

## The building blocks

- **DuckLake on MotherDuck.** The
  [DuckLake docs](https://motherduck.com/docs/integrations/file-formats/ducklake/) create a
  fully managed DuckLake database with:

  ```sql
  CREATE DATABASE my_ducklake (TYPE DUCKLAKE);
  ```

  You can also bring your own bucket (S3, R2, GCS, Azure and others).
- **Flights** are single-file Python programs that run on MotherDuck, on demand or on a cron
  schedule (UTC). The Flight's access token is injected as `MOTHERDUCK_TOKEN`. Agents create
  and run them with the MCP tools (`create_flight`, `run_flight`, and tools for runs, logs and
  versions). See [Running Python with Flights](https://motherduck.com/docs/key-tasks/flights/).
- **Dives** are interactive visualizations saved in MotherDuck. Ask the agent for a Dive by
  name (for example "Create a Dive showing ..."), which tells it to save the result. The docs
  say Dives are available on all MotherDuck plans. See
  [Creating Visualizations with Dives](https://motherduck.com/docs/key-tasks/dives/).
- **Iceberg on MotherDuck.** MotherDuck attaches an Iceberg REST catalog as a database with
  [`CREATE DATABASE ... (TYPE ICEBERG)`](https://motherduck.com/docs/integrations/file-formats/apache-iceberg/),
  and queries on it run server-side (`EXPLAIN` shows `ICEBERG_SCAN (R)`). It is the same
  Hugging Face catalog and the same table that open source DuckDB attaches in section 3. A
  plain `ATTACH ... (TYPE iceberg)` in an `md:` session crashes the client, so don't use it
  there (see the "Works on" notes in section 3).

## Outline

1. Attach the Hugging Face catalog and create a DuckLake database. Run this once per
   organization (from the agent through the remote MCP's read-write SQL tool, or from
   `uvx --from duckdb-cli==1.5.6 duckdb "md:"`):

   ```sql
   -- On MotherDuck (md:)
   CREATE SECRET hf_faceberg IN MOTHERDUCK (TYPE ICEBERG, TOKEN 'anonymous');
   CREATE DATABASE hf_faceberg (
       TYPE ICEBERG,
       "secret" hf_faceberg,
       endpoint 'https://kszucs-catalog.hf.space',
       default_schema 'nvidia',
       read_only true
   );
   CREATE DATABASE personas_lake (TYPE DUCKLAKE);
   ```

   The public catalog needs no credentials, but `CREATE DATABASE` requires a secret, so the
   token is a placeholder. If you kept `hf_faceberg` from section 3, run only the last line.
2. Load the personas into the DuckLake database:

   ```sql
   -- On MotherDuck (md:)
   CREATE OR REPLACE TABLE personas_lake.personas AS
   SELECT uuid, sex, age, marital_status, education_level, occupation, municipality, state,
          persona
   FROM hf_faceberg.nvidia.personas_brazil;
   SELECT count(*) AS personas FROM personas_lake.personas;
   ```

   Expected: 1,000,000 personas, in a few seconds. `EXPLAIN` shows `ICEBERG_SCAN (R)` and
   `COPY_TO_FILE (R)`: MotherDuck reads the Parquet files on Hugging Face and writes the
   DuckLake files, and nothing passes through your laptop.

   To keep it current, ask the agent to wrap this statement in a Flight and run it once on
   demand, then check the logs.
3. Ask the agent to build a summary table in the DuckLake database, for example which states
   have the largest share of university graduates:

   ```sql
   -- On MotherDuck (md:)
   CREATE OR REPLACE TABLE personas_lake.personas_by_state AS
   SELECT state, count(*) AS personas, round(avg(age), 1) AS avg_age,
          round(100 * avg((education_level = 'Superior completo')::INT), 1) AS pct_degree
   FROM personas_lake.personas
   GROUP BY ALL;
   FROM personas_lake.personas_by_state ORDER BY pct_degree DESC LIMIT 5;
   ```

   Expected: Distrito Federal 32.7% (13,968 personas), São Paulo 21.6%, Santa Catarina 19.7%,
   Paraná 19.1%, Amapá 18.4%.
4. Ask the agent to create a Dive over `personas_lake.personas_by_state`, for example
   "Create a Dive showing personas and the share with a university degree by Brazilian
   state".
5. Optional: give the Flight a cron schedule so the Dive stays current.

To remove everything this section created:

```sql
-- On MotherDuck (md:)
DROP DATABASE personas_lake;
DROP DATABASE hf_faceberg;
DROP SECRET hf_faceberg;
```

> TODO: Confirm that a Flight can read the `hf_faceberg` catalog database, and that the
> remote MCP's `query_rw` tool can run the load. Both were only tested from the DuckDB CLI.

> TODO: DuckDB documents `iceberg_to_ducklake()` (a metadata-only copy from an Iceberg
> catalog into DuckLake) in its
> [2.0 Iceberg docs](https://duckdb.org/docs/2.0/core_extensions/iceberg/overview#catalog-managed-tables).
> MotherDuck's docs don't confirm it runs on MotherDuck, so this outline copies the data with
> `CREATE TABLE ... AS SELECT` from the attached catalog.

> TODO: Confirm which MotherDuck plans include Flights. The Flights docs don't say, and
> claimed /try organizations are on the Lite plan.

> TODO: MotherDuck's docs list only S3, S3-compatible storage and GCS as storage for Iceberg
> REST catalogs. These Parquet files are on Hugging Face, so this works but is unsupported.

## References

- [DuckLake on MotherDuck](https://motherduck.com/docs/integrations/file-formats/ducklake/)
- [Running Python with Flights](https://motherduck.com/docs/key-tasks/flights/)
- [Flights announcement](https://motherduck.com/blog/flights-agent-native-ingest/)
- [Creating Visualizations with Dives](https://motherduck.com/docs/key-tasks/dives/)
- [MCP Server reference](https://motherduck.com/docs/sql-reference/mcp/)

Next: [9. Best practices for local development with agents](../09-local-dev-best-practices/README.md).
