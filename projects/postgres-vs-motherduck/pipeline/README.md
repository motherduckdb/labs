# pipeline — Python (uv)

Three small steps, each a single `uv run`. Every script carries its own
dependencies inline ([PEP 723](https://peps.python.org/pep-0723/)), so there is
**no install step and no virtualenv to manage** — `uv` reads the header, builds an
ephemeral env, and runs it.

| Step | Script | What it does |
|---|---|---|
| 1 — hello world | `hello_postgres_scanner.py` | Local DuckDB reads your Postgres in place via the **Postgres scanner**. Prints a view on the dataset sources (tables + row counts). No data moved. |
| 2 — load | `load_to_motherduck.py` | Moves Postgres → MotherDuck via the scanner (full-refresh dims, incremental facts). |
| 3 — prove it | `benchmark.py` | Times the same query on Postgres vs MotherDuck (same `psycopg` driver, different host) and prints the speedup. |

## Setup

```bash
cp .env.example .env        # fill in POSTGRES_URL, MOTHERDUCK_TOKEN, MD_PG_HOST
```

That's it. No `pip install`, no `uv venv` — each `uv run` resolves its own deps.

## Step 1 — hello world: read Postgres with the scanner

Prove the connection works and get a first look at the source dataset, without
moving anything. A plain in-memory DuckDB attaches your remote Postgres read-only
and counts every source table live:

```bash
uv run hello_postgres_scanner.py
```

```
attached remote Postgres via the scanner (read-only)

source tables
----------------------------------------
  [dim ] shops                  500 rows
  [dim ] categories              12 rows
  [dim ] products            50,000 rows
  [dim ] customers          500,000 rows
  [fact] orders          20,000,000 rows
  [fact] order_items     39,382,720 rows

sample — order_items (read straight from Postgres)
...
hello world OK — the scanner can read your Postgres.
```

## Step 2 — load: move the data into MotherDuck

```bash
uv run load_to_motherduck.py
```

Dimensions full-refresh; facts append on an `order_id` watermark, so re-running
only pulls new rows.

## Step 3 — prove it: benchmark Postgres vs MotherDuck

```bash
uv run benchmark.py            # both queries
uv run benchmark.py --shop 42  # single-shop query for a given shop

# example output:
#  -- Platform-wide monthly revenue
#    Postgres    cold  107.56 s  best  101.40 s  (111 rows)
#    MotherDuck  cold    1.30 s  best     210 ms  (111 rows)
#    -> MotherDuck is 483x faster (best of 3); rows match
```

Then **see it in the webapp** — `../webapp` renders the same query as a chart from
each engine, side by side, so you can watch the load-time gap (`cd ../webapp`).

> `requirements.txt` is kept for reference / non-uv setups, but with `uv run` you
> don't need it — the deps live in each script's header.
