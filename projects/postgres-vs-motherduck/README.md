# postgres-vs-motherduck

The **same query, the same `pg` driver, two engines — side by side.** A Next.js page
fires one heavy analytical aggregate (a full scan of ~3.9M order-items) at a managed
**Postgres** and at **MotherDuck** at the same time, then renders each as a bar chart the
moment its engine answers. You watch Postgres grind while MotherDuck has already drawn its
chart — and the latency is **server-measured**, so it's a real number, not a vibe.

Use it two ways: point it at **your own Postgres** to see the real ingest-and-serve workflow,
or **start from the ready-made MotherDuck share** when you don't have data of your own. Either
way it drives the same webapp.

> Experimental. Part of [MotherDuck Labs](../../README.md).

## Two ways to use it

**1 — Bring your own Postgres.** Point it at a database you already run. The pipeline then
shows the real workflow: **ingest** your Postgres into MotherDuck (DuckDB's Postgres scanner —
full-refresh dimensions, incremental facts) and **serve** the identical query from MotherDuck.
This is the production story — *"I have Postgres; how do I make the analytics fast?"*

```bash
uv run hello_postgres_scanner.py    # read your Postgres in place — no data moved
uv run load_to_motherduck.py        # ingest → MotherDuck, then serve it in the app
```

**2 — Start from the MotherDuck share.** No Postgres of your own? The demo dataset is
published as an unrestricted **public share**, so you can have the "after" running in one
command — and even manufacture a "before" Postgres from that same share:

```bash
uv run attach_share.py              # the "after", instantly — no loading
uv run seed_postgres.py             # optional "before": share → throwaway Postgres (indexed)
```

The webapp doesn't care which path you took — for MotherDuck it reads the database
`multishop_commerce` (your own load, or the attached share); for Postgres it reads your
`POSTGRES_URL`. Same query, same driver, either way.

## What it demonstrates

| Element | Where |
|---|---|
| Identical SQL against both engines | `webapp/lib/queries.ts` — one source of truth, run verbatim on each |
| The engine switch is just a host swap | `webapp/lib/db.ts` — same `pg` `Pool`, different host + credentials |
| Live, server-measured latency | `webapp/app/api/chart/route.ts` — times the query on the server, per engine |
| Side-by-side charts (no chart lib) | `webapp/app/page.tsx` — dependency-free inline SVG |
| Ready-made data via a share | `pipeline/attach_share.py` — attach the public share as the "after" |
| Seed a "before" Postgres | `pipeline/seed_postgres.py` — share → Postgres, with fair indexes |
| Move your own data in | `pipeline/load_to_motherduck.py` — DuckDB Postgres scanner, dims + incremental facts |
| Prove it from the terminal too | `pipeline/benchmark.py` — times the same query on both, prints the speedup |

The point: MotherDuck speaks the **Postgres wire protocol**, so "switching to MotherDuck"
is a different connection host — no DuckDB native extension, no SQL rewrite, no driver
change. That's also why the webapp runs fine in a serverless function.

```
postgres-vs-motherduck/
├─ webapp/      Next.js app — the side-by-side comparison. This is what deploys to Vercel.
└─ pipeline/    Python (uv) — attach the share, seed a Postgres, or load your own → MotherDuck.
```

## Run locally

You need a **MotherDuck token** (free tier is fine). A Postgres is only needed for the
"before" — and the seed script can make you one.

**1 — set up the data.** Pick the path that fits:

```bash
cd pipeline
cp .env.example .env                  # fill in MOTHERDUCK_TOKEN (+ POSTGRES_URL for the 'before')

# (a) Fast path — the "after" with zero loading: attach the ready-made public share.
uv run attach_share.py

# (b) Optional — manufacture a slow "before": load the share into a throwaway Postgres,
#     with the indexes a real OLTP Postgres would have (so the comparison is fair).
uv run seed_postgres.py               # or: uv run seed_postgres.py --fraction 0.25

# (c) Your own data instead: move your existing Postgres into MotherDuck.
uv run hello_postgres_scanner.py      # sanity-check the connection
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
2. **Environment variables** (Production): `MOTHERDUCK_TOKEN` + `POSTGRES_URL` (the "before"),
   and optionally `MD_DATABASE`, `MD_SHARE_URL`, `MD_PG_HOST`, `DATA_SOURCE` — see
   [`webapp/.env.example`](./webapp/.env.example). The "after" reads the public share once
   you've attached it (`uv run attach_share.py`), so no MotherDuck data-loading is required.
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
  string, and the **MotherDuck token is the password**. It reads the database named by
  `MD_DATABASE` (default `multishop_commerce`) — that's the attached public share, or your
  own load. No DuckDB native extension involved.

`DATA_SOURCE` (or the `?source=` query param) picks which pool answers. Same query text
either way.

## The dataset

A synthetic multi-shop commerce platform — shops (tenants) on plan tiers, their catalog, and
~3.9M order line-items — published as the public share
`md:_share/multishop_commerce/ac3d36cc-f295-4c66-bf13-371b998f12e8`:

| Table | Kind | Rows |
|---|---|---|
| `shops` | dimension | 500 |
| `categories` | dimension | 12 |
| `products` | dimension | 50,000 |
| `customers` | dimension | 500,000 |
| `orders` | fact | 2,000,000 |
| `order_items` | fact | 3,938,272 |

The comparison query is a full scan of `order_items` joined up to `orders` and `shops` —
exactly the analytical aggregate a row-store labors over and a columnar engine eats for
breakfast.

## Known limitations

- **Latency is environment-dependent.** Numbers depend on your Postgres instance size, its
  region, MotherDuck warm/cold state, and serverless cold starts. The *shape* of the gap is
  the point, not an exact multiplier. The seed adds the obvious indexes so Postgres gets a
  fair shot — it's a row-store-vs-columnar comparison, not Postgres-with-no-indexes.
- **No auth.** See the deployment note above — protect any public URL.
- The `/dashboard` page also expects an optional MotherDuck **Dive** embed
  (`NEXT_PUBLIC_DIVE_URL`) for the per-shop drill-down; it's optional and degrades gracefully.
