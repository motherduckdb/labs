# agentic-sql-context-mcp — status & next steps

A fork of `agentic-sql-claude-edition` that swaps the five hand-built agent tools
(`semantic_lookup` + in-process DuckDB `list_tables`/`list_columns`/`query`/`submit_answer`)
for the **MotherDuck context-MCP** tool surface:

- **Semantic layer → MCP guides** (topic/uuid model): `get_query_guide` → `list_guides(topic)`
  → `get_guide(uuid)`. The 27 `context/items/*.md` are published as guides under topics
  `dabstep/<domain>` by `asm guides-load`.
- **Data/schema → MCP tools**: `list_tables` / `list_columns` / `search_catalog` / `query`.
- **`submit_answer`**: kept as a thin local scoring latch — runs the SQL via MCP `query`
  and captures positional rows for `score.py`.

The agent talks to the MotherDuck MCP over streamable-HTTP (`src/mcp_client.py`), one
session per task. Everything else (DABStep scorer, controllog, CLI, results format,
OpenRouter provider + caching) is reused verbatim from the baseline.

## ✅ Blocker RESOLVED — guide reads work (deploy landed 2026-07-23)

The platform migration from **path-addressing → topic/uuid addressing** deployed and is
**verified live on the raw prod endpoint this fork uses** (`api.motherduck.com/mcp`, the
`jm_agentic_malloy` service-account token). The read gap that blocked the whole runbook is
gone. Verified round-trip (`scripts/guide_smoketest.py`, **PASS**):

```
get_query_guide()                         -> OK   (org query guidance + topic catalog)
create_guide(topic="dabstep/…", access=user) -> uuid
list_guides(topic="dabstep/…")            -> guides[] each carrying uuid + description
get_guide(uuid)                           -> full guide body (rendered markdown)
delete_guide(uuid)                        -> cleaned up
```

### The confirmed contract (re-dumped from the live schemas)
- **`get_query_guide()`** — no args. Entry point; returns rendered text: org query guidance
  + a catalog of topics (folders w/ counts) and any topicless guides (inline uuid).
- **`list_guides(topic=…)`** — optional `topic`. Listing a PARENT topic (`dabstep`) returns
  child `topics:[{topic, guide_count}]` (the domains) and empty `guides`; listing a LEAF
  topic (`dabstep/fees`) returns `guides:[{uuid, topic, title, access, description}]`.
- **`get_guide(uuid=…)`** — required `uuid` (+ optional `version`). Returns the full guide
  body as rendered text in `structuredContent.text`. **`path` is gone**; guides are
  addressed only by the opaque server-minted uuid.
- **`create_guide`** — required `title`, `content`; optional `topic`, `description`,
  `access` (`user`|`organization`, default `user`), `external_id`. Returns
  `structuredContent.guide.id` = uuid. **No `path`.** `external_id` is NOT a dedup key —
  two creates with the same external_id mint two uuids, so idempotency must be local.
- **`update_guide(uuid, content)`** — refreshes the BODY only.
  **`update_guide_metadata(uuid, title, description, topic)`** — refreshes metadata.

## ✅ Code migrated to the topic/uuid model (this session, 2026-07-23)

- **`src/mcp_client.py`** — `AGENT_TOOLS` gained `get_query_guide`; `GUIDE_WRITE_TOOLS`
  gained `update_guide_metadata`. Path handling removed: `_guide_path_violation` →
  `_guide_write_violation` (per-tool required fields + topic-charset guard). Read args for
  `get_query_guide`/`list_guides`/`get_guide` are empty-stripped.
- **`src/agent.py`** — deleted `_guide_prefix`/`_apply_guide_prefix` (path rewriting).
  Tools are now `get_query_guide()` → `list_guides(topic=…)` → `get_guide(uuid=…)`; tool
  list and system prompt teach the three-step topic/uuid navigation.
- **`src/guides_load.py`** — publishes each item under topic `dabstep/<domain>`
  (title = item id, description = summary, `access` from `DABSTEP_GUIDES_ACCESS`,
  `external_id` = item id). Idempotency is **lock-driven** via a committed
  **`guides.lock.json`** (`id → {uuid, topic, title, access}`): known uuid → `update_guide`
  + `update_guide_metadata`; unknown → `create_guide` + capture uuid. `--dry-run` verified:
  27 items → `dabstep/{answer_format 3, bucketing 3, fees 4, schema 4, sql_patterns 11,
  terminology 2}`.
- **`src/run.py`** — `asm guides-load` output now prints `id / topic / uuid / action`.
- **`src/skill/SKILL.md`** — navigation rewritten to `get_query_guide → list_guides(topic)
  → get_guide(uuid)`; the "#1 cause of wrong answers" warning preserved (browse, then read
  the body by uuid — don't reconstruct from titles).
- **`scripts/guide_smoketest.py`** — rewritten to the new flow; **PASSES** on prod.
- **`.env`** — `DABSTEP_GUIDES_PREFIX=dabstep` (a topic prefix now, not a path),
  `DABSTEP_GUIDES_ACCESS=user` (the service-account token can only write personal guides;
  org writes are admin-only).

## ✅ Other plumbing already proven

- Full build imports; `asm` CLI registers `load` / `guides-load` / `evaluate` / `summary` /
  `context`.
- **Single-eval smoke PASSED** earlier: task `347` (non-fee) → 1/1 correct, `$0.034`, via
  the prod MCP — validates per-task session, `list_tables`/`list_columns`/`query` (with
  `database` injected), `submit_answer` positional-row latching, scoring, controllog, watch
  renderer.
- The always-on `SKILL.md` (PART 1 + answer-format rules) carries formatting correctness
  even before any guide fetch.

## ▶️ Next steps — the runbook (unblocked; run in order)

1. **Publish the guides**: `uv run asm guides-load --dry-run` (sanity), then
   `uv run asm guides-load`. This creates the 27 guides under `dabstep/<domain>` and writes
   `guides.lock.json`. Re-runs are idempotent (update by locked uuid). Commit
   `guides.lock.json`.
   - Note: the earlier one-time run (pre-migration) left ~27 `dabstep/*` path-model orphans
     + a few probe guides in the `jm_agentic_malloy` personal namespace. They're hidden from
     the org catalog and harmless; ignore them, or delete by uuid if you want a clean slate.
2. **Confirm data is loaded**: `uv run asm load` builds/refreshes the DB named by
   `MD_DATABASE`. `mcp_client.py` injects `MD_DATABASE` into every
   `query`/`list_tables`/`list_columns`.
3. **Smoke a fee question**: `uv run asm evaluate --task-id 1711 --watch` — the trace must
   show `get_query_guide` → `list_guides(topic="dabstep/…")` → `get_guide(uuid)` returning a
   body before the SQL, and land the answer.
4. **Run the template split**: `uv run asm evaluate --split templates` (26 reps) — compare
   to the baseline's template accuracy.
5. **Run the held-out test**: `uv run asm evaluate --split test` (419) — compare accuracy +
   cost to `agentic-sql-claude-edition`'s 419/419 @ ~$7.91.
6. **Render traces**: `controllog-viz review --source results --latest --open` — confirm the
   new MCP guide calls appear in the trace.

## Setup recap

```bash
uv sync
cp .env.example .env        # OPENROUTER_API_KEY + a guide-enabled MOTHERDUCK_TOKEN + MD_DATABASE
#                           # optional: MOTHERDUCK_API_URL if the MCP is on a non-default endpoint
```

## Open questions / watch-items

- **Guide granularity**: 27 per-item guides preserve the baseline's progressive disclosure.
  If `list_guides`/`get_guide` prove chatty at the domain level, consider fewer, larger
  domain guides — but that trades away selective loading.
- **`submit_answer` row completeness**: confirm the MCP `query` returns the full result set
  for the scored SQL (no server row cap); the exploration `query` caps *display* only.
- **uuid discovery cost**: the model must `list_guides(topic)` to obtain a uuid before
  `get_guide` — one extra hop vs the old hardcodable path. `get_query_guide` up front should
  keep this cheap; watch the template-split turn counts.
- **`list_columns` arg name**: we pass `{table, database}` (matches the prod schema). Adjust
  the tool body in `src/agent.py` if a future MCP build changes it.

---

### History (pre-2026-07-23 blocker — kept for context)

Before the deploy, guide **reads** were non-functional across the whole guides MCP surface:
you could `create_guide`/`list_guides` but `get_guide` 404'd for every address form (path,
topic, leaf, and even the uuid `create_guide` returned), because the backend had already
moved to id-addressing while `get_guide`'s schema still exposed only `path` and
`list_guides` never emitted a uuid. Root-caused via the `merge_overlays:false` error
*"Guides must be identified by id; the topic is a grouping label, not an address"*, and
confirmed platform-wide (matson org, 274 guides, via the claude.ai connector) — not a
per-account issue. The 2026-07-23 deploy shipped both missing rungs (`get_guide(uuid)` +
`list_guides` returning uuids) plus the `get_query_guide` entry point, which is what the
current code targets.
