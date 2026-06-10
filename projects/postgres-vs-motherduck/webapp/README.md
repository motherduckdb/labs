# webapp — Next.js dashboard

A multi-shop storefront admin dashboard. It reads the heavy analytics query through the
standard **`pg` driver** — pointed at either your Postgres or MotherDuck. The component code
never changes; only where it connects does.

## Run

```bash
npm install
cp .env.example .env       # fill in POSTGRES_URL, MOTHERDUCK_TOKEN, MD_PG_HOST
npm run dev                # → http://localhost:3000
```

## Pages

| Route | What it shows |
|---|---|
| `/` | **The comparison.** Same query rendered as a chart from *both* engines, side by side. Hit "Run comparison" and watch the load-time gap live. |
| `/dashboard` | Single-source table of monthly revenue, driven by the `DATA_SOURCE` env var (`postgres` \| `motherduck`). |
| `/api/chart?source=…` | Runs the platform aggregate against one engine; returns the monthly revenue series + server query latency (JSON). The comparison page calls this once per engine. |
| `/api/benchmark` | Runs the query against both engines server-side and returns both latencies + speedup (JSON). |

## The side-by-side comparison (`/`)

Both panels run the **identical** `PLATFORM_MONTHLY_REVENUE` query — a full scan of ~39M
order-items joined to orders — through the same `pg` driver. The only difference is the
connection host. Each panel fetches its engine independently, so they render as soon as
*their* engine answers: a timer ticks up while Postgres grinds (~100s on this dataset),
while MotherDuck has already drawn its bar chart (~1s).

> Run `../pipeline/load_to_motherduck.py` first so MotherDuck is populated — otherwise the
> MotherDuck panel returns "no database … found".

The charts are dependency-free inline SVG (no chart library), to keep the demo trivial to read.

## How the switch works

`lib/db.ts` builds a `pg` `Pool` per engine:

- **postgres** → your managed Postgres, via a standard connection string.
- **motherduck** → MotherDuck's Postgres wire-protocol endpoint (host swap + token as password).

No DuckDB native extension is used here — the MotherDuck read path is the Postgres wire
endpoint, so it runs reliably in any Node / serverless environment.
