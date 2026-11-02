# 3. Introduce Iceberg

[Apache Iceberg](https://iceberg.apache.org/) is an open table format. A table is a set of
Parquet data files in object storage plus a metadata tree (metadata file → manifest lists →
manifests → data files) that records snapshots, schema and partitions. DuckDB reads Iceberg
tables with its [`iceberg` extension](https://duckdb.org/docs/stable/core_extensions/iceberg/overview).

Run every command from the workshop folder (`labs/projects/data-outpost-lakehouses`).

## Why Iceberg

From the workshop slides:

- **Interoperable:** an open table spec. Spark, Trino, Flink, Snowflake, BigQuery, DuckDB and
  more read and write the same tables.
- **Low cost:** the data is Parquet files in object storage (S3, GCS, ADLS). You pay storage
  prices, and compute is separate.
- **Scalable to petabytes:** the metadata tree lets engines prune files without listing
  directories. It was built at Netflix for petabyte tables.
- **Concurrency management:** optimistic concurrency, with an atomic swap of the metadata
  pointer in the catalog. Readers get snapshot isolation.
- **Schema evolution and time travel:** add, drop, rename or reorder columns without
  rewriting data (columns are tracked by id). Query any earlier snapshot.
- **Mature:** an Apache top-level project since 2020, with wide vendor support and a v3 spec.

## Query public Iceberg tables on Hugging Face

[Faceberg](https://github.com/huggingface/faceberg) serves Hugging Face datasets as Iceberg
tables. Its Iceberg metadata points at the dataset's existing Parquet files on the Hub, so
nothing is copied, and a Hugging Face Space hosts an Iceberg REST catalog in front of it.
DuckDB attaches that catalog like a database. These public catalogs need no token or secret.

Start with the `kszucs-catalog` Space. It has 11 tables, one schema per Hugging Face org:

```sql
INSTALL iceberg; LOAD iceberg; INSTALL httpfs; LOAD httpfs;
ATTACH 'https://kszucs-catalog.hf.space' AS hf (
    TYPE iceberg,
    ENDPOINT 'https://kszucs-catalog.hf.space',
    AUTHORIZATION_TYPE 'none'
);
SELECT schema, name FROM (SHOW ALL TABLES) ORDER BY ALL;
```

Run the snippets in one `uvx --from duckdb-cli==1.5.6 duckdb` session, or run
[`public_iceberg_datasets.sql`](../public_iceberg_datasets.sql), which has the main queries
below:

```bash
uvx --from duckdb-cli==1.5.6 duckdb -f public_iceberg_datasets.sql
```

### Main dataset: nvidia.personas_brazil

`nvidia.personas_brazil` is the Hugging Face dataset
[`nvidia/Nemotron-Personas-Brazil`](https://huggingface.co/datasets/nvidia/Nemotron-Personas-Brazil):
1,000,000 synthetic Brazilian personas. Each row has demographic columns (`sex`, `age`,
`marital_status`, `education_level`, `occupation`, `municipality`, `state`) and several
persona texts (`persona`, `professional_persona`, `travel_persona` and more), 22 columns in
all. The values are in Portuguese. MotherDuck reads this same table in
[section 8](../08-end-to-end/README.md), and `data/workshop.duckdb` is a local copy of it.

Look at the columns first. The catalog loads each table's schema lazily, so `DESCRIBE` is
also how you see the real types:

```sql
DESCRIBE hf.nvidia.personas_brazil;
```

Expected: 22 columns, all `VARCHAR` except `age` (`BIGINT`).

Where do the personas live? The five largest states, with their average age:

```sql
SELECT state, count(*) AS personas, round(avg(age), 1) AS avg_age
FROM hf.nvidia.personas_brazil
GROUP BY ALL ORDER BY personas DESC LIMIT 5;
```

Expected: São Paulo 224,991 (average age 45.0), Minas Gerais 103,935 (45.3), Rio de Janeiro
81,718 (45.9), Bahia 68,851 (44.2), Paraná 57,084 (44.8). It reads 2 of the 22 columns and
takes a few seconds.

How does education vary with age?

```sql
SELECT education_level, count(*) AS personas, round(avg(age), 1) AS avg_age
FROM hf.nvidia.personas_brazil
GROUP BY ALL ORDER BY avg_age;
```

Expected: 4 levels. `Médio completo e superior incompleto` (finished high school) is the
youngest group (358,304 personas, average age 37.9), and `Sem instrução e fundamental
incompleto` (no schooling or incomplete primary) is the oldest (319,850, 54.0).
`Superior completo` (a university degree) has 167,150 personas, average age 43.0.

A question an agent might get, "find me three personas for user interviews: women aged 25
to 34 with a university degree in Santa Catarina":

```sql
SELECT municipality, age, persona
FROM hf.nvidia.personas_brazil
WHERE state = 'Santa Catarina' AND sex = 'Feminino' AND age BETWEEN 25 AND 34
  AND education_level = 'Superior completo'
LIMIT 3;
```

Expected: 3 rows with a one-sentence persona each. In testing they came from Palhoça,
Jaraguá do Sul and Balneário Camboriú, but without `ORDER BY` which 3 you get can vary.
`LIMIT` stops the scan early. Adding `ORDER BY` makes DuckDB read every matching row first,
which took 4 times as long and 5 times as many requests.

Under the hood it is a normal Iceberg table. Its snapshot points at the dataset's original
Parquet files, pinned to a commit:

```sql
SELECT file_path, record_count
FROM iceberg_metadata(hf.nvidia.personas_brazil);
```

Expected: 11 files, `hf://datasets/nvidia/Nemotron-Personas-Brazil@441be2b.../data/train-00000-of-00011.parquet`
to `train-00010-of-00011.parquet`, with 90,909 or 90,910 records each.

Learn more: the [Faceberg repo](https://github.com/huggingface/faceberg) (how to publish your
own catalog), the [`kszucs/catalog` Space](https://huggingface.co/spaces/kszucs/catalog) that
hosts this catalog, and DuckDB's
[Iceberg REST catalog docs](https://duckdb.org/docs/stable/core_extensions/iceberg/iceberg_rest_catalogs).

### All the datasets, ranked

Ranked by how useful they are in a lakehouse and agents workshop. Row counts are from
`count(*)` on 2026-11-02.

| Rank | Catalog Space, table | Rows | What it is | Why it's interesting |
|---|---|---:|---|---|
| 1 | `kszucs-catalog`, `nvidia.personas_brazil` | 1,000,000 | Synthetic personas with demographic columns | The main dataset: the most tabular table, 1M rows, good `GROUP BY` targets, column pruning over 22 columns; the same table works locally and on MotherDuck |
| 2 | `kszucs-catalog`, `princeton-nlp.SWE-bench_Verified` | 500 | Real GitHub issues with fixes and tests | The benchmark coding agents are graded on; one small file, instant queries |
| 3 | `lhoestq-hermes-catalog`, `NousResearch.hermes-function-calling-v1` | 1,893 | Function-calling conversations with JSON tool schemas | Shows what agent tool calls look like; nested `STRUCT[]` columns to unnest |
| 4 | `kszucs-catalog`, `openai.gdpval` | 220 | OpenAI's real-world knowledge-work tasks, 9 sectors, 44 occupations | Agent tasks with grading rubrics and links to input files |
| 5 | `kszucs-catalog`, `HuggingFaceFW.fineweb-edu` | 1,525,223,056 | Educational web pages from Common Crawl | `count(*)` of 1.5B rows comes from Iceberg metadata in a few seconds; don't scan it |
| 6 | `kszucs-catalog`, `openai.openai_humaneval` | 164 | Python coding problems with tests | The classic code benchmark; tiny |
| 7 | `kszucs-catalog`, `google-research-datasets.mbpp` | 974 | Python problems with test lists | `VARCHAR[]` test columns, four splits |
| 8 | `kszucs-catalog`, `nvidia.OpenMathReasoning` | 5,678,317 | Math problems with long model reasoning traces (DeepSeek-R1 in the sample) | Large reasoning traces; read with `LIMIT`, not full scans |
| 9 | `kszucs-catalog`, `deepmind.narrativeqa` | 46,765 | Questions about books and movie scripts | Deeply nested structs, and full book texts inside |
| 10 | `kszucs-catalog`, `openai.gsm8k` | 8,792 | Grade-school math word problems | Small and well known; good smoke test |
| 11 | `lhoestq-my-catalog`, `stanfordnlp.imdb` | 100,000 | Movie reviews labeled by sentiment | The Faceberg README example; a second catalog to attach |
| 12 | `kszucs-catalog`, `nvidia.OpenMathInstruct-2` | 21,972,791 | Synthetic math instruction pairs | Over 10M rows; one `GROUP BY` used up the whole Hugging Face rate limit |
| 13 | `kszucs-catalog`, `nvidia.open_math_reasoning` | 5,678,317 | Same data as `nvidia.OpenMathReasoning` | Duplicate, same row count and columns |
| 14 | `kszucs-mycatalog`, `openai.gsm8k` | 8,792 | Same data as `openai.gsm8k` above | Duplicate in a third catalog |

`lhoestq-my-catalog` also lists `BAAI.Infinity-Instruct` (7,449,106 rows). Its metadata
works, but reading data fails with `HTTP 401 Unauthorized` because the dataset is gated on
Hugging Face, so it isn't in the table.

### Snippets for the other datasets

Each snippet assumes the `hf` catalog from the top of this section is attached. Snippets for
other catalogs attach their own.

<details>
<summary>2. princeton-nlp.SWE-bench_Verified</summary>

500 real GitHub issues from 12 Python repos, each with the reference patch, the tests that
must pass, and a human estimate of how long the fix takes. It is one Parquet file, so every
query is fast and costs only a few requests.

```sql
SELECT repo, count(*) AS tasks,
       count(*) FILTER (difficulty IN ('1-4 hours', '>4 hours')) AS over_1h
FROM hf."princeton-nlp"."SWE-bench_Verified"
GROUP BY ALL ORDER BY tasks DESC LIMIT 5;
```

Expected: django/django 231 tasks (22 over an hour), sympy/sympy 75 (7), sphinx-doc/sphinx
44 (5), matplotlib/matplotlib 34 (0), scikit-learn/scikit-learn 32 (1).

"Do harder tasks need bigger fixes?":

```sql
SELECT difficulty, count(*) AS tasks,
       median(length(patch))::INT AS median_patch_chars,
       round(avg(len(regexp_extract_all(patch, 'diff --git'))), 1) AS avg_files_changed
FROM hf."princeton-nlp"."SWE-bench_Verified"
GROUP BY ALL ORDER BY median_patch_chars;
```

Expected: yes. The median patch grows from 668 characters (`<15 min fix`, 194 tasks) to 1,050
(`15 min - 1 hour`, 261), 3,334 (`1-4 hours`, 42) and 10,055 (`>4 hours`, 3).

</details>

<details>
<summary>3. NousResearch.hermes-function-calling-v1 (lhoestq-hermes-catalog)</summary>

```sql
ATTACH 'https://lhoestq-hermes-catalog.hf.space' AS lh (
    TYPE iceberg,
    ENDPOINT 'https://lhoestq-hermes-catalog.hf.space',
    AUTHORIZATION_TYPE 'none'
);
SELECT category, count(*) AS conversations, round(avg(len(conversations)), 1) AS avg_turns
FROM lh."NousResearch"."hermes-function-calling-v1"
GROUP BY ALL ORDER BY conversations DESC LIMIT 5;
```

Expected: Information Extraction 796, API Call 119, Industrial Software 65, Utilities
Software 52, Robotic Process Automation (RPA) 51; 3.0 turns on average.

</details>

<details>
<summary>4. openai.gdpval</summary>

```sql
SELECT sector, count(DISTINCT occupation) AS occupations, count(*) AS tasks,
       round(avg(len(reference_files)), 1) AS avg_input_files
FROM hf.openai.gdpval GROUP BY ALL ORDER BY tasks DESC LIMIT 5;
```

Expected: 5 rows with 5 occupations and 25 tasks each (every sector has the same count, so
which 5 sectors you get can vary).

</details>

<details>
<summary>5. HuggingFaceFW.fineweb-edu (1.5 billion rows: count and sample only)</summary>

```sql
SELECT count(*) AS documents FROM hf."HuggingFaceFW"."fineweb-edu";
SELECT dump, url, token_count, int_score FROM hf."HuggingFaceFW"."fineweb-edu" LIMIT 3;
```

Expected: 1,525,223,056 documents. `EXPLAIN` shows the count is a constant computed from the
Iceberg manifests (`COLUMN_DATA_SCAN`), so no data file is read. The sample rows are from the
`CC-MAIN-2013-20` crawl.

</details>

<details>
<summary>6. openai.openai_humaneval</summary>

```sql
SELECT task_id, entry_point, len(split(canonical_solution, chr(10))) AS solution_lines
FROM hf.openai.openai_humaneval ORDER BY solution_lines DESC LIMIT 5;
```

Expected: `HumanEval/81` (`numerical_letter_grade`, 32 lines) first.

</details>

<details>
<summary>7. google-research-datasets.mbpp</summary>

```sql
SELECT split, count(*) AS problems, round(avg(len(test_list)), 1) AS avg_tests
FROM hf."google-research-datasets".mbpp GROUP BY ALL ORDER BY ALL;
```

Expected: prompt 10, test 500, train 374, validation 90; 3 tests per problem.

</details>

<details>
<summary>8. nvidia.OpenMathReasoning</summary>

```sql
SELECT generation_model, inference_mode, problem_source, left(problem, 60) AS problem
FROM hf.nvidia."OpenMathReasoning" LIMIT 3;
```

Expected: 3 `DeepSeek-R1` / `cot` rows from AoPS forums. Avoid full scans of this table
(see the rate limit below).

</details>

<details>
<summary>9. deepmind.narrativeqa</summary>

```sql
SELECT document.kind AS kind, question.text AS question, answers[1].text AS answer
FROM hf.deepmind.narrativeqa LIMIT 3;
```

Expected: 3 questions about a Gutenberg book, starting with "Who is Miss Delmer?".

</details>

<details>
<summary>10. openai.gsm8k</summary>

```sql
SELECT split, count(*) AS problems FROM hf.openai.gsm8k GROUP BY ALL ORDER BY ALL;
```

Expected: test 1,319, train 7,473.

</details>

<details>
<summary>11. stanfordnlp.imdb (lhoestq-my-catalog)</summary>

```sql
ATTACH 'https://lhoestq-my-catalog.hf.space' AS lq (
    TYPE iceberg,
    ENDPOINT 'https://lhoestq-my-catalog.hf.space',
    AUTHORIZATION_TYPE 'none'
);
SELECT split, label, count(*) AS reviews
FROM lq.stanfordnlp.imdb
GROUP BY ALL ORDER BY ALL;
```

Expected: 12,500 reviews per label in `test` and `train`, and 50,000 unlabeled (`-1`) in
`unsupervised`.

</details>

<details>
<summary>12. nvidia.OpenMathInstruct-2 (22 million rows: sample only)</summary>

```sql
SELECT problem_source, expected_answer, left(problem, 70) AS problem
FROM hf.nvidia."OpenMathInstruct-2" LIMIT 3;
```

Expected: 3 rows from `augmented_gsm8k` and `augmented_math`. Don't `GROUP BY` this table:
in testing, one `GROUP BY problem_source` ran for over 2 minutes and then failed with
`HTTP 429 Too Many Requests`.

</details>

<details>
<summary>13. nvidia.open_math_reasoning (duplicate of 8)</summary>

```sql
SELECT count(*) AS problems FROM hf.nvidia.open_math_reasoning;
```

Expected: 5,678,317, the same as `nvidia."OpenMathReasoning"`.

</details>

<details>
<summary>14. openai.gsm8k (kszucs-mycatalog, duplicate of 10)</summary>

```sql
ATTACH 'https://kszucs-mycatalog.hf.space' AS km (
    TYPE iceberg,
    ENDPOINT 'https://kszucs-mycatalog.hf.space',
    AUTHORIZATION_TYPE 'none'
);
SELECT count(*) AS problems FROM km.openai.gsm8k;
```

Expected: 8,792.

</details>

### Caveats

- **Demo catalogs, no SLA.** These are personal demo Spaces (`kszucs`, `lhoestq`) on free
  Hugging Face hardware. They can change, move or disappear.
- **Spaces sleep.** A Space sleeps after about 48 hours without traffic and wakes on the
  first request, which can take a while. Wake it before you start, with either command:

  ```bash
  # macOS / Linux (curl)
  curl -s https://kszucs-catalog.hf.space/v1/config
  # Any OS, including Windows (uv runs a Python one-liner)
  uv run --python 3.13 python -c "import urllib.request; print(urllib.request.urlopen('https://kszucs-catalog.hf.space/v1/config', timeout=120).read().decode())"
  ```

  It returns a small JSON config (`{"defaults":{},"overrides":{...}}`) once the catalog is up.
- **Rate limit.** Hugging Face allows 3,000 anonymous resolver requests per 5 minutes per IP
  ([rate limits](https://huggingface.co/docs/hub/rate-limits)). Every HTTP range read of a
  Parquet file counts, and a room behind one NAT shares the budget. In testing, a SWE-bench
  query used about 5 requests, each `personas_brazil` query above about 70, and building
  `data/workshop.duckdb` from it about 200, but a full scan of a multi-million-row table can
  use all 3,000 and get everyone `HTTP 429` for up to 5 minutes. Use `count(*)` (answered
  from metadata) and `LIMIT`, and stay away from scans of the large tables.
- **Columns show as `UNKNOWN`** in `SHOW ALL TABLES` until a table is first queried. The
  catalog loads each table's schema lazily. `DESCRIBE` the table, or query it, to see the
  real types.

### Works on

Tested on 2026-11-02:

- **DuckDB CLI 1.5.6** (iceberg extension `890b78a9c`, httpfs `4bc690d`): every snippet on
  this page.
- **Local open source MCP** ([`mcp-server-motherduck`](https://github.com/motherduckdb/mcp-server-motherduck)
  1.1.0, DuckDB 1.5.6, read-only workshop database, `mcp/init.sql`): `ATTACH` works in the
  read-only session. Each tool call gets a fresh connection, so the attachment doesn't carry
  over to the next call. Put the `ATTACH IF NOT EXISTS` and the query in the same
  `execute_query` call, as in the next section.
- **MotherDuck, with `ATTACH`: no.** In a DuckDB CLI 1.5.6 session connected to `md:` (and in
  the `motherduck` CLI), `ATTACH ... (TYPE iceberg, ...)` succeeds, but the first query on an
  `hf` table crashes the client with a segmentation fault in the iceberg extension. Even
  without the crash it would run on your laptop: `duckdb_databases()` lists `hf` as a local
  `iceberg` database, not a `motherduck` one.
- **MotherDuck, as a persisted catalog: yes, server-side.** MotherDuck's documented way to
  attach an Iceberg REST catalog is
  [`CREATE DATABASE ... (TYPE ICEBERG)`](https://motherduck.com/docs/integrations/file-formats/apache-iceberg/).
  It requires a secret, and doesn't accept `AUTHORIZATION_TYPE`, so give it an Iceberg
  secret with a placeholder token (the public catalog ignores it):

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
  SELECT state, count(*) AS personas, round(avg(age), 1) AS avg_age
  FROM hf_faceberg.nvidia.personas_brazil
  GROUP BY ALL ORDER BY personas DESC LIMIT 5;
  ```

  Expected: the same rows as the local query above, São Paulo 224,991 (45.0) down to Paraná
  57,084 (44.8), in about a second. `EXPLAIN` marks `ICEBERG_SCAN`, the aggregate and the
  top-N as remote (`R`), so MotherDuck reads the Parquet files, not your laptop. The other two
  `personas_brazil` queries above return the same results there too.
  `princeton-nlp.SWE-bench_Verified`, `google-research-datasets.mbpp`, `openai.gdpval` and
  `openai.gsm8k` also worked this way, as did a `CREATE TABLE ... AS SELECT` from the catalog
  into a regular MotherDuck database and into a DuckLake database (see
  [section 8](../08-end-to-end/README.md)).
  MotherDuck's docs list only S3, S3-compatible storage and GCS as supported storage for REST
  catalogs, and these files are on Hugging Face, so treat this as working but unsupported.
  The database persists in your organization. To remove it:

  ```sql
  -- On MotherDuck (md:)
  DROP DATABASE hf_faceberg;
  DROP SECRET hf_faceberg;
  ```

## Query it with the open source MCP

The server from [section 2](../02-local-mcp/README.md) loads the iceberg and httpfs extensions
on every connection (option B, through `mcp/init.sql`), so the agent can attach the catalog
itself. The server opens a new connection for each tool call, so ask for the `ATTACH` and the
query in one call. The last part of the section 2 test prompt does this:

> Using the duckdb tools, run this as a single `execute_query` call:
> `ATTACH IF NOT EXISTS 'https://kszucs-catalog.hf.space' AS hf (TYPE iceberg, ENDPOINT 'https://kszucs-catalog.hf.space', AUTHORIZATION_TYPE 'none'); SELECT state, count(*) AS personas, round(avg(age), 1) AS avg_age FROM hf.nvidia.personas_brazil GROUP BY ALL ORDER BY personas DESC LIMIT 5`

Expected: São Paulo 224,991 (45.0), Minas Gerais 103,935 (45.3), Rio de Janeiro 81,718
(45.9), Bahia 68,851 (44.2), Paraná 57,084 (44.8).

Other things to ask for: the columns of `hf.nvidia.personas_brazil`, the data files behind a
table (`iceberg_metadata`), or one of the questions above.

`data/workshop.duckdb` already holds a local copy of this table: `personas` has all
1,000,000 rows and 9 of the 22 columns, and `states` maps each state to its abbreviation and
region. [`mcp/build_workshop_db.sql`](../mcp/build_workshop_db.sql) builds it with the same
`ATTACH`. Ask the agent the same question of the local `personas` table: the answer is the
same, it comes back in milliseconds, and it costs no Hugging Face requests. Querying a local
copy instead of the remote table is the local caching pattern from
[section 9](../09-local-dev-best-practices/README.md).

Next: [4. Introduce DuckLake](../04-ducklake/README.md).
