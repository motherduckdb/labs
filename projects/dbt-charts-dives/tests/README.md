# End-to-end tests: dbt Charts board to MotherDuck Dive

Each test compiles a board the way the dbt hook does, runs the board's SQL live on MotherDuck,
renders the generated Dive (jsdom, or headless Chromium with the real Vega bundle), then checks
the result against dbt Charts' own output for the same board: its JSON render, its SVG and PNG
export at the Dive's width, and its formatting functions.

## Run

The suite measures itself against dbt Charts' own renders of dbt Charts' own example boards,
so it needs that project checked out. `harness.py` names the twelve boards it expects under
`charts/` (see `BOARDS`); point `DCD_PROJECT_DIR` at the copy you want tested.

```bash
git clone https://github.com/dbt-labs/dbt-charts            # once, for its examples/tutorial_dbt
cd dbt-charts/examples/tutorial_dbt
python -m venv .venv && .venv/bin/pip install -e /path/to/labs/projects/dbt-charts-dives
.venv/bin/pip install dbt-duckdb pytest playwright pillow

cd /path/to/labs/projects/dbt-charts-dives/tests && npm install && npx playwright install chromium

DCD_PROJECT_DIR=/path/to/dbt-charts/examples/tutorial_dbt \
DBT_PROFILES_DIR=/path/to/dbt-charts/examples/tutorial_dbt \
  /path/to/dbt-charts/examples/tutorial_dbt/.venv/bin/python -m pytest . -v
```

- `motherduck_token` must be in the environment: the tests run the boards' SQL for real.
- `DCD_E2E_BROWSER=0` skips the Chromium tests (about half the suite, and the slower half).
- Boards are parametrized, so `-k customer_analytics` runs one board.
- `-s` prints layout height deltas and SSIM scores.

## Files

| file | role |
|---|---|
| `test_e2e.py` | rows, formatting, layout, fonts, pixels |
| `test_interactivity.py` | the six dbt Charts interactions |
| `test_publish_identity.py` | how a board finds the Dive it already owns |
| `test_bundle.py` | the Vega runtime matches dbt Charts and honors a pinned version |
| `harness.py` | compile, live SQL, both renderers, dbt Charts oracles, layout walk; cached per session |
| `run_dive.mjs` | esbuild plus jsdom; prints a DOM report |
| `run_dive_browser.mjs` | esbuild plus Playwright; real Vega, screenshots, scripted hovers and clicks |
| `mock-md-sql.js`, `mock-lucide.js` | stand-ins for the Dive runtime's two imports |
| `imgcompare.py` | SSIM and normalized difference between two renders |
| `test_spark_bar.py` | the spark bar the Dive draws itself, primitive by primitive against dbt Charts' own SVG |
| `test_chart_types.py` | every chart type dbt Charts offers, and whether its card redraws when the rows change |
| `render_spec.mjs` | one spec rendered against two sets of rows with the Dive's own bundle |
| `fixtures/*.yml` | synthetic boards, copied into the project for the session; each carries `tags: [no-dive]` so an overlapping `dbt build` cannot publish them |

## Interactivity

dbt Charts has six interactions, and the Dive keeps all six. Each is compiled at build time
(`builder.py`, `variables.py`) and applied in the browser (`template.tsx`), checked against
dbt Charts' own SVG or resolved values:

| interaction | how it survives | oracle |
|---|---|---|
| hover tooltips | the `description` expression dbt Charts already puts in the spec | the `aria-label` in its SVG |
| variables | one pre-rendered SQL per value combination, capped at 64, bound to `useDiveState` | `render_board(variables=…)` rows |
| drill-down links | dbt Charts' `encoding.href`, plus its `resolve_cell_link` ported for tables and KPIs | the anchors in its SVG |
| pagination | `page_rows` and the grow-by-2 rule, page held in Dive state | its SVG text and rules |
| tabs | its tab variable and slugs | its SVG (only the default tab draws) |
| details | its hidden details variable | its SVG summary bar |

Variables fall back to the board defaults, with a note beside the controls, when a query has
more than 64 value combinations, when Jinja branches on a free input's value, or when option
lists come from a query (those are evaluated once at compile time).

## Known deviations, measured

- Gap fill: dbt Charts adds missing time buckets before stacking. The Dive stacks the rows
  the SQL returns. Bucket values are canonicalized and sorted the same way; the fill is not.
- Slot heights: dbt Charts reports a table card's content height, the manifest keeps the
  sizing-pass slot. They agree within 3px unless a taller sibling stretches the row.
- Pixels: per-card SSIM against dbt Charts' PNG at 880px runs KPI 0.97 to 0.995, Vega
  charts 0.91 to 0.997, pies 0.80 to 0.85, tables 0.33 to 0.60 (HTML columns versus measured
  lanes). Board means land 0.89 to 0.997. Floors: KPI 0.9, Vega 0.75, table 0.3, board 0.8.
- Not compared: dbt Charts' footer, which the Dive omits; the pixels of the variables bar,
  though its controls, values and labels are checked; vertical spacing between cards.
