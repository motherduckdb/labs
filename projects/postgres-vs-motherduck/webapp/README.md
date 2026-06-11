# webapp — Next.js

The side-by-side comparison app. It reads the heavy analytics query through the standard
**`pg` driver** — pointed at either your Postgres or MotherDuck. The query and component code
never change; only where it connects does.

## Run

```bash
npm install
cp .env.example .env       # fill in POSTGRES_URL, MOTHERDUCK_TOKEN, MD_PG_HOST
npm run dev                # → http://localhost:3000
```

## Routes

| Route | What it shows |
|---|---|
| `/` | **The comparison.** The same query rendered as a chart from *both* engines, side by side. Hit "Run comparison" and watch the load-time gap live. |
| `/api/chart?source=…` | Runs the platform aggregate against one engine; returns the monthly revenue series + server query latency (JSON). The comparison page calls this once per engine. |
| `/api/benchmark` | Runs the query against both engines server-side and returns both latencies + speedup (JSON). |

## The side-by-side comparison (`/`)

Both panels run the **identical** `PLATFORM_MONTHLY_REVENUE` query — a full scan of ~3.9M
order-items joined to orders — through the same `pg` driver. The only difference is the
connection host. Each panel fetches its engine independently, so they render as soon as
*their* engine answers: a timer ticks up while Postgres grinds, while MotherDuck has already
drawn its bar chart.

> Attach the public share (`../pipeline/attach_share.py`) or load your own
> (`../pipeline/load_to_motherduck.py`) first, so the MotherDuck side has data — otherwise the
> MotherDuck panel returns "database … not found".

The charts are dependency-free inline SVG (no chart library), to keep the demo trivial to read.

## How the switch works

`lib/db.ts` builds a `pg` `Pool` per engine:

- **postgres** → your managed Postgres, via a standard connection string.
- **motherduck** → MotherDuck's Postgres wire-protocol endpoint (host swap + token as password).

No DuckDB native extension is used here — the MotherDuck read path is the Postgres wire
endpoint, so it runs reliably in any Node / serverless environment.
