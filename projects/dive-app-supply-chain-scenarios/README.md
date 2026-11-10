# Supply chain scenario modeling (a Dive App with writeback)

A supply planning app built entirely on MotherDuck: a **Dive** is the UI, and a **Flight** saves
every change. Planners model what happens when demand outruns planned supply, and whether
it's worth paying to close the gap. They can edit weekly demand and planned receipts cell by
cell in a real spreadsheet, compare scenarios, and push one through **draft → submitted → approved**.
Approval writes the plan to a table. "Push to ERP" queues the order lines it implies in an
outbox for downstream systems.

The question each scenario answers is **"is it worth it?"** Each scenario is also computed with
every lever off (same demand, same supply, same grid edits). The headline KPI is the net margin impact between
the two. Then come demand met, recovered revenue and the extra cost per recovered unit.

The levers:

| Lever | What it does | Cost |
|---|---|---|
| Expedited shipping, 5-day / 3-day | Wins back 35% / 55% of a shortfall, capped at a share of weekly receipts | $1.50 / $3.25 per unit |
| Expedited shipping, 1-day (air) | Wins back 85%, but costs more than most categories earn per unit. **On its own it loses money.** | $55 per unit |
| Drop ship supplier → customer | Ships part of what's still short straight to the customer; keeps 92% of those customers | $14 per unit |
| Subcontract manufacturer | Extra weekly capacity at a unit-cost premium; excess stock pays holding cost | premium % of unit cost |

Demand comes from the baseline forecast, or from an approved plan of an upstream demand
planner. A "demand vs forecast" slider adds a stress-test upside on top. A week edited in the
grid replaces that number outright.

## What's in the Dive

- **Title row:** a Baseline tab and the scenario picker. The picker shows the current scenario
  with rename, duplicate and delete icons; its menu lists every scenario with the same icons
  (rename in place, delete asks to confirm), then "New scenario from Baseline". The save state and the workflow actions sit on
  the right: Submit for approval, Send back / Approve, then Push to ERP / Reopen.
- **Filters** (region and category multi-selects) narrow the KPIs, the chart and the grid.
- **Supply levers:** the drivers above. The plan recomputes instantly in the browser and saves
  about 600 ms after you stop moving a control.
  - **Optimize** (the wand button under the title) sets the expedite speed and capacity, the drop
    ship share and the subcontract capacity to the highest net margin for the scenario as it
    stands: demand source, demand vs forecast, subcontract premium and every grid edit are the
    inputs. It tries every setting the controls allow (4 speeds × 1–50% capacity, drop ship
    0–100% in 5s, subcontract 0–40%: 130,011 settings), so the answer is exact. That takes about
    0.2 s in the browser: the region × category cells are independent in the engine, so the search
    evaluates each cell with nested loops that reuse work, using the engine's own lever functions
    (`dive/src/optimizer.ts`). The winner is re-run through the engine, and those are the numbers
    shown.
  - **Auto-optimize** (the switch beside it) keeps those levers optimized. It reruns whenever
    demand, the premium or the grid changes. The levers it sets are locked and marked with the
    wand. The setting is saved with the scenario (`drivers.auto_optimize`), so everyone sees it.
- **Weekly chart:** demand, supply and end-of-week inventory lines, over bars showing how demand
  was met (from stock, expedited, drop shipped, lost); the legend is below it.
- **Supply and Demand Edits** (a [Univer](https://univer.ai) spreadsheet): Demand, Supply and
  Inventory rows per region × category, each tinted to match its chart series. The Metric,
  Region and Category headers have filter dropdowns (the pivot Dive's drilldown-table dropdown:
  search, All / None, checkboxes); Region and Category share their state with the Filters panel. The page is one
  window tall with no page scrolling: the grid takes the height left under the chart, and the
  Supply levers pane stretches to end on the same line (it scrolls inside itself in short windows).
  Presentation mode, maximized, gives the grid the most rows.
  - **Demand** and **Supply** are editable, the same way (in a draft; the Baseline and submitted
    or approved scenarios are locked). Type, paste or enter a formula to override a week, or
    delete to revert. An override is that week's number in units: a Demand override replaces
    source × (1 + upside), a Supply override the planned receipts. The no-action plan uses the
    same overrides.
  - **Inventory** is a live formula on the rows above it:
    `=MAX(0, previous week + supply [+ subcontract units] − demand)`. It's locked: you can open a
    cell to see which cells feed it, but any change is put back.
  - **Overrides:** ones made in this session show a stronger yellow than ones saved earlier.
    Hovering an override shows who made it and when. The Supply levers pane counts them by
    metric, with a Clear button.
  - **Sorting:** click any header (Metric, Region, Category, On hand, a week, 26-wk total) to
    sort, as in the pivot Dive's drilldown table: each click cycles that column descending →
    ascending → off, and a newly sorted column joins the end of the sort list (the green
    triangle shows the direction and the column's priority). Sorting moves individual rows (the
    grid is a flat table: sort by Metric first to keep Demand, Supply and Inventory apart); ties
    keep the original order, blanks sort last, the total rows stay at the bottom. The sort is
    kept in the Dive state, so it survives a scenario or filter change and a reload. It is a
    view only: it never saves anything. The rows re-sort when you change the sort or the Metric
    filter, move a lever, switch scenario or filter, or reload, but not when you edit a cell:
    an edited row stays where it is (under your cursor) until one of those happens.
  - **Filters and edits:** the rows a Metric filter hides move below the total rows, so the
    rows you see are one block: a paste fills the visible rows in order, and a fill or a
    Delete over a range only changes visible cells (anything reaching a hidden row is put back
    and not saved). A pasted or filled cell keeps the grid's format, and a formula is kept as
    the number it gives. Changing a filter or the scenario right after an edit (even with the
    cell editor still open) saves the edit first. Undo and redo (Cmd/Ctrl+Z, Cmd/Ctrl+Y) cover
    your grid edits, one step each; an undo back to a week's own number clears its override.
    Re-sorting, the Metric filter and lever changes start a fresh undo history.
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
| `supply` | `scenarios`, `scenario_overrides` (grid edits), `activity_log`, `approved_plan` (approved supply plans), `erp_orders` (the ERP outbox; no ERP is connected), `rpc_results` |

`supply.scenario_overrides` has one row per scenario × `metric` × region × category × week
(`scenario_id, region, category, week_idx, units, edited_by, edited_at, metric`). `metric` is
`'supply'` (planned receipts) or `'demand'`; it was added after the table, so
`Store.ensure_schema` adds it with `ALTER TABLE … ADD COLUMN IF NOT EXISTS … DEFAULT 'supply'`
(older rows are supply overrides), and every INSERT names its columns. The `set_overrides` op
takes `{metric, region, category, week_idx, units}` per change (`metric` defaults to `'supply'`;
`units: null` clears one).

## Layout

| Path | What it is |
|---|---|
| `dive/src/dive.tsx` | The Dive: scenario picker, filters, levers, KPIs, chart, Compare and Activity |
| `dive/src/GridFilterDropdown.tsx` | The grid's header filter dropdown, adapted from the pivot Dive's drilldown table |
| `dive/src/GridSort.tsx` | The grid's multi-column sort (cycle and indicator from the pivot Dive's drilldown table) |
| `dive/src/gridLayout.ts` | The grid's row-order model: which sheet row holds which region × category and metric, sorting, and the inventory and total formulas |
| `dive/src/SupplyGrid.tsx` | The Supply and Demand Edits grid (Univer): one edit path for Demand and Supply, formulas, locking, edit colours and tooltips |
| `dive/src/engine.ts` | The supply planning engine (browser) |
| `dive/src/optimizer.ts` | Optimize / Auto-optimize: the levers with the highest net margin, by trying every setting |
| `dive/src/flight-backend.ts` | Writes through the Flight, and the one-statement bootstrap read |
| `dive/src/univer-runtime.ts` | Loads Univer inside the Dive sandbox (inlined UMD bundles; no dynamic imports) |
| `dive/scripts/` | `fetch-vendor.sh` + `build-vendor.mjs` (pack Univer), `build-dive.mjs` (bundle), `deploy-dive.sh` (create/update the Dive) |
| `flight/planner.py` | The backend: `Store` (schema, seeds) and `Api` (every write op) |
| `flight/supply_engine.py` | Python port of `engine.ts`, used on approval: the stored plan never depends on numbers sent by the browser |
| `flight/write_flight.py`, `flight/build_flight.py` | The Flight entrypoint, and the build that inlines the engine and backend into one file |
| `flight/setup.py` | Sets up an organization: service account, database, share, Flight, grants |
| `flight/static.sql` | The synthetic planning data |
| `e2e/` | `engine-parity.test.mjs` (TS and Python engines agree on every cell), `flight_smoke_test.py` (every op on a local DuckDB file), `grid-layout.test.mjs` (the grid's row mapping and formulas in every sort and metric filter), `optimizer.test.mjs` (the optimizer's numbers are the engine's; it finds the brute-force optimum) |

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
node e2e/optimizer.test.mjs                                              # optimizer vs the engine and a brute force
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
