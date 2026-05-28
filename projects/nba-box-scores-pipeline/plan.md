# nba-box-scores migration plan

Migrate the [`nba-box-scores`](https://github.com/matsonj/nba-box-scores) project from a TypeScript pipeline (GitHub Actions) + Next.js app (Vercel) to a MotherDuck-native architecture: Python **Flights** for ingest, a single **Dive** for the UI.

## Goal

Eliminate the GitHub Actions + Vercel surface area. Land the data and the UI in MotherDuck so the schedule, the compute, and the rendering live in one place. Use the labs repo to develop the Python pipeline; the Dive lives in its own repo per the [Dives-as-code](https://motherduck.com/docs/key-tasks/ai-and-motherduck/dives/managing-dives-as-code/) starter.

## Current state

### Pipeline — `~/code/nba-box-scores/nba-box-scores/scripts/ingest/` (TS, ~1700 LoC)

| Module | Lines | Role |
|---|---|---|
| `index.ts` | 130 | CLI entry; argument parsing, orchestration |
| `config.ts` | 211 | Season selection, env validation, defaults |
| `types.ts` | 130 | Shared types |
| `api/client.ts` | 120 | NBA stats.nba.com client |
| `api/rate-limiter.ts` | 137 | Adaptive throttle (back off on 429s) |
| `parse/box-score-parser.ts` | 229 | NBA box-score → typed rows |
| `parse/season-utils.ts` | 95 | Season-year math |
| `db/connection.ts` | 59 | MotherDuck connection wrapper |
| `db/schema.ts` | 251 | Bootstrap tables |
| `db/loader.ts` | 177 | Upsert raw + hydrated tables |
| `db/hydration-sql.ts` | 174 | Raw → hydrated SQL |
| `db/queries.ts` | 80 | Status queries |
| `db/metadata.ts` | 40 | Refresh `metadata_generator` comments |
| `workers/pool.ts` | 65 | Season-level concurrency |
| `workers/season-worker.ts` | 284 | Per-season ingestion driver |
| `nhl/` | (parallel structure) | NHL pipeline |
| `backfill-raw.ts` | 91 | Historical-season backfill |
| `hydrate.ts` | 126 | Standalone re-hydrate |
| `status.ts` | 206 | Ingest status reporter |
| `data-quality/check.ts` | — | DQ checks |
| `data-quality/github-issues.ts` | — | Post DQ failures as GH issues |

Driven by two workflows in `.github/workflows/`:
- `nightly-sync.yml` — `0 16 * * *` UTC; runs `ingest:current`, `ingest:current:playoffs`, NHL equivalents
- `backfill.yml` — `workflow_dispatch` with season-range inputs

### Frontend — `~/code/nba-box-scores/nba-box-scores/app/` + `components/` (Next.js 16, React 19, Vercel)

| Surface | Key files |
|---|---|
| Main dashboard | `app/page.tsx` (NBA), `app/nhl/page.tsx` |
| Schedule grid | `components/GameDateGrid.tsx` |
| Live games | `components/LiveGamesSection.tsx` |
| Box score panel | `components/BoxScorePanel.tsx` |
| Season filter | `components/SeasonFilter.tsx` |
| Charts | `app/scatter-plot/`, `app/charts/` (recharts) |
| Dynamic stats explorer | `app/dynamic-stats/`, `components/DynamicTableLoader.tsx` |
| Data fetching | `hooks/useGameData.ts` (probably `@motherduck/wasm-client`) |
| Sport switcher | `hooks/useSportPage.ts` |

### Backend

- MotherDuck database `nba_box_scores_v2` (edit access confirmed via probe). Will continue to serve the legacy Vercel app indefinitely.
- New target: `nba_box_scores_v3` — bootstrapped from a one-shot `CREATE DATABASE ... AS COPY OF nba_box_scores_v2` (see Phase 0). All Flights write to v3 only; the Dive reads only v3.
- Local `nba_stats.duckdb` is a dev cache; not part of production.

## Target architecture

| Concern | From | To |
|---|---|---|
| Database | `nba_box_scores_v2` (legacy, keeps serving Vercel) | `nba_box_scores_v3` (new, serves Flights + Dive) |
| Ingest scheduling | GitHub Actions cron | `MD_CREATE_FLIGHT(schedule_cron := '0 16 * * *')` |
| Ingest runtime | Node 22 in Actions runner | Python 3.12 in Flight runtime |
| Ingest auth | `MOTHERDUCK_TOKEN` Actions secret | Injected by Flight via `access_token_name` |
| Backfill | `workflow_dispatch` | One-shot v2→v3 copy in Phase 0; future re-runs via `MD_RUN_FLIGHT` |
| UI hosting | Vercel (stays on v2 indefinitely) | MotherDuck Dive on v3 |
| UI data fetching | `@motherduck/wasm-client` + hooks | `useSQLQuery` against v3 views |
| UI source of truth | `nba-box-scores` repo on Vercel | Separate Dive repo, deployed via `MD_CREATE_DIVE` |
| Logging | Stderr from Node | `controllog` library (consistency with other labs Python projects) → stdout captured by `MD_FLIGHT_LOGS` |
| Health monitoring | GH Actions email on failure | Weekly health Flight querying `MD_FLIGHT_RUNS` for failures |
| Data quality alerts | GH Issues | Dropped for now; revisit |

## Phase 0 — Pre-flight (manual, one-shot)

Run these once, before any code lands. None require the labs project to exist yet.

1. **Clone v2 into v3.** From a DuckDB CLI authenticated to your MotherDuck account:
   ```sql
   CREATE DATABASE nba_box_scores_v3 FROM nba_box_scores_v2;
   ```
   Confirms parity row counts, then we never touch v2 from this project again. v2 keeps serving the old Vercel app.

2. **Provision the access token.** In the MotherDuck UI, create a token named `labs_ingest_token` (or whatever; capture the name) with read+write on `nba_box_scores_v3`. Confirm it's visible via `SELECT * FROM md_access_tokens()`. Every Flight will reference it by name in `MD_CREATE_FLIGHT(access_token_name := ...)`.

3. **Decide logging.** Default: use `controllog` (the labs project) inside Flights, route to stdout — Flight runtime captures stdout and exposes it via `MD_FLIGHT_LOGS`. Same telemetry shape as the other labs Python projects, no extra infra.

## Phase 1 — Pipeline → Flights

Repo home: `~/code/labs/projects/nba-box-scores-pipeline/`.

### 1.1 Scaffold

Mirror other labs Python projects (controllog, bird-bench, etc.):

```
projects/nba-box-scores-pipeline/
├── README.md
├── pyproject.toml          # uv-managed
├── src/
│   └── nba_box_scores_pipeline/
│       ├── __init__.py
│       ├── config.py
│       ├── rate_limiter.py
│       ├── api/
│       │   ├── __init__.py
│       │   ├── nba.py
│       │   └── nhl.py
│       ├── parsers/
│       │   ├── __init__.py
│       │   ├── nba_box_score.py
│       │   └── nhl_box_score.py
│       ├── db/
│       │   ├── __init__.py
│       │   ├── connection.py
│       │   ├── schema.py
│       │   ├── loader.py
│       │   └── hydration_sql.py
│       └── workers/
│           ├── __init__.py
│           └── season_worker.py
├── flights/                # One folder per Flight, mirroring blessed-dives' `dives/<name>/`
│   ├── nba_nightly/
│   │   ├── flight.toml     # name, schedule_cron, access_token_name, config keys
│   │   ├── main.py         # def main(): from package import nightly; nightly.run("nba")
│   │   └── CLAUDE.md       # optional per-flight context
│   ├── nhl_nightly/...
│   ├── nba_backfill/       # schedule_cron = null; run via MD_RUN_FLIGHT
│   └── nhl_backfill/...
├── build.py                # Validate each flight has main.py + flight.toml; render source_code/requirements
├── deploy.py               # MD_CREATE_FLIGHT / MD_UPDATE_FLIGHT / MD_DELETE_FLIGHT via duckdb client
├── flight_schema.py        # pydantic schema for flight.toml
├── .github/workflows/
│   ├── deploy_flights.yaml      # PR → preview, merge → prod, single workflow gates both
│   └── cleanup_preview_flights.yaml  # Branch delete → MD_DELETE_FLIGHT for preview
└── tests/
    └── test_parsers.py
```

The `flights/<name>/main.py` files are thin: they `from nba_box_scores_pipeline.flights.<name> import main` and define `def main(): ...`. The Flight runtime installs `nba_box_scores_pipeline` via `requirements_txt` set to `git+https://github.com/motherduckdb/labs.git@<sha>#subdirectory=projects/nba-box-scores-pipeline`. The SHA is computed by `deploy.py` from the current GH ref so prod ↔ main and previews ↔ PR branch.

### 1.2 File-by-file port mapping

| From (TS) | To (Python) | Notes |
|---|---|---|
| `scripts/ingest/config.ts` | `config.py` | Use `pydantic` or `dataclasses` + `argparse`. Read `MOTHERDUCK_TOKEN` from env (Flight runtime injects it). |
| `scripts/ingest/api/rate-limiter.ts` | `rate_limiter.py` | Adaptive throttle; `httpx` retries on 429 with backoff. |
| `scripts/ingest/api/client.ts` | `api/nba.py` | `httpx.Client` with headers, session reuse. |
| `scripts/ingest/nhl/` | `api/nhl.py` + parser | Same shape, NHL endpoints. |
| `scripts/ingest/parse/box-score-parser.ts` | `parsers/nba_box_score.py` | Dataclasses for rows; mirror current column shape. |
| `scripts/ingest/parse/season-utils.ts` | `config.py::season_year_for_date` | Small helper, inline. |
| `scripts/ingest/db/connection.ts` | `db/connection.py` | `duckdb.connect("md:")` — token comes from `MOTHERDUCK_TOKEN` env. |
| `scripts/ingest/db/schema.ts` | `db/schema.py` | Same DDL; idempotent `CREATE TABLE IF NOT EXISTS`. |
| `scripts/ingest/db/loader.ts` | `db/loader.py` | Bulk insert via parameterized `INSERT … SELECT` or `pyarrow` round-trip. **Must preserve idempotency** — same `game_id` re-loaded should be a no-op or upsert, never a duplicate row. Failed Flight retries will hit this path. |
| `scripts/ingest/db/queries.ts` + `status.ts` | `db/status.py` | "Which games are already raw/hydrated" check — drives the skip-on-retry path in §1.6. |
| `scripts/ingest/db/hydration-sql.ts` | `db/hydration_sql.py` | Verbatim SQL strings. |
| `scripts/ingest/workers/season-worker.ts` | `workers/season_worker.py` | Linear loop; no `worker_threads` equivalent needed for nightly. |
| `scripts/ingest/workers/pool.ts` | — | Drop. Each Flight run is one process; backfills run via separate `MD_RUN_FLIGHT` calls if needed. |
| `scripts/ingest/index.ts` | `flights/flight_nba_nightly.py` + `flight_nba_backfill.py` | Two entrypoints with `def main()`. |
| `scripts/data-quality/` | — | Out of scope for cut-over; revisit. |

### 1.3 Flight manifest

Each `flights/<name>/flight.toml`:

```toml
[flight]
name = "nba_nightly"
description = "NBA current-season ingest. Mirrors the old GH Actions nightly-sync."
access_token_name = "labs_ingest_token"     # listed via SELECT * FROM md_access_tokens()
schedule_cron = "0 16 * * *"                # null/missing = on-demand only
extra_requirements = ["httpx==0.27.0"]      # appended after the labs git URL
config = { SPORT = "nba" }                   # optional non-secret env passed to main()
```

`flight_schema.py` (pydantic) validates this on every build, mirroring the zod validation blessed-dives does for `package.json`.

### 1.4 Deploy pattern (lifted from blessed-dives, retargeted at Flights SQL)

`deploy.py` is the analog of `deploy.ts`. It uses **only the SQL functions from the [Flights docs PR](https://github.com/motherduckdb/motherduck-docs/pull/1633)** — no private APIs.

| blessed-dives call | Flights equivalent |
|---|---|
| `MD_LIST_DIVES()` to find by title | `MD_FLIGHTS()` to find by name |
| `MD_CREATE_DIVE(...)` | `MD_CREATE_FLIGHT(name, access_token_name, source_code, schedule_cron, requirements_txt, config, flight_secret_names)` |
| `MD_UPDATE_DIVE_CONTENT(id, content, ...)` + `MD_UPDATE_DIVE_METADATA(id, title, description)` | `MD_UPDATE_FLIGHT(flight_id, source_code, requirements_txt, schedule_cron, config, ...)` |
| `MD_DELETE_DIVE` (cleanup) | `MD_DELETE_FLIGHT(flight_id)` |
| Preview = `<title>:<branch> (Preview)` | Preview Flight `name := '<name>__pr_<branch>'` with `schedule_cron := NULL` |
| Output `https://app.motherduck.com/dives/<id>` | Output `https://app.motherduck.com/flights/<id>` (confirm exact URL format from the docs PR) |

Connect via `duckdb.connect("md:", config={"motherduck_token": os.environ["motherduck_token"]})` — same env-var contract blessed-dives uses.

Concrete shape of `deploy.py` calls:

```python
# Prod: upsert by name, set the cron from flight.toml
existing = con.execute("SELECT flight_id FROM MD_FLIGHTS() WHERE name = ?", [manifest.name]).fetchone()
if existing:
    con.execute("""
        SELECT * FROM MD_UPDATE_FLIGHT(
            flight_id := ?::UUID,
            source_code := ?,
            requirements_txt := ?,
            schedule_cron := ?,
            config := ?
        )
    """, [existing[0], source, requirements, manifest.schedule_cron, manifest.config])
else:
    con.execute("""
        SELECT flight_id FROM MD_CREATE_FLIGHT(
            name := ?,
            access_token_name := ?,
            source_code := ?,
            requirements_txt := ?,
            schedule_cron := ?,
            config := ?
        )
    """, [manifest.name, manifest.access_token_name, source, requirements, manifest.schedule_cron, manifest.config])
```

Previews drop `schedule_cron` (always on-demand) and suffix the name with `__pr_<branch>` so they don't collide with prod or with each other.

### 1.5 CI flow (mirrors `blessed-dives/.github/workflows/deploy_dives.yaml`)

```
.github/workflows/deploy_flights.yaml
├── compute_changes   # dorny/paths-filter — flights/<name>/** → per-flight outputs
├── deploy            # ref == 'refs/heads/main' && changed → upsert prod flight, comment URL on merged PR
└── deploy-preview    # pull_request && changed → create preview flight, comment URL on PR
```

```
.github/workflows/cleanup_preview_flights.yaml
└── on: delete (branch) → deploy.py cleanup <branch> → MD_DELETE_FLIGHT for every <name>__pr_<branch>
```

Two GH Actions secrets, matching the blessed-dives split:

| Secret | Used by | Account |
|---|---|---|
| `FLIGHTS_MOTHERDUCK_TOKEN` | merge-to-main | prod service account |
| `FLIGHTS_DEV_MOTHERDUCK_TOKEN` | PR previews + cleanup | dev workspace |

Both workflows run `python -m nba_box_scores_pipeline.deploy <subcommand> "$CHANGED_FLIGHTS" [branch]` — same `deploy/preview/cleanup` subcommand shape as `deploy.ts`.

### 1.6 Validation

Local-first: each `flights/<name>/main.py` must be runnable as `python flights/<name>/main.py` with a real `MOTHERDUCK_TOKEN`. This is non-negotiable — debugging inside the Flight runtime is harder.

After local validation:
- PR opens → CI auto-creates `<name>__pr_<branch>` preview Flight with `schedule_cron := NULL`
- Manually trigger via `SELECT * FROM MD_RUN_FLIGHT(flight_id := '<preview_id>')`
- Inspect via `SELECT * FROM MD_FLIGHT_LOGS(flight_id := '<preview_id>', run_id := ...)`
- Spot-check row counts vs the last GH Actions run
- Merge → CI upserts the prod Flight with the real cron from `flight.toml`

### 1.7 Sequencing

Ship NBA fully before starting NHL:

1. NBA: scaffold, port, register `nba_nightly`, validate 2 consecutive runs, register `nba_backfill` (on-demand only since v3 starts pre-populated by Phase 0)
2. NHL: copy the NBA structure, port the NHL-specific API + parser, register `nhl_nightly` and `nhl_backfill`
3. Disable both legacy GH Actions workflows together once both sports run cleanly

Parallelizing risks compounding bugs across two ports.

### 1.8 Cutover checklist

- [ ] Phase 0 complete (v3 cloned, token provisioned)
- [ ] Both NBA and NHL nightly Flights green for 2 consecutive runs (writing to v3)
- [ ] Row counts in `nba_box_scores_v3` match v2 for the days both pipelines covered
- [ ] `flight_health.py` registered (weekly cron, scans `MD_FLIGHT_RUNS` for failures, posts to stdout/MD_FLIGHT_LOGS — alerting layer is a follow-up)
- [ ] `metadata_generator` refresh — register as a **separate weekly Flight** that runs after nightly NBA + NHL complete. Reuses the [`metadata_generator`](../metadata_generator/) labs project as a Python dep
- [ ] Disable `nightly-sync.yml` and `backfill.yml` via `workflow_dispatch` UI (don't delete — v2 stays alive)
- [ ] Observe 1 week
- [ ] Old `scripts/ingest/` deleted from the old repo (workflows + scripts together)

Note: v2 is **not** retired — Vercel app keeps reading it. v2's GH Actions workflows are what we disable; v2 itself stays.

## Phase 2 — Frontend → Dive

Repo home: a **new repo** (probably `nba-box-scores-dive`), modeled directly on [`motherduckdb/blessed-dives`](https://github.com/motherduckdb/blessed-dives). Not in the labs monorepo — the deploy tooling is repo-scoped and the dive needs its own lifecycle.

### 2.1 Architecture (lifted from blessed-dives)

```
nba-box-scores-dive/
├── CLAUDE.md                 # Safety rules + dive API pointers
├── README.md
├── package.json              # Build tooling: esbuild, tsx, @duckdb/node-api, zod
├── build.ts                  # esbuild bundle per dive (externalizes react/recharts/d3/lucide-react/@motherduck/react-sql-query)
├── deploy.ts                 # MD_CREATE_DIVE / MD_UPDATE_DIVE_CONTENT / MD_UPDATE_DIVE_METADATA via @duckdb/node-api
├── schema.ts                 # Zod schema for dive package.json
├── dives/
│   └── nba-box-scores/
│       ├── package.json      # { "dive": { "title", "description", "requiredResources": [...] } }
│       ├── index.tsx         # Default export = dive component
│       ├── components/       # Local React files inlined by esbuild
│       └── CLAUDE.md         # Dive-specific context (data sources, metrics)
└── .github/workflows/
    ├── deploy_dives.yaml          # PR → preview, merge → prod
    └── cleanup_preview_dives.yaml # Branch delete → drop preview
```

Two GitHub Actions secrets:

| Secret | Used by | Token scope |
|---|---|---|
| `DIVES_MOTHERDUCK_TOKEN` | merge-to-main job | prod service account |
| `DIVES_DEV_MOTHERDUCK_TOKEN` | PR preview + cleanup jobs | dev/staging account |

### 2.2 CI flow (mirrors `blessed-dives/.github/workflows/deploy_dives.yaml`)

1. **PR opens or pushes** → `deploy-preview` job:
   - `npm ci && npm run build`
   - `npx tsx deploy.ts preview "$CHANGED_DIVES" "$BRANCH_NAME"` — title becomes `NBA Box Scores:<branch> (Preview)`
   - Comments `https://app.motherduck.com/dives/<id>` on the PR (with a hidden marker so reruns update the existing comment)
2. **Merge to `main`** → `deploy` job:
   - `npm ci && npm run build`
   - `npx tsx deploy.ts deploy "$CHANGED_DIVES"`
   - Finds the existing dive by title, calls `MD_UPDATE_DIVE_CONTENT` + `MD_UPDATE_DIVE_METADATA`; if none, calls `MD_CREATE_DIVE`
   - Comments deployment URL on the merged PR
3. **Branch deleted** → `cleanup_preview_dives` job: `npx tsx deploy.ts cleanup "$BRANCH_NAME"` drops the preview dive

Single-dive repos simplify the `dorny/paths-filter` step — we can drop it or hardcode `nba-box-scores` as the only output. (Blessed-dives has a paths-filter only because it hosts ~12 dives.)

### 2.3 Bootstrap

- Create `motherduckdb/nba-box-scores-dive` (or in your personal org)
- Copy `build.ts`, `deploy.ts`, `schema.ts`, the two workflows, and root `package.json` from blessed-dives verbatim
- Update workflows to drop the multi-dive paths-filter (single dive)
- Create the two GitHub Actions secrets pointing at the relevant MotherDuck tokens
- Adapt `CLAUDE.md` for the NBA project (drop blessed-dives-specific safety rules, keep the structural ones)

### 2.4 Component → Dive section mapping

The Dive replaces the entire Vercel app. One Dive, several React sections:

| Vercel surface | Dive section | Notes |
|---|---|---|
| `app/page.tsx` schedule grid | `<ScheduleGrid />` | Source via `useSQLQuery('SELECT … FROM schedule WHERE …')` |
| `LiveGamesSection` | `<LiveGames />` | Polling? Or just on-load + manual refresh. |
| `BoxScorePanel` | `<BoxScorePanel />` | Click-through from grid. |
| `SeasonFilter` | `<SeasonFilter />` | State lifted into URL params if Dives support that, else local state. |
| Scatter plot | `<ScatterPlot />` | recharts → check what charting libs the Dive runtime ships. May need to swap. |
| Dynamic stats explorer | `<DynamicStatsExplorer />` | Likely the biggest port. |
| Sport switcher | Top-level tab/segment | NBA vs NHL. |
| Player index | `<PlayerIndex />` | Sortable table. |

Declare required resources both in `dives/nba-box-scores/package.json`:

```json
{
  "name": "nba-box-scores",
  "dive": {
    "title": "NBA Box Scores",
    "description": "Schedule, live games, box scores, and stats explorers for the NBA and NHL.",
    "requiredResources": [
      { "url": "md:nba_box_scores_v2", "alias": "nba_box_scores_v2" }
    ]
  }
}
```

…and in the component file itself:

```tsx
export const REQUIRED_DATABASES = [
  { type: 'database', path: 'md:nba_box_scores_v2', alias: 'nba_box_scores_v2' },
];
```

(blessed-dives uses `type: 'share'` for shared databases; we use a regular database, so the shape differs slightly — confirm by calling `get_dive_guide` MCP tool during bootstrap.)

### 2.5 Data fetching

Use `@motherduck/react-sql-query` (externalized by the build; provided by the dive runtime):

```tsx
import { useSQLQuery } from '@motherduck/react-sql-query';

// Before (Next.js + @motherduck/wasm-client hook)
const { data } = useSchedule(season);

// After
const { data } = useSQLQuery(`
  SELECT game_id, game_date, home_team_id, away_team_id, ...
  FROM nba_box_scores_v2.main.schedule
  WHERE season_year = $1
`, [season]);
```

### 2.6 Bundled vs externalized libraries

The `build.ts` externalizes runtime-provided libraries — these are NOT bundled:

- `react`, `react-dom`
- `@motherduck/react-sql-query`
- `recharts`
- `d3`
- `lucide-react`

Anything else (date utilities, custom helpers) must be in the dive's own `dives/nba-box-scores/package.json` `dependencies` and gets inlined by esbuild. Translation for the NBA app:

- `recharts` for scatter plot + dynamic stats ✅ available
- `date-fns` → add to dive deps (will be inlined) OR rewrite as small helpers
- `react-themes` / `next-themes` → drop; the dive runtime handles theming
- `next/dynamic` → drop; everything is bundled into one file

### 2.7 Dive SQL surface — views as API

Rather than have the Dive's `useSQLQuery` calls join raw tables, design a small set of **purpose-shaped views** in `nba_box_scores_v3` that match the Dive's queries 1:1. The Dive's data layer becomes `SELECT * FROM nba_box_scores_v3.public.<view>`, and the joins/aggregations live in SQL where they're easy to revise.

Starter set (refine during Phase 2):

| View | Backs |
|---|---|
| `schedule_with_scores` | Schedule grid, live games section |
| `box_score_player_rows` | Box score panel (one row per player per game) |
| `player_index` | Player table (alphabetical or by recency) |
| `season_scatter` | Scatter plot (one row per team-game or player-game) |
| `dynamic_stats_facts` | Dynamic stats explorer |

Each view is a `CREATE OR REPLACE VIEW` checked into the pipeline repo (under `src/nba_box_scores_pipeline/db/views/`) and applied as part of the nightly Flight's post-load step. Refreshing is automatic since they're views, not materialized — escalate to `CREATE OR REPLACE TABLE AS` only when a specific view is too slow for `useSQLQuery`.

### 2.8 Known UX regressions

- **No URL deep links.** Dives are single-component, single-state. The current `/`, `/nhl`, and any game-specific routes lose their URL identity. Internal state (selected season, selected game) is preserved across the session but not shareable. Acceptable for v1; flag for users who currently bookmark.
- **No `next/image` optimization.** Player headshots (if any) load at their source size.

### 2.9 Testing scope

- Phase 1: port the existing Jest parser tests to `pytest` as the minimum bar. Don't try to port the integration tests — they hit the real API.
- Phase 2: rely on the Dive preview-on-PR flow; no automated UI tests.

### 2.10 Decommission Vercel

**Not urgent.** v2 + Vercel keep running in parallel for as long as you want — there's no forcing function. The cleanup steps below are pure when-you're-ready:

- Pause the Vercel project (deployment stops, domain still resolves until DNS changes)
- Update DNS / external bookmarks to the Dive URL
- Delete the Vercel project after a cooling-off period
- Drop `nba_box_scores_v2` only after the Vercel app is gone

Until then v2 stays alive and the legacy app keeps serving traffic from it; v3 is just the new home for Flights and the Dive.

## Phase 3 — Cleanup

- Add `MIGRATED.md` to the old `nba-box-scores` repo pointing at:
  - `labs/projects/nba-box-scores-pipeline/` (new pipeline)
  - The new Dive repo
- Archive the old repo via GitHub settings (read-only, search still works)
- Drop `nba_stats.duckdb` local cache if no longer used

## Risks and open questions

| Risk | Mitigation |
|---|---|
| Flights is preview — could change | Pin a working `MD_CREATE_FLIGHT` signature; document the version. Plan accepts breaking changes during preview. |
| `requirements_txt` referencing a git subpath may not be supported | Fallback A: `build.py` concatenates the package modules into the `source_code` string (single-file inline). Fallback B: publish the package to PyPI. Confirm git-URL support by reading the `MD_CREATE_FLIGHT` examples in the docs PR before committing to the architecture. |
| Two-token split assumes a separate dev MotherDuck workspace | If only one account is available, point both secrets at the same token and use the `__pr_<branch>` name prefix to keep preview Flights distinguishable. Preview Flights still skip `schedule_cron` so they don't fire on their own. |
| Backfill speed regressions | Mooted by Phase 0 — v3 starts as a clone of v2, so no full re-ingest. Future on-demand backfills are single-process; fan out via multiple `MD_RUN_FLIGHT` calls only if a specific run is too slow. |
| Idempotency regressions | Failed Flight retries must be safe. Loader uses upsert-shaped writes; the status table in `db/status.py` gates work that's already done. Pre-cutover validation: kill a Flight mid-run and confirm the next run completes without duplicates. |
| Token expiry / rotation | `labs_ingest_token` is provisioned once in Phase 0. If it rotates, every Flight breaks until the new token is created with the same `access_token_name`. Document the rotation procedure in `README.md`. |
| Dive runtime may not include `recharts` | Confirmed: blessed-dives externalizes `recharts`, `d3`, and `lucide-react`. NBA scatter + dynamic stats charts using `recharts` should port cleanly. |
| `next/dynamic`, SSR, route-level code splitting | Dive is a single bundle, single component tree, no routes. Replace with internal state-driven tab/section switching. |
| `date-fns` and other utilities not in the externalized list | Add to dive's `package.json` dependencies; esbuild inlines them. Bundle size grows but stays manageable. |
| Dive can't fully replicate Next.js routing | The current app has `/` and `/nhl` routes plus dynamic sub-pages. A single Dive uses internal state for navigation. Acceptable for v1; revisit if power users miss URL-based deep links. |
| Service account vs personal token | Dives-as-code doc recommends a service account. Decide who owns it before publishing the Dive. |
| `metadata_generator` integration | The old pipeline calls `metadata_generator` via a sibling script. Decide whether to inline that into the Flight or run it as a separate weekly Flight. |

## References

- [Flights concept](https://github.com/motherduckdb/motherduck-docs/blob/dumky/flights-feature-docs/documentation/concepts/flights.md) (PR #1633, preview)
- [`MD_CREATE_FLIGHT` reference](https://github.com/motherduckdb/motherduck-docs/blob/dumky/flights-feature-docs/documentation/sql-reference/motherduck-sql-reference/flights/md-create-flight.md)
- [Dives overview](https://motherduck.com/docs/key-tasks/ai-and-motherduck/dives/)
- [Managing Dives as code](https://motherduck.com/docs/key-tasks/ai-and-motherduck/dives/managing-dives-as-code/)
- [`motherduckdb/blessed-dives`](https://github.com/motherduckdb/blessed-dives) — canonical reference for `build.ts` / `deploy.ts` / CI workflow patterns. We mirror the same shape for BOTH the Dive (Phase 2) and the Flights (Phase 1, `deploy.py` instead of `deploy.ts`, calling `MD_CREATE_FLIGHT` instead of `MD_CREATE_DIVE`).
- [Flights SQL functions](https://github.com/motherduckdb/motherduck-docs/pull/1633) — `MD_CREATE_FLIGHT`, `MD_UPDATE_FLIGHT`, `MD_DELETE_FLIGHT`, `MD_FLIGHTS`, `MD_FLIGHT_RUNS`, `MD_FLIGHT_LOGS`, `MD_RUN_FLIGHT`, `MD_CANCEL_FLIGHT_RUN`
- `get_dive_guide` MCP tool — call early in Phase 2 for the live dive API reference (component shape, allowed libs, styling rules)
- Old pipeline: `~/code/nba-box-scores/nba-box-scores/scripts/ingest/`
- Old frontend: `~/code/nba-box-scores/nba-box-scores/app/`
