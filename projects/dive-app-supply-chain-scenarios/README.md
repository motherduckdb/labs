# Supply chain scenario modeling (a Dive App with writeback)

A supply planning app built entirely on MotherDuck: a **Dive** is the UI, and a **Flight** saves
every change. Planners model what happens when demand outruns planned supply, and whether
it's worth paying to close the gap. They can edit planned receipts cell by cell in a real
spreadsheet, compare scenarios, and push one through **draft → submitted → approved**.
Approval writes the plan to a table. "Push to ERP" queues the order lines it implies in an
outbox for downstream systems.

The question each scenario answers is **"is it worth it?"** Each scenario is also computed with
every lever off (same demand, same supply). The headline KPI is the net margin impact between
the two. Then come demand met, recovered revenue and the extra cost per recovered unit.

The levers:

| Lever | What it does | Cost |
|---|---|---|
| Expedited shipping, 5-day / 3-day | Wins back 35% / 55% of a shortfall, capped at a share of weekly receipts | $1.50 / $3.25 per unit |
| Expedited shipping, 1-day (air) | Wins back 85%, but costs more than most categories earn per unit. **On its own it loses money.** | $55 per unit |
| Drop ship supplier → customer | Ships part of what's still short straight to the customer; keeps 92% of those customers | $14 per unit |
| Subcontract manufacturer | Extra weekly capacity at a unit-cost premium; excess stock pays holding cost | premium % of unit cost |

Demand comes from the baseline forecast, or from an approved plan of an upstream demand
planner. A "demand vs forecast" slider adds a stress-test upside on top.

## What's in the Dive

- **Title row:** a Baseline tab and a dropdown of the other scenarios, plus Duplicate, rename and
  delete. The save state and the workflow actions sit on the right: Submit for approval, Send
  back / Approve, then Push to ERP / Reopen.
- **Filters** (region and category multi-selects) narrow the KPIs, the chart and the grid.
- **Supply levers:** the drivers above. The plan recomputes instantly in the browser and saves
  about 600 ms after you stop moving a control.
- **Weekly chart:** demand, supply and end-of-week inventory lines, over bars showing how demand
  was met (from stock, expedited, drop shipped, lost).
- **Supply and demand grid** (a [Univer](https://univer.ai) spreadsheet): Demand, Supply and
  Inventory rows per region × category, each tinted to match its chart series.
  - **Supply** is editable. Type, paste or enter a formula to override a week, or delete to revert.
  - **Inventory** is a live formula on the rows above it:
    `=MAX(0, previous week + supply [+ subcontract units] − demand)`. It's locked: you can open a
    cell to see which cells feed it, but any change is put back.
  - **Overrides:** ones made in this session show a stronger yellow than ones saved earlier.
    Hovering an override shows who made it and when.
- **Compare tab:** every scenario side by side, plus the approved plans and the ERP outbox read
  back from MotherDuck.
- **Activity tab:** the activity log, one row per save.

## How the writes work

A Dive runs on a read-only connection, so it can't write to the database directly. Instead:

```
Dive (any member of the organization)
  reads   md:_share/scenario_planner_org/…  (org-wide, automatically updated share; alias scenario_planner)
  writes  useRunFlight(supply-planner-write, {OP, ARGS, ACTOR, REQUEST_ID})
          → wait for the run → REFRESH DATABASE → read the reply from supply.rpc_results
Flight  supply-planner-write, owned by the service account scenario_planner_writer
          (which owns the database); GRANT RUN … TO ORGANIZATION
          validates the op (ranges, allowed cells, status transitions, optimistic versions),
          writes it, logs it, recomputes the plan server-side on approval, CREATE SNAPSHOT
```

Each save takes a few seconds. The clicked button shows a spinner and the header reads
"Saving…". Saves are queued, and grid edits made during a save go out together in the next one.

Database `scenario_planner`:

| Schema | Tables |
|---|---|
| `main` | `categories`, `regions`, `baseline_forecast`, `supply_plan` (synthetic data from `flight/static.sql`); `approved_plan`: approved *demand* plans from an upstream demand planner (optional, empty by default; each becomes a demand source) |
| `supply` | `scenarios`, `scenario_overrides`, `activity_log`, `approved_plan` (approved supply plans), `erp_orders` (the ERP outbox; no ERP is connected), `rpc_results` |

## Layout

| Path | What it is |
|---|---|
| `dive/src/dive.tsx` | The Dive: scenarios, filters, levers, KPIs, chart, Compare and Activity |
| `dive/src/SupplyGrid.tsx` | The supply and demand grid (Univer): formulas, locking, edit colours and tooltips |
| `dive/src/engine.ts` | The supply planning engine (browser) |
| `dive/src/flight-backend.ts` | Writes through the Flight, and the one-statement bootstrap read |
| `dive/src/univer-runtime.ts` | Loads Univer inside the Dive sandbox (inlined UMD bundles; no dynamic imports) |
| `dive/scripts/` | `fetch-vendor.sh` + `build-vendor.mjs` (pack Univer), `build-dive.mjs` (bundle), `deploy-dive.sh` (create/update the Dive) |
| `flight/planner.py` | The backend: `Store` (schema, seeds) and `Api` (every write op) |
| `flight/supply_engine.py` | Python port of `engine.ts`, used on approval: the stored plan never depends on numbers sent by the browser |
| `flight/write_flight.py`, `flight/build_flight.py` | The Flight entrypoint, and the build that inlines the engine and backend into one file |
| `flight/setup.py` | Sets up an organization: service account, database, share, Flight, grants |
| `flight/static.sql` | The synthetic planning data |
| `e2e/` | `engine-parity.test.mjs` (TS and Python engines agree on every cell), `flight_smoke_test.py` (every op on a local DuckDB file) |

## Run it in your organization

You need an organization admin's MotherDuck token, the DuckDB CLI, Node.js 20+ and [uv](https://docs.astral.sh/uv/).

```bash
cd dive && npm install && npm run vendor && cd ..       # once: esbuild + the Univer bundle

# 1. Backend, as an org admin: service account, database, share, Flight, GRANT RUN TO ORGANIZATION.
#    Idempotent; saves the share URL and Flight id in dive/deploy-targets.json under <target>.
export motherduck_token=...                              # yours
uv run --with duckdb==1.5.6 --with pytz python flight/setup.py prod
#    (another org or endpoint: flight/setup.py devrel --admin-token-env motherduck_token_devrel
#     [--api https://api.staging.motherduck.com --host api.staging.motherduck.com])

# 2. The Dive, as yourself. The first run creates it and saves its id; later runs update it.
dive/scripts/deploy-dive.sh prod
```

The service account's token is saved to `~/.config/scenario-planner/<target>-sa-token`
(mode 0600) and reused. You only need it to update the Flight, not to run it.
`dive/deploy-targets.example.json` shows the shape of `deploy-targets.json`.

## Test

```bash
node e2e/engine-parity.test.mjs                                          # TS vs Python engines
uv run --with duckdb==1.5.6 --with pytz python e2e/flight_smoke_test.py  # every Flight op, locally
cd dive && npm run typecheck
```

## Known limitations

- Each save is a Flight run, so it takes a few seconds. Fine for planning; not for typing-speed collaboration.
- Concurrent edits use optimistic versions on drivers and status changes. Grid overrides are
  last-writer-wins per cell.
- The data is synthetic (an apparel retailer: 4 regions × 6 categories, 26 weeks), and the ERP
  outbox has no connector behind it.
- Inventory follows the engine's model: no backorders, unmet demand is lost, and expedited or
  drop-shipped units don't pass through stock.
