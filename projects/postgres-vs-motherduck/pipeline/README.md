# pipeline — Python (uv)

Small single-purpose scripts, each a single `uv run`. Every script carries its own
dependencies inline ([PEP 723](https://peps.python.org/pep-0723/)), so there is
**no install step and no virtualenv to manage** — `uv` reads the header, builds an
ephemeral env, and runs it. **These are Python, not Node** — there is no `pnpm`/`npm`
seed step; the webapp is the only Node piece.

| Script | What it does |
|---|---|
| `attach_share.py` | The zero-data **"after"**: attach the ready-made public MotherDuck share so the webapp works with nothing but a token. No Postgres, no load. |
| `seed_postgres.py` | Optional **"before"**: DuckDB reads the public share and writes it into a throwaway Postgres, then creates the indexes a real OLTP Postgres would have (a *fair* comparison). |
| `hello_postgres_scanner.py` | Local DuckDB reads *your* Postgres in place via the **Postgres scanner** — lists the source tables + row counts. No data moved. |
| `load_to_motherduck.py` | Moves *your* Postgres → MotherDuck via the scanner (full-refresh dims, incremental facts). |
| `benchmark.py` | Times the same query on Postgres vs MotherDuck (same driver, different host) and prints the speedup. |

## Setup

```bash
cp .env.example .env        # MOTHERDUCK_TOKEN always; POSTGRES_URL for the 'before'
```

That's it. No `pip install`, no `uv venv` — each `uv run` resolves its own deps.

## The fast path — `attach_share.py`

You don't move data *into* Postgres for this demo; the real story offloads it *out*
to MotherDuck. So the quickest way to see the "after" is to attach the ready-made
public share — no Postgres, no loading:

```bash
uv run attach_share.py
```

It attaches `md:_share/multishop_commerce/…` into your account as `multishop_commerce`
(the database the webapp reads) and prints the row counts. Run it once.

## Manufacture a "before" — `seed_postgres.py`

Don't have a big slow Postgres to compare against? Make one from the same share. DuckDB
reads the share and writes it into your (throwaway) Postgres, then adds primary-key and
foreign-key indexes — so the "before" is a fairly-tuned row store, not a strawman:

```bash
uv run seed_postgres.py                  # full share (~3.9M order_items)
uv run seed_postgres.py --fraction 0.25  # a quarter of the facts, for a quicker load
```

## Bring your own data instead

Already have data in Postgres? Skip the share and move *yours* into MotherDuck.

**Read your Postgres in place** (no data moved) — proves the connection and lists
the source tables live:

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
  [fact] orders           2,000,000 rows
  [fact] order_items      3,938,272 rows

sample — order_items (read straight from Postgres)
...
hello world OK — the scanner can read your Postgres.
```

**Move it into MotherDuck:**

```bash
uv run load_to_motherduck.py
```

Dimensions full-refresh; facts append on an `order_id` watermark, so re-running
only pulls new rows.

## Prove it — `benchmark.py`

```bash
uv run benchmark.py            # both queries
uv run benchmark.py --shop 42  # single-shop query for a given shop

# example output (scale and hardware dependent):
#  -- Platform-wide monthly revenue
#    Postgres    cold  11.80 s  best  10.40 s  (111 rows)
#    MotherDuck  cold   1.30 s  best    210 ms  (111 rows)
#    -> MotherDuck is ~50x faster (best of 3); rows match
```

Then **see it in the webapp** — `../webapp` renders the same query as a chart from
each engine, side by side, so you can watch the load-time gap (`cd ../webapp`).

> `requirements.txt` is kept for reference / non-uv setups, but with `uv run` you
> don't need it — the deps live in each script's header.
