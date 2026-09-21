# Changelog

## 0.2.0 — unreleased

Rebuilt for **dbt v2**, which runs no Python: publishing now happens on MotherDuck compute.

- One flag is the whole setup: `vars: {save_charts_as_dives: true}`, plus this package in
  `packages.yml`. No hook to paste, no Flight to create, no ids, no local Python.
- This is a dbt package again: it ships its own `on-run-end` hook, so the consuming project's
  `dbt_project.yml` only carries the flag.
- The hook is SQL: `read_text()` stages the boards, the config and this package's own Python
  into MotherDuck; `MD_CREATE_FLIGHT`/`MD_UPDATE_FLIGHT` keep a Flight named `dbt_charts_dive`
  current; `MD_RUN_FLIGHT` triggers it; `sleep_ms` waits for it; a failure fails the build with
  the Flight's traceback.
- The manifest slice dbt Charts needs for `ref()` is synthesized from dbt's in-memory graph,
  so a fresh clone with no `target/` works and boards never resolve against a stale artifact.
- Dive titles are prefixed `dbt: ` (`dive.title_prefix`) so dbt-managed Dives are obvious
  in the Dive list.
- One board keeps one Dive: found by the registry table, else by the `dbt_charts_dive:` marker
  written into every description, else by an unambiguous title.
- Retired the dbt-duckdb plugin, the SQL UDFs and the `numpy` dependency; the pip install is
  now only for the test suite and the `dctmd` authoring CLI.

## 0.1.0 — unreleased

First working version (dbt-core 1.x).

- dbt-duckdb plugin exposing dbt Charts' compiler as SQL functions.
- One Dive per board at `on-run-end`; `dive:` block in `dbt_charts.yml`; `--vars` override.
- Compile step takes layout, KPI/table presentation, formats, fonts and titles from dbt Charts
  itself; the Dive runs the SQL live and renders dbt Charts' Vega-Lite specs.
- Retains dbt Charts' interactivity: tooltips, variables, drill-down links, pagination, tabs,
  details sections.
- Vega runtime built at compile time to match dbt Charts (`dive.vegalite_version` to pin).
- End-to-end test suite (jsdom + Chromium) comparing against dbt Charts' own output.
