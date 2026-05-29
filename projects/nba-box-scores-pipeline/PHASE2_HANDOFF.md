# Phase 2 hand-off — nba-box-scores migration (Dive / frontend)

This doc lets a fresh Claude Code session pick up **Phase 2** (the Dive UI) without re-deriving
everything. Phase 0 (clone) and Phase 1 (Python ingest → Flights) are **done and live**.

Read this, then read [`plan.md`](./plan.md) §2 for the full Phase 2 design.

---

## TL;DR — where things stand (2026-05-29)

- **Phase 1 is LIVE.** A scheduled MotherDuck **Flight** (`nba_nightly`) ingests NBA box scores
  into `nba_box_scores_v3` nightly. It's self-maintaining.
- **Phase 2 has NOT started.** No migration Dive exists yet. That's this branch's job.
- Branch: you are on **`nba-box-scores-dive`**, cut from `nba-migration` (the long-lived
  integration branch, 5 commits ahead of `main`). Keep targeting `nba-migration`, not `main`.

## The data you're building a UI on

- **Database:** `nba_box_scores_v3` on the **live/production** MotherDuck account (user `matson`,
  reachable via the `mcp__claude_ai_MotherDuck__*` MCP tools — NOT the `_Staging` ones).
- v3 is currently byte-identical to `nba_box_scores_v2` (the DB serving the legacy Vercel app),
  and the nightly Flight keeps it current. v3 is isolated — nothing user-facing reads it yet.
- Everything lives in the **`main` schema**. No raw/hydrated schema split.

### Tables (`nba_box_scores_v3.main.*`)

| Object | Kind | Notes |
|---|---|---|
| `schedule` | table | one row/game. Cols: `game_id, game_date (TIMESTAMP), home_team_id, away_team_id, home_team_abbreviation, away_team_abbreviation, home_team_score, away_team_score, game_status, season_year, season_type, created_at`. ~33.4k rows. |
| `box_scores` | table | one row per **player × period**. PK `(game_id, entity_id, period)`. `period` ∈ `'1'..'6'`, `'FullGame'`. Cols: `team_abbreviation, player_name, minutes (VARCHAR 'MM:SS'), points, rebounds, assists, steals, blocks, turnovers, fg_made, fg_attempted, fg3_made, fg3_attempted, ft_made, ft_attempted, starter (1/0, only set on FullGame rows)`. ~3.05M rows. |
| `players` | view | `entity_id, player_name` (distinct, from FullGame rows). |
| `team_stats` | view | team aggregates per period + FullGame. |
| `game_quality` | view | the "GQ" metric per player-game: `fg_pct, ft_pct, fg_v, ft_v, ..., week_id, wins, gm_count, game_quality`. |
| `ingestion_log`, `raw_game_data_pbpstats` | tables | operational/raw — **not for the UI.** |

**Gotchas that bite query writers:**
- `box_scores` has **no `season_year`** — to filter by season, join `schedule` on `game_id`.
- `season_year = 2024` means the **2024-25** season. Current season today is `2025` (2025-26).
- For per-game player lines use `period = 'FullGame'`; for quarter/OT splits use `'1'..'6'`.
- The 3 views were just repointed from v2 → v3; they read v3 now.

## Decisions already made (don't re-litigate)

- **NBA only.** NHL is out of scope (legacy app had it; we dropped it). No sport switcher.
- **Prod, not staging.** Pipeline and Dive both live on the live account. Staging has a
  *separate, unrelated* `nba_box_scores` DB — ignore it.
- **Dive reads `nba_box_scores_v3.main.*`** directly.
- Nightly Flight stays live (cron `0 16 * * *` UTC). Flight id
  `ebeaf1ba-cb2a-4702-b8b7-252063a12f9b` — inspect via `mcp__claude_ai_MotherDuck__list_flights`
  / `get_flight` / `get_flight_run_logs` (the web UI doesn't show Flights yet — preview feature).

## Open decision for Phase 2 kickoff

**Repo home.** `plan.md` §2.3 says the Dive should be its **own repo** (modeled on
[`motherduckdb/blessed-dives`](https://github.com/motherduckdb/blessed-dives), local clone at
`~/code/blessed-dives`), because the dives-as-code deploy tooling is repo-scoped. But this branch
was cut in the labs monorepo per the user's request. **Resolve first:** separate repo (per plan)
vs. a `projects/nba-box-scores-dive/` dir in labs. The user leans toward iterating here; confirm.

## First steps for Phase 2

1. **Call `mcp__claude_ai_MotherDuck__get_dive_guide` immediately.** It returns the live Dive API:
   component shape, allowed/externalized libs, `useSQLQuery` usage, how `requiredResources` are
   declared, styling rules. This is authoritative and may have changed — trust it over this doc.
2. Skim the user's **32 existing prod dives** (`list_dives`) — they're ad-hoc NBA dashboards
   (PPG leaders, standings, GQ explorer, playoff bracket, etc.) and are excellent pattern/styling
   references. The migration Dive consolidates the legacy Vercel app's surfaces into one Dive.
3. Read the **old frontend** for the surfaces to port:
   `~/code/nba-box-scores/nba-box-scores/app/` + `components/` (Next.js 16 / React 19).
4. Decide the repo question above, scaffold accordingly.

## Component → Dive section map (from plan §2.4)

One Dive, several sections. Drop the NBA/NHL switcher.

| Legacy surface | Dive section |
|---|---|
| `app/page.tsx` schedule grid | `<ScheduleGrid />` |
| `LiveGamesSection` | `<LiveGames />` |
| `BoxScorePanel` | `<BoxScorePanel />` (click-through from grid) |
| `SeasonFilter` | `<SeasonFilter />` |
| scatter plot | `<ScatterPlot />` (recharts) |
| dynamic stats explorer | `<DynamicStatsExplorer />` (biggest port) |
| player index | `<PlayerIndex />` |

- Data layer: `useSQLQuery` from `@motherduck/react-sql-query` (runtime-provided, externalized).
- Externalized (do NOT bundle): `react`, `react-dom`, `@motherduck/react-sql-query`, `recharts`,
  `d3`, `lucide-react`. Everything else (e.g. `date-fns`) gets inlined by esbuild — confirm via
  the dive guide.
- `requiredResources` / `REQUIRED_DATABASES`: `md:nba_box_scores_v3` (alias `nba_box_scores_v3`).
- Known v1 regressions to accept: no URL deep links (single-component state), no `next/image`.

## Optional: purpose-shaped views (plan §2.7)

Rather than join raw tables in `useSQLQuery`, consider adding views to v3 that match the Dive's
queries 1:1 (`schedule_with_scores`, `box_score_player_rows`, `player_index`, `season_scatter`,
`dynamic_stats_facts`). These **do not exist yet** — only `players`/`team_stats`/`game_quality` do.
If added, check them into the pipeline repo (`src/.../db/`) and apply them in the nightly's
post-load step so they stay maintained.

## Environment gotchas

- MCP is the **live** account (`matson`). Dives created via MCP are owned by `matson`.
- **Flights** preview: no web UI, no `MD_CREATE_FLIGHT` SQL on this workspace (API/MCP only).
  **Dives** are fully supported in the UI (32 exist) and via MCP (`save_dive`, `update_dive`,
  `edit_dive_content`, `read_dive`, `view_dive`, `list_dives`).
- If doing dives-as-code deploy (blessed-dives style), confirm whether `MD_CREATE_DIVE` SQL is
  available on the workspace or whether to deploy via the MCP tools.

## Pointers

- Migration plan: [`plan.md`](./plan.md) (esp. §2).
- Pipeline (Phase 1, done): `projects/nba-box-scores-pipeline/` — `src/nba_box_scores_pipeline/`,
  flights in `flights/`, entrypoints in `entrypoints.py`.
- blessed-dives reference: `~/code/blessed-dives` (build.ts / deploy.ts / schema.ts / workflows).
- Legacy frontend: `~/code/nba-box-scores/nba-box-scores/app/` + `components/`.
- Auto-memory: `nba-box-scores-v3-migration` (has flight id, decisions, sync method, gotchas).
- `get_dive_guide` MCP tool — **call it first.**
