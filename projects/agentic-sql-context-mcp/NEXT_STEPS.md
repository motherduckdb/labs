# agentic-sql-context-mcp — status & next steps

A fork of `agentic-sql-claude-edition` that swaps the five hand-built agent tools
(`semantic_lookup` + in-process DuckDB `list_tables`/`list_columns`/`query`/`submit_answer`)
for the **MotherDuck context-MCP** tool surface:

- **Semantic layer → MCP guides**: `list_guides` / `get_guide` (the 27 `context/items/*.md`
  are published as guides under `dabstep/<domain>/<id>.md` by `asm guides-load`).
- **Data/schema → MCP tools**: `list_tables` / `list_columns` / `search_catalog` / `query`.
- **`submit_answer`**: kept as a thin local scoring latch — runs the SQL via MCP `query`
  and captures positional rows for `score.py`.

The agent talks to the MotherDuck MCP over streamable-HTTP (`src/mcp_client.py`), one
session per task. Everything else (DABStep scorer, controllog, CLI, results format,
OpenRouter provider + caching) is reused verbatim from the baseline.

## ✅ What works (verified)

- Full build complete; all modules import; `asm` CLI registers `load` / `guides-load` /
  `evaluate` / `summary` / `context`.
- **Single-eval smoke PASSED**: task `347` (non-fee) → **1/1 correct**, `$0.034`, 15 turns,
  via the prod MotherDuck MCP. This validates the whole plumbing: per-task MCP session,
  `list_tables`/`list_columns`/`query` (with the `database` arg injected in `mcp_client.py`),
  `submit_answer` latching positional rows, scoring, controllog, and the watch renderer.
- The always-on `SKILL.md` (PART 1 + answer-format rules) still carries formatting
  correctness without guides — the smoke answer used the strict `[k: v, ...]` format.

## ⛔ The blocker (root cause)

**The service account we're authenticated as does not have the guide MCP tools.**

- `SELECT current_user` → **`jm_agentic_malloy`** (a service account in a *different org*).
- That org's MCP build at `https://api.motherduck.com/mcp` exposes **23 tools and no
  general guide tools** (`list_guides`/`get_guide`/`create_guide`/`update_guide` are absent;
  only `get_dive_guide` exists). So `asm guides-load` fails with
  `-32602: Tool create_guide not found`, and the agent's guide tools error out.
- The guide tools *do* exist on other MotherDuck deployments (staging, and the org the
  claude.ai connector uses), just not for this account/org yet.

Everything except the guide half is proven working on prod.

## ▶️ Next steps (Thursday)

1. **Use an account/org that has the guide MCP tools on prod.** Options, in order of
   preference:
   - Get a **PAT for an org where guides are enabled** (e.g. matson's MDW org, or once
     guides are enabled for the `jm_agentic_malloy` org). Drop it in `.env` as
     `MOTHERDUCK_TOKEN`.
   - If guides live on a non-default endpoint, set `MOTHERDUCK_API_URL` accordingly
     (the client appends `/mcp`). Default is `https://api.motherduck.com`.
   - Confirm the target with a one-liner tool probe: `list_tools()` on the endpoint
     should include `list_guides` + `create_guide` (see `src/mcp_client.py` for the
     connect shape; there's a probe snippet in the PR description).
2. **Put the DABStep data in that same account** so guides + data co-locate on one MCP:
   `uv run asm load` (builds the DB named by `MD_DATABASE`). `mcp_client.py` injects
   `MD_DATABASE` into every `query`/`list_tables`/`list_columns` call, so keep `MD_DATABASE`
   pointed at whatever DB `asm load` builds.
3. **Publish the guides**: `uv run asm guides-load --dry-run` (preview paths), then
   `uv run asm guides-load`. Namespace controls:
   - `DABSTEP_GUIDES_PREFIX` (default `dabstep`) and `DABSTEP_GUIDES_ACCESS`
     (default `organization`). If org-level writes are rejected, re-run with
     `DABSTEP_GUIDES_PREFIX="users/<username>/dabstep"` and `DABSTEP_GUIDES_ACCESS="user"`.
   - Migration is idempotent (create → update-on-exists).
4. **Smoke a fee question** (the guides matter here), e.g.
   `uv run asm evaluate --task-id 1711 --watch` — watch the trace show
   `list_guides` → `get_guide` calls before the SQL.
5. **Run the train set**: `uv run asm evaluate --split templates` (26 reps). Compare to the
   baseline's template accuracy. Then `--split test` (419 held-out) vs the baseline's
   419/419 @ ~$7.91.

## Setup recap

```bash
uv sync
cp .env.example .env        # OPENROUTER_API_KEY + a guide-enabled MOTHERDUCK_TOKEN + MD_DATABASE
#                           # optional: MOTHERDUCK_API_URL if guides are on a non-default endpoint
```

## Open questions / watch-items

- **Guide granularity**: we publish 27 per-item guides (preserves the baseline's
  progressive disclosure). If `list_guides`/`get_guide` prove chatty, consider fewer,
  larger domain guides — but that trades away selective loading.
- **`submit_answer` row completeness**: confirm the MCP `query` returns the full result set
  for the scored SQL (no server row cap); the exploration `query` tool caps *display* only.
- **`list_columns` arg name**: we pass `{table, database}` (matches the prod schema). If a
  future MCP build changes this, adjust the tool body in `src/agent.py`.
