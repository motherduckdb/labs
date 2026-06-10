# postgres-vs-motherduck

The **same query, the same `pg` driver, two engines — side by side.** A Next.js page
fires one heavy analytical aggregate (a full scan of ~39M order-items) at your managed
**Postgres** and at **MotherDuck** at the same time, then renders each as a bar chart the
moment its engine answers. You watch Postgres grind for ~100s while MotherDuck has already
drawn its chart in ~1s — and the latency is **server-measured**, so it's a real number, not
a vibe. A small Python pipeline moves the data from Postgres into MotherDuck so you can
reproduce the whole thing end to end.

> Experimental. Part of [MotherDuck Labs](../../README.md).

## What it demonstrates

| Element | Where |
|---|---|
| Identical SQL against both engines | `webapp/lib/queries.ts` — one source of truth, run verbatim on each |
| The engine switch is just a host swap | `webapp/lib/db.ts` — same `pg` `Pool`, different host + credentials |
| Live, server-measured latency | `webapp/app/api/chart/route.ts` — times the query on the server, per engine |
| Side-by-side charts (no chart lib) | `webapp/app/page.tsx` — dependency-free inline SVG |
| Reproduce the data load | `pipeline/load_to_motherduck.py` — DuckDB Postgres scanner, full-refresh dims + incremental facts |
| Prove it from the terminal too | `pipeline/benchmark.py` — times the same query on both, prints the speedup |

The point: MotherDuck speaks the **Postgres wire protocol**, so "switching to MotherDuck"
is a different connection host — no DuckDB native extension, no SQL rewrite, no driver
change. That's also why the webapp runs fine in a serverless function.

```
postgres-vs-motherduck/
├─ webapp/      Next.js app — the side-by-side comparison. This is what deploys to Vercel.
└─ pipeline/    Python (uv) — move Postgres → MotherDuck, and a CLI benchmark.
```

## Run locally

You need a populated Postgres (the "before") and a MotherDuck account (the "after").

**1 — move the data into MotherDuck** (skip if MotherDuck is already loaded):

```bash
cd pipeline
cp .env.example .env                  # fill in POSTGRES_URL + MOTHERDUCK_TOKEN + MD_PG_HOST
uv run hello_postgres_scanner.py      # sanity-check: read Postgres in place, list the tables
uv run load_to_motherduck.py          # full-refresh dims, incremental facts
```

`uv` resolves each script's deps inline ([PEP 723](https://peps.python.org/pep-0723/)) — no
`pip install`, no virtualenv. See [`pipeline/README.md`](./pipeline/README.md) for details.

**2 — run the app:**

```bash
cd ../webapp
npm install
cp .env.example .env                  # same vars as the pipeline
npm run dev                           # → http://localhost:3000
```

Open `http://localhost:3000`, hit **Run comparison**, and watch the gap. See
[`webapp/README.md`](./webapp/README.md) for the routes and how the switch works.

## Deploy on Vercel (make it live)

The `webapp/` folder is a self-contained Next.js app. Because this repo is a monorepo with
no top-level `package.json`, point Vercel at the subdirectory:

1. **Import the repo**, then set **Root Directory → `projects/postgres-vs-motherduck/webapp`**
   in the Vercel project settings. (Deploying from inside that folder with `vercel` CLI sets
   this for you.)
2. **Environment variables** (Production): `POSTGRES_URL`, `MOTHERDUCK_TOKEN`, `MD_PG_HOST`,
   and optionally `MD_DATABASE`, `MD_PG_PORT`, `MD_PG_USER`, `DATA_SOURCE` — see
   [`webapp/.env.example`](./webapp/.env.example).
3. **Protect the deployment.** This app has **no application-level auth**, and every request
   runs live queries against your Postgres and MotherDuck on your credentials. An open URL
   therefore lets anyone hammer your databases (and your bill). Turn on Vercel
   **Deployment Protection → Password / Vercel Authentication**, or share it only with people
   you trust to "measure things."

Each visitor's "Run comparison" click runs the real query on both engines, so the numbers
they see are their own — a live, shareable benchmark.

## How the switch works

`webapp/lib/db.ts` builds a `pg` `Pool` per engine:

- **postgres** → your managed Postgres, via a standard connection string.
- **motherduck** → MotherDuck's Postgres wire endpoint: host swap, `user` is any non-empty
  string, and the **MotherDuck token is the password**. No DuckDB native extension involved.

`DATA_SOURCE` (or the `?source=` query param) picks which pool answers. Same query text
either way.

## The dataset

A synthetic multi-shop commerce platform — shops (tenants) on plan tiers, their catalog, and
~40M order line-items:

| Table | Kind | Rows |
|---|---|---|
| `shops` | dimension | 500 |
| `categories` | dimension | 12 |
| `products` | dimension | 50,000 |
| `customers` | dimension | 500,000 |
| `orders` | fact | 20,000,000 |
| `order_items` | fact | 39,382,720 |

The comparison query is a full scan of `order_items` joined up to `orders` and `shops` —
exactly the analytical aggregate a row-store labors over and a columnar engine eats for
breakfast.

## Known limitations

- **Latency is environment-dependent.** Numbers depend on your Postgres instance size, its
  region, MotherDuck warm/cold state, and serverless cold starts. The *shape* of the gap is
  the point, not an exact multiplier.
- **No auth.** See the deployment note above — protect any public URL.
- **Bring your own data.** This repo ships the app and the loader, not the source dataset.
  You need a Postgres with the schema above (or adapt the queries to your own tables).
- The `/dashboard` page also expects an optional MotherDuck **Dive** embed
  (`NEXT_PUBLIC_DIVE_URL`) for the per-shop drill-down; it's optional and degrades gracefully.
