# dbt_charts_dive

Turns every [dbt Charts](https://docs.dbtcharts.com/) board in your project into a live
[MotherDuck Dive](https://motherduck.com/docs/dives/) during a normal `dbt build`. One board,
one Dive, updated in place each run.

Written for dbt v2, which runs no Python. So the dbt side is SQL: the hook stages your boards
into MotherDuck, and a [Flight](https://motherduck.com/docs/flights/) compiles them there with
dbt Charts.

## Setup

```yaml
# packages.yml
packages:
  - git: https://github.com/motherduckdb/labs.git
    subdirectory: projects/dbt-charts-dives

# dbt_project.yml
vars:
  save_charts_as_dives: true
```

```bash
dbt deps && dbt build
```

That is the whole setup. You need a MotherDuck target in `profiles.yml`
(`path: "md:my_database"`, database already created). Each run prints where the Dives went:

```
dbt_charts_dive: staged 21 project files + 10 package files (213015 bytes)
dbt_charts_dive: updated dive sales_dashboard -> https://app.motherduck.com/dives/<uuid>
```

## What the hook does

The package brings its own `on-run-end` hook, so your project file only holds the flag. After
your models finish, on dbt's own connection:

- `read_text()` copies the boards, `dbt_charts.yml` and this package's Python into one table.
  The manifest slice dbt Charts needs for `ref()` comes from dbt's in-memory graph, so a fresh
  clone with no `target/` works.
- `MD_CREATE_FLIGHT` / `MD_UPDATE_FLIGHT` keep a Flight named `dbt_charts_dive` current. Its
  program is a 20-line bootstrap that runs the staged code, so the logic lives in one place.
- `MD_RUN_FLIGHT` starts it with the database, the board options, and this run's failed models.
  Boards reading a failed model are skipped.
- `sleep_ms` waits. Success prints a line per Dive; failure fails the build with the Flight's
  traceback.

The Flight installs dbt Charts on MotherDuck compute, compiles each board (dbt Charts' own
Vega-Lite specs, KPI and table styling, layout, fonts) and upserts the Dive. The Dive runs the
board's SQL live and keeps dbt Charts' tooltips, variables, drill-down links, pagination, tabs
and `details:` sections.

## One board, one Dive

A board finds its Dive by the `dbt_charts_dive_registry` table (keyed by the dbt project's
name and the board's path, so retitling keeps the Dive and two projects sharing a database
keep their own), else by the `dbt_charts_dive:` marker this package writes at the end of
every Dive description, which survives a dropped registry. There is no third way: a Dive
this package did not publish carries no marker, and a title is not a name.

Rename or delete a board and its Dive stays — the link may be somebody's bookmark. The run
says which Dives no longer have a board; removing one is your call.

## Options

Which boards to publish, in the `dive:` block of `dbt_charts.yml` (dbt Charts ignores it):

```yaml
dive:
  publish: all              # all | tagged | none
  tag: dive                 # opt-in tag for publish: tagged
  exclude_tag: no-dive      # opt-out tag for publish: all
  include: []               # path globs, e.g. ["charts/exec/**"]
  exclude: []
  all_or_nothing: true      # one board that cannot be built stops the run publishing
  title_prefix: "dbt: "
  dive_width: 880
  vegalite_version: auto    # the Vega-Lite dbt Charts compiled the specs for; pin e.g. "6.4.3"
  required_databases: []    # what the Dive attaches; see sharing below
```

Per board, dbt Charts' `tags:` field decides: `[no-dive]` opts out, `[dive]` opts in. How the
run behaves comes from dbt vars:

```yaml
vars:
  dbt_charts_dive:
    share: true             # publish against a share
    commands: [build, run, seed, snapshot, clone, retry]   # which dbt commands publish
    wait: true              # false returns once the Flight is queued
    timeout: 900
    fail_on_error: true
    flight_name: ...       # defaults to dbt_charts_dive_<program hash>
    options: {}             # overrides for the dive: block
```

Skip a run with `dbt build --vars '{save_charts_as_dives: false}'`.

## Sharing

A Dive attaches your own database by default, so only you can open it. With `share: true` the
run creates or reuses a share and publishes every Dive against it:

```
dbt_charts_dive: created share analytics_share (unrestricted, update manual) -> md:_share/analytics_share/<uuid>
```

No URL is pasted anywhere. The run finds the share by its source database, reuses it when the
settings match, and re-creates it when they changed. A re-create mints a new URL, which the log
says, because Dives published earlier then need a rebuild.

The share updates manually and the run refreshes it at the end, after the staged project is
dropped — and not at all while another run's staged project is still in the database, since
the snapshot would take that too. An automatic share (`share: {update: automatic}`) shows whatever the database holds
at any moment, and during a run that includes the staging table: your boards, your
`dbt_project.yml` and this package's source, to everyone the share reaches.

`access` defaults to `organization`; `unrestricted` makes a Dive link work for anyone. To point
Dives elsewhere, set `required_databases: ["analytics=md:_share/analytics_share/<uuid>"]`, alias
first.

## Things to know

- A board needs a `source:` (dbt Charts requires it). Inside a Flight the value is ignored,
  since the warehouse is always the run's MotherDuck database, but the key has to be there.
- Boards live in `charts/`. Run dbt from the project root: the hook reads local files with
  `read_text()`, so `--project-dir` from elsewhere finds nothing and says so.
- `dbt deps` must install into `dbt_packages/` (the default).
- Only commands that build relations publish: `build`, `run`, `seed`, `snapshot`, `clone`,
  `retry`. `dbt compile` and `dbt test` run the hook too and it does nothing there, since
  nothing was built (`commands: [...]` changes the list). Skip a run entirely with
  `--vars '{save_charts_as_dives: false}'` (a non-MotherDuck target is an error, not a skip).
- Each run's staged project goes into a table named for the run and the hour; a run that
  never finished leaves one behind, and the next run drops it.
- Three small tables appear in your target schema, and in any share of it:
  `dbt_charts_dive_registry` (one row per board), `dbt_charts_dive_runs` (one row per run,
  pruned after 30 days) and `dbt_charts_dive_vega` (the cached Vega runtime — JavaScript
  every viewer of every Dive runs, so a run checks what it reads back before embedding it,
  and whoever can write that schema can already change the models the Dives read). Staging is
  dropped after each run.
- To check what was published: `SELECT title, id FROM MD_LIST_DIVES(limit := 100)`.

## Layout

| path | what it is |
|---|---|
| `dbt_project.yml`, `macros/` | the dbt package: the hook and all the SQL |
| `src/dbt_charts_dive/` | the Python the Flight runs (below) |
| `pyproject.toml` | the same Python as a pip package, for the tests and the `dctmd` CLI only |

| module | what it decides |
|---|---|
| `flight` | the entry point: materialize the staged project, then publish |
| `config` | which boards become Dives, and the `dive:` options |
| `builder` | one board to one Dive: open it, compile it, write the manifest |
| `sql` | the statement a Dive sends for a board query |
| `presentation` | what a KPI card, a table and the board itself look like |
| `specs` | the Vega-Lite a Dive renders, against rows it has yet to fetch |
| `variables` | what a control does: one SQL per combination, and the slots a viewer fills |
| `bundle` | the Vega runtime the Dive embeds |
| `publisher` | which Dive a board owns, and the upsert |

Copy this directory into another repo, add it to `packages.yml`, set the flag. `dctmd` is `dct`
with MotherDuck paths patched in, for authoring boards locally.

## Chart types

Every family dbt Charts offers, and what a Dive does with it. "Live" means the card is drawn
from the rows the Dive fetched when it opened — `tests/test_chart_types.py` renders
each one twice, with the numbers moved underneath it, so this table cannot quietly go stale.

| type | in a Dive |
|---|---|
| bar, line, area, scatter, heatmap, histogram | live |
| pie, donut | live, the percentages in the slice labels included |
| table, kpi | live; the Dive draws these itself from dbt Charts' resolved style |
| point_map, bubble_map | live |
| geoshape, map | live, with the TopoJSON carried in the Dive rather than fetched |
| spark_bar | live; the Dive draws it itself, like the KPI and the table |
| callout | static — dbt Charts ignores the rows for a callout too |

**What dbt Charts draws by hand.** `kpi`, `table`, `spark_bar` and the six in-cell
sparklines a table column can carry (`line`, `area`, `bar`, `bar-normalize`, `column`,
`columns`) have no Vega-Lite spec: `render/chart/*.py` writes their SVG directly, against the
rows dbt Charts queried at build time. Shipping that SVG would render something, but it would
be build-time data wearing a live card's face — so the compiler puts dbt Charts' *resolved
style* in the manifest (geometry, format plan, the theme's spark tokens) and `template.tsx`
follows the same renderer, step for step, over the rows the browser fetched.
`tests/test_spark_bar.py` (25 cards) and `tests/test_spark_cells.py` hold the
two outputs against each other primitive by primitive — every rect, point and label.

Three things about an in-cell mark cannot be, or are deliberately not, ported exactly.

- **Its width.** dbt Charts sizes a mark from the lane it landed in, which its own layout pass
  measured; a Dive's table is laid out by the browser, so the Dive measures the cell there and
  applies the same rule (`width - 16`, capped at `width - 8`; `column` keeps the narrow theme
  width). Until it has measured — the first paint, or a headless render that never lays
  anything out — it draws at dbt Charts' unsized defaults (80, or 100 for a bar). An authored
  `spark: {width: N}` sidesteps the question.
- **A null inside a series.** `[1, null, 3]` reaches `math.isfinite(None)` and takes the whole
  board's render down. The Dive skips that member and draws the rest — a board that renders
  is worth more than a board that reproduces a crash.
- **Summary rows.** dbt Charts excludes a `row_role` summary or total row from a `bar`
  column's ceiling and from its midline decision. A Dive does not carry row roles at all (it
  does not style those rows either), so a summary row counts like any other. Give such a
  column an explicit `spark: {max: N}` and the ceiling stops depending on it.

## Limits

- dbt v2 or dbt-core 1.8+, MotherDuck target. The Flight runs as your MotherDuck user and only
  its owner can run it, so a shared project should set `flight_name` to a service account's.
- The Flight needs PyPI for dbt Charts and jsDelivr for the Vega runtime, cached per version.
- dbt Charts is pinned to an exact version: the Dive is built out of ~26 of its private
  functions and `md_compat.py` patches four more, so a moved name is a different Dive, not
  an import error.
- Boards with inline `values:` data ship as snapshots. The rest query live.

## Tests

`tests/` compiles every board, runs its SQL on MotherDuck, renders the Dive in jsdom and
Chromium, and compares against dbt Charts' own output.
