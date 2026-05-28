# nba-box-scores-pipeline

Python ingest pipeline for `nba_box_scores_v3`, deployed as MotherDuck Flights.

Replaces the TypeScript pipeline + GitHub Actions cron at
[`matsonj/nba-box-scores`](https://github.com/matsonj/nba-box-scores). The
target architecture, sequencing, and Phase 0 status live in [`plan.md`](./plan.md).

## Status

Phase 1 scaffold only. No port logic yet — each module from the legacy pipeline
lands in its own PR (see `plan.md` §1.2 for the file-by-file mapping).

## Layout

```
projects/nba-box-scores-pipeline/
├── plan.md                       # migration plan + Phase 0 receipts
├── pyproject.toml                # uv / hatchling
├── src/nba_box_scores_pipeline/  # importable package, used by every Flight
└── flights/                      # one folder per Flight
    ├── nba_nightly/              # scheduled (0 16 * * * UTC)
    └── nba_backfill/             # on-demand (no schedule_cron)
```

## Develop locally

```bash
cd projects/nba-box-scores-pipeline
uv venv
uv pip install -e ".[dev]"

export MOTHERDUCK_TOKEN=<your token with v3 read+write>
python flights/nba_nightly/main.py
```

The Flight runtime injects `MOTHERDUCK_TOKEN` from the token named
`dives-loader-nba` (owned by service account `jm_data_loader`). Locally you
substitute any token with the same scope.

## Deploy

Deploy tooling (`deploy.py`, `build.py`, the GitHub workflow) hasn't landed
yet. Until then, register Flights manually with the MotherDuck MCP
`create_flight` tool, pointing `md_token_name` at `dives-loader-nba` and
`source_code` at the contents of `flights/<name>/main.py`.

## References

- [`plan.md`](./plan.md) — migration plan
- [`projects/controllog`](../controllog/) — labs Python project conventions
- [`motherduckdb/blessed-dives`](https://github.com/motherduckdb/blessed-dives) — reference for the eventual `deploy.py` / CI flow
