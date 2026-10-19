# GitHub write access: pending items

Status 2026-10-19: the read-only token is in place (`github_read` Flight secret, from 1Password entry
"GitHub PAT Public Read Only", vault Private). The **write** token for `motherduckdb/labs` is awaiting
org approval. Until then the healer runs in **direct mode** (`HEAL_GITHUB_MODE=direct`): approved
fixes are stored as patches in `heal.main.code_patches` and applied by the loader on top of the git
checkout, instead of going through a PR. Nothing below is done yet.

## When the write token is approved
1. Store it without printing it (same pattern as the read token):
   `GITHUB_TOKEN="$(op read 'op://Private/<entry name>/token')"` then
   `CREATE OR REPLACE SECRET github IN motherduck (TYPE flights, PARAMS MAP {'GITHUB_TOKEN': getenv('GITHUB_TOKEN')});`
   as `self_healing_svc` (`source ~/.config/self-healing/env.sh`).
2. Redeploy checker, fixer, watchdog so they get the `github` secret: `scripts/deploy.py --only checker fixer watchdog`.
3. Switch `HEAL_GITHUB_MODE` from `direct` to `pr` in the checker/fixer/watchdog config (scripts/deploy.py).
4. Convert every active direct patch into a real PR + merge on `heal/dev` (one-off script: for each
   `code_patches` row with status `active`, apply, commit, PR with labels heal/incident/level/category,
   merge after CI), then mark the rows `migrated` so the loader stops applying them.
5. Backfill GitHub issues for open incidents (`lifecycle.open_issue` for incidents with `gh_issue IS NULL`),
   and post the transition history as the first comment.
6. Verify the CI guard on a real heal PR (branch `heal/*`, "**Autonomy:** `Lx`" in the body), including
   that the PR's check run is what the fixer waits on before merging.
7. Verify a revert PR (branch suffix `-revert`) and the L3 proposal path (`proposed -> merged` when a human merges).
8. Re-run the scenarios whose answer key mentions PRs/issues (S01-S05, S09, S13, S17, S19) in `pr` mode.
9. Watchdog: test that it opens issues (`[heal] checker keeps failing`, `[heal] dispatch paused`).
10. Checker: test the "watchdog is silent" issue and the `other`-category proposal PR.

## Repo-side notes
- labs is public: incident issues and PRs will be public. All text is redacted before it is posted.
- No repo-wide settings were changed (no auto-merge, no branch protection); the fixer merges after CI.
- The fixer pushes `heal/<incident>-a<attempt>` branches; consider enabling "delete branch on merge"
  only if the labs maintainers agree (it is a repo-wide setting).
