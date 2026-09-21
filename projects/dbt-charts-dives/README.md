# dbt-charts-dives

Every [dbt Charts](https://docs.dbtcharts.com/) board in your project becomes a live
[MotherDuck Dive](https://motherduck.com/docs/dives/) during an ordinary `dbt build`. One
board, one Dive, updated in place on every run. The Dive runs the board's SQL in the
viewer's browser, so it shows current data rather than a snapshot from build time.

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

That is all of it. You need a MotherDuck target in `profiles.yml` (`type: duckdb`,
`path: "md:my_database"`, and the database already created) and `motherduck_token` in the
environment. Each run tells you where the Dives went:

```
dbt_charts_dive: staged 21 project files + 10 package files (213015 bytes)
dbt_charts_dive: updated dive sales_dashboard -> https://app.motherduck.com/dives/<uuid>
```

dbt v2 runs no Python, so the dbt side of this is all SQL. An `on-run-end` hook copies your
boards into MotherDuck and a [Flight](https://motherduck.com/docs/flights/) compiles them
there with dbt Charts. Nothing to install locally beyond `dbt deps`.

## Options

All optional, under `vars:` in `dbt_project.yml`:

```yaml
vars:
  save_charts_as_dives: true
  dbt_charts_dive:
    commands: [build, run]     # which dbt commands publish; default build/run/seed/snapshot
    all_or_nothing: false      # true: one bad board fails the run instead of being skipped
    project: my_project        # the registry key, if two projects share one database
    recreate: false            # true: rebuild the share (changes its URL)
```

Board-level settings live in `dbt_charts.yml` under `dive:`, next to your other dbt Charts
config.

## What renders

All sixteen of dbt Charts' chart families draw, and fifteen of them read live rows: bar,
line, area, scatter, heatmap, histogram, pie, donut, point and bubble maps, choropleths,
tables, KPIs and spark bars. The sixteenth is `callout`, which is static here because dbt
Charts ignores the rows for a callout too.

The interactions come along: tooltips, variable controls, drill-down links, pagination,
tabs, and collapsible `details:` sections.

## Limitations

- dbt v2 or dbt-core 1.8+, and a MotherDuck target. The Flight runs as your MotherDuck
  user and only its owner can run it, so set `flight_name` to a service account's for a
  shared project.
- dbt Charts is pinned to an exact version, 0.8.0. The compiler borrows about 26 of its
  private functions, so a renamed one is a quietly different Dive rather than an import
  error.
- The Flight needs network access, for dbt Charts on PyPI and the Vega runtime on
  jsDelivr. Both are cached per version.
- Boards with inline `values:` data ship as snapshots. There is no SQL to re-run, so
  those rows are whatever the build saw. Everything else queries live.
- A table lays out its own columns. Every cell matches dbt Charts' formatter, but the
  browser distributes the width, so lane boundaries land elsewhere than in dbt Charts' SVG.

## Internals and tests

`docs/internals.md` explains the hook, the Flight and the compiler, says which chart types
are live and how that is checked, and lists where a Dive deliberately differs from dbt
Charts. `tests/` compiles every board, runs its SQL on MotherDuck, renders the Dive in jsdom
and in Chromium, then compares the result against dbt Charts' own render of the same board.

## License

Apache 2.0, matching dbt Charts, whose internals this builds on. See `LICENSE`.
