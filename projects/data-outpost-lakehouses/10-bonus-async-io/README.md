# 10. Bonus round: DuckDB 2.0's Async IO and Lakehouses

[DuckDB 2.0.0](https://duckdb.org/2026/10/21/announcing-duckdb-200.html) (released
2026-10-21) adds asynchronous I/O. In 1.5, each worker thread downloads a chunk of a file,
waits for it, decodes it, and repeats, so the CPU idles during downloads and the network
idles during decoding. In 2.0, a separate pool of I/O threads keeps many reads in flight while
the worker threads decode data that has already arrived.

Lakehouse tables are Parquet files in object storage, so lakehouse scans are mostly remote
Parquet reads. Async I/O targets exactly that.

## What the docs say

From [DuckDB 2.0 I/O](https://duckdb.org/docs/2.0/data/io) and the
[announcement](https://duckdb.org/2026/10/21/announcing-duckdb-200.html):

- Async I/O covers Parquet, uncompressed UTF-8 CSV, and DuckDB's own database files. Other
  formats, such as JSON, still read synchronously.
- It applies automatically when those formats are read through a lake format such as
  DuckLake.
- It's on by default. Two settings tune it:
  - `async_threads`: size of the I/O pool. Default: four times the number of threads, capped
    at 256.
  - `read_ahead_depth`: how many scan jobs to read ahead. Default `-1` (unlimited, bounded by
    memory); `0` turns read-ahead off.
- The [workload tuning guide](https://duckdb.org/docs/2.0/guides/performance/how_to_tune_workloads)
  has an example for fast cloud networks.

> TODO: The DuckDB docs don't say whether Iceberg reads (for example an attached Iceberg REST
> catalog such as `hf.nvidia.personas_brazil` from section 3) use async I/O. Verify before
> claiming Iceberg gets the speedup.

DuckDB's own benchmark in [PR #23662](https://github.com/duckdb/duckdb/pull/23662) (the
read-ahead change) ran the 99 TPC-DS SF100 queries on Parquet in S3 from an r7i.16xlarge:
597 s on 1.5.4 and 196 s with read-ahead, about 3x faster.

MotherDuck's [Why DuckDB 2.0 is faster](https://motherduck.com/blog/why-duckdb-20-is-faster/)
benchmarks a 2.2 GB Parquet file on S3: 18.8 s on 1.5.5 and 7.7 s on a 2.0 alpha, from a
laptop on a home connection.

## Try it

The workshop pins DuckDB 1.5.6, so run 2.0 in a throwaway environment and don't upgrade the
workshop's `.venv`. Two things to know:

- DuckDB versions before 2.0 can't read database files that 2.0 creates. The script below
  uses an in-memory database, so it never opens `data/workshop.duckdb` with 2.0.
- MotherDuck supports DuckDB clients up to 1.5.6 at the time of writing
  ([version lifecycle](https://motherduck.com/docs/troubleshooting/version-lifecycle-schedules/)).
  Keep 1.5.6 for anything that connects to MotherDuck.

[`compare_async_io.py`](compare_async_io.py) scans the 30 days of Hacker News comment Parquet
files in MotherDuck's public bucket (253,097 rows) three times. It turns off DuckDB's cache of
remote files so every run reads from S3. Run it once per version, from the workshop folder:

```bash
uv run --no-project --python 3.13 --with duckdb==1.5.6 python 10-bonus-async-io/compare_async_io.py
uv run --no-project --python 3.13 --with duckdb==2.0.0 python 10-bonus-async-io/compare_async_io.py
```

`--no-project --with` builds a temporary environment, so neither command touches `.venv`.

On one MacBook (10 threads) on 2026-11-02, 1.5.6 took 4.6–5.3 s per run and 2.0.0 took
2.7–3.5 s. That is one run on one network; yours will differ.

To see the settings, run this on 2.0 (on 1.5.6 they don't exist):

```sql
SELECT name, value FROM duckdb_settings() WHERE name IN ('async_threads', 'read_ahead_depth', 'threads');
```

As of 2026-11-02 the `duckdb-cli` package on PyPI stops at 1.5.6, so
`uvx --from duckdb-cli==2.0.0` doesn't work yet. For a 2.0 CLI, see
[DuckDB installation](https://duckdb.org/install/).

> TODO: Add a lakehouse version of the comparison, such as a DuckLake over the same files
> (the frozen space-missions DuckLake from section 4, or the local DuckLake from section 9). Not tested
> with 2.0. Opening those `.ducklake` catalog files with 2.0 might also make them unreadable
> by 1.5.6, so test on copies.

## References

- [Announcing DuckDB 2.0.0](https://duckdb.org/2026/10/21/announcing-duckdb-200.html)
- [DuckDB 2.0 I/O documentation](https://duckdb.org/docs/2.0/data/io)
- [How to tune workloads](https://duckdb.org/docs/2.0/guides/performance/how_to_tune_workloads)
- [Why DuckDB 2.0 is faster (MotherDuck blog)](https://motherduck.com/blog/why-duckdb-20-is-faster/)
