# nba-box-scores

NBA box scores on a MotherDuck-native stack — a migration of the legacy
TypeScript/GitHub-Actions ingest + Next.js/Vercel frontend at
[`matsonj/nba-box-scores`](https://github.com/matsonj/nba-box-scores) onto
MotherDuck Flights + a Dive. NBA only. Everything reads/writes the
`nba_box_scores_v3` database.

Two slices:

| Slice | What it is |
|---|---|
| [`flight/`](./flight/) | Python ingest pipeline, run as scheduled MotherDuck **Flights**. `nba_nightly` ingests the current season into the production tables; `nba_backfill` is on-demand. |
| [`dive/`](./dive/) | The consolidated frontend, built as a MotherDuck **Dive** — schedule + box scores, a Game Quality leaderboard, and trends. Reads what `flight/` writes. |

They're decoupled: the Flight keeps `nba_box_scores_v3` current; the Dive
queries it live. See each slice's README for how to develop, build, and deploy.
