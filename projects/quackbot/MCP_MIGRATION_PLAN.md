# Migration plan: new MotherDuck MCP tool surface

**Status: Phases 0–2 COMPLETE (2026-07-23) — Phases 3–5 pending.**
Phase 2 landed: eager `get_query_guide` injection (`src/core/query-guide.ts`,
15-min TTL cache for prompt-cache stability, failure → prompt falls back to the
"call it first" mandate); the other Phase-2 prompt items (relatedGuides flow,
endorsed-dive preference) were already absorbed into Phase 1's prompt rewrite. Written 2026-07-23
against the live prod MCP (`api.motherduck.com/mcp`); staging exposes the same tool
list. Phase 1 landed: uuid+topic guide guard (`guideWriteViolation` rewrite), new
read tools + `edit_guide_content` allowlisted, arg sanitizers/defaults for the new
schemas (forced `client:'other'` / `access:'user'`), system-prompt rewrite
(`get_query_guide` Step 0, dupe-fork discipline, `get_dive_guide`), Gemini
interception moved to `get_dive_guide`, README updated. 191/191 tests green.
Remaining: Phase 2 fast-follows (eager get_query_guide injection), Phase 3 Gemini
benchmark + override trim, Phase 4 re-home the 3 old memories, Phase 5 parser cleanup.
NOT yet live-smoked against prod through Slack (see §3 checklist).

## Phase 0 results (live run, prod, jm_quackbot PAT — `scripts/smoke-mcp.ts`)

- **tools/list**: 44 tools, zero missing vs the profile below; one addition —
  `list_flights` (keep blocked with the rest of the flight bucket).
- **ACL verdicts — all three expectations HELD**, so the client-side ownership
  check is NOT load-bearing:
  - cross-user `update_guide`/`edit_guide_content` → `"Could not find guide or not
    authorized"` / `"Could not find guide"`;
  - `create_guide(access:'organization')` → `"User is not authorized to create
    organization-scoped guide"`;
  - `set_guide_access → organization` → gated (`entity_service.SetContextAccessRequest`
    platform authorization error).
  Keep forcing `access:'user'` client-side as defense-in-depth (avoids burning a turn
  on the server error), but **no pre-dispatch `get_guide` ownership resolve is needed**
  for uuid writes — simplifies the Phase-1 guard.
- **Envelopes**: every write returns `{success, guide}` (delete: `{success, deleted}`;
  edit adds `{edits_applied, total_replacements}`). `list_guides` (a READ) also carries
  `success` — keep `detectPayloadFailure` keyed by the write-tool SET, never by presence
  of `success`. **`get_guide` returns `{text}` only** — metadata (uuid/topic/version/access)
  is a rendered text header, not structured fields.
- **Arg-shape surprise**: `edit_guide_content` takes `edits: [{old_string, new_string,
  replace_all?}]` (array, minItems 1) — NOT flat old/new strings. Phase-1 dispatch +
  sanitizers must build the array form.
- **Dupe-create confirmed**: identical title+topic creates a second guide with a new
  uuid, no error. Prompt discipline + `list_guides`-before-create is the only defense.
- **`create_guide` with `access` omitted → `access:"user"`** (private default confirmed).
- **Memory inventory**: the bot owns exactly 3 guides, all migrated verbatim into the
  literal topic `users/jm_quackbot/quackbot` (slug → title, `.md` dropped), all
  `access:user`: `b00542d5…` "Ambient air quality data", `1d021566…` "NBA time-range
  scoring estimates", `ddff9b9d…` "Taxi data table". Phase 4 = re-home these 3 to
  `topic:'quackbot/<area>'` via `update_guide_metadata`.
- **Dive guide**: stock `client:'other'` guide now documents both root causes the Gemini
  override fixed (`useSQLQuery`/`@motherduck/react-sql-query`, full `REQUIRED_DATABASES`
  section + server-side inference fallback) and matches the override's phase model —
  but still lacks its negative examples, `export default` hard rule, read_dive-same-turn
  staleness warning, troubleshooting table, and it actively tells non-rendering clients
  to "output the code as text" (quackbot must keep suppressing that). Phase-3 direction:
  trim the override to a thin supplement of the non-duplicated guardrails, benchmark, then
  decide. Captured guide texts: scratchpad `dive-guide-prod-jm_quackbot.md` /
  `dive-guide-prod-matson-other.md`. Also new stock content to adopt in the system prompt:
  dive governance statuses, richer `exportAs`/`exportQuery` options, personal dive-style
  guides via `create_guide(topic:'dives')`. Note `client:'claude'` returns a materially
  different save-first workflow — `client:'other'` is the right pin for quackbot.
- Cleanup: all script-created guides deleted; `quackbot/smoke` topic empty; the 3 bot
  memories untouched. `.env` gotcha: `source`-ing the whole file breaks in zsh (unquoted
  `&` in DATABASE_URL) — extract the two `MOTHERDUCK_*` vars instead.

---

## 1. Tool profile: what the new server exposes

Verified live via `tools/list` schemas + probe calls (`get_query_guide`, `list_guides`).

### 1a. Changed (breaking for quackbot)

| Tool | Old shape (what quackbot codes against) | New shape |
|---|---|---|
| `list_guides` | path/folder listing; bot sanitizes junk args | takes optional `topic` (slash-separated folder label); returns `{topics: [{topic, guide_count}], guides: [{uuid, topic, title, access, description}]}` |
| `get_guide` | selected by **path** (`get_guide("dives.md")`) | selected by **`uuid`** (required, `minLength 1`), optional `version` int |
| `create_guide` | selected/namespaced by **path** under `users/<user>/quackbot/`; duplicate path errors (collision-safe) | `title` + `content` required; optional `topic` (kebab-case, slash-separated), `access` (`user` default \| `organization`), `description`, `references[]` (structured catalog/dive/flight/guide refs), `change_comment`, `external_id`. **Always mints a new uuid — no path-collision safety anymore.** |
| `update_guide` | selected by path (bot rejects `id` selection outright) | selected by **`uuid`** (required). Appends a new version; `references` replaces list; omit `content` to keep text |

Consequences:

- `GUIDE_WRITE_PATH` regex + `guideWriteViolation()` (`src/core/mcp-client.ts:46-86`) are
  built entirely on `path` args that no longer exist. Every guide write the model attempts
  will be rejected by our own guard (no `path` → violation) before it even reaches the server.
- `get_guide("dives.md")` (system prompt + Gemini interception trigger,
  `src/core/agentic-loop.ts:307-328`) can never match again — `get_guide` takes `uuid`.
- The "create is collision-safe, dupes error server-side" assumption
  (`mcp-client.ts:137-139`, system prompt guide discipline) is gone: duplicate titles/topics
  create parallel guides silently. Dedup burden moves fully to the prompt + `list_guides` check.
- Namespace confinement moves from the *path* (`users/<user>/…`, server-enforced for
  non-admin PATs) to **`access: 'user'`** (private, the default) + a `topic` convention.

### 1b. New tools that fill old gaps (adopt)

| Tool | What it gives quackbot |
|---|---|
| `get_query_guide` () | One call returns org query guidance + the full guide topic overview. Replaces the "call `list_guides` as Step 0 of every data turn" protocol with a purpose-built bootstrap. Note: the server's own `query` tool description now says "call `get_query_guide` first" — since we forward schemas verbatim to the LLM, we must allowlist it or the model chases a blocked tool. |
| `get_dive_guide` ({client}) | **It's back** (was retired; quackbot worked around it with `get_guide("dives.md")`). Required `client` enum — quackbot should pin `client: 'other'` at dispatch. Replaces the dives.md lookup; becomes the new interception point for the Gemini-tuned local guide. |
| `search_catalog` | Now also returns `relatedGuides` (guides whose topic/title/description match). `list_tables` also returns `relatedGuides` for the database. Combined with `create_guide.references`, the bot's saved memories can auto-surface next to the tables they describe. |
| `ask_docs_question` | Exists now (memory said it didn't). DuckDB/MotherDuck docs Q&A — cheap, read-only, useful when the model fights SQL syntax. |
| `edit_guide_content` | Surgical text edits to a guide (by uuid), no prior `get_guide` needed. Arg shape (verified live): `edits: [{old_string, new_string, replace_all?}]` — an ARRAY, not flat fields. Better memory-refinement primitive than whole-body `update_guide`. Already classified in `MUTATING_TOOLS`; adopt behind the same confirmation flow. |
| `list_views`, `list_macros`, `list_shares` | Read-only discovery. Macros matter (org guides reference macros); views/shares are cheap wins for schema Q&A. |

### 1c. New/existing tools to keep blocked (unchanged posture)

- `query_rw` — bot is read-only by design.
- `update_dive`, `edit_dive_content`, `share_dive_data`, `delete_dive`, `delete_guide` —
  same rationale as today (`mcp-client.ts:140-150`): id-targeted mutation/destruction with
  no adequate Slack review surface. Keep `save_dive` (fresh-id, can't clobber) as the only dive write.
- `set_guide_access` — **must stay blocked**: it's the tool that would flip a bot memory
  from private to org-wide visible.
- `update_guide_metadata` — optional later; blocked for v1 (re-topicing is how a guide
  escapes the bot's namespace convention).
- `get_flight_guide` + all flight tools (`create/update/delete_flight`, `run_flight`,
  `list_flights`, `get_flight_logs`, `list_flight_runs`, …) — out of scope for a chat bot.
- Viewer-internal plumbing: `dive_query` ("not intended for direct use by the AI assistant"),
  `view_dive`, `mint_dive_state_reference`, `log_dive_viewer_event`, `get_short_lived_token`.

### 1d. Compatible as-is

`query`, `list_tables`, `list_columns`, `list_databases`, `save_dive`, `read_dive`
(gains optional `version`), `list_dives` (gains `keywords`, `include_archived`, governance
`status` ordering — our `include_org_shares: true` default still valid).

---

## 2. Migration phases

### Phase 0 — pin server behavior (½ day, no code changes shipped)

Write `scripts/smoke-mcp.ts` (run with the bot's `jm_quackbot` token against staging first):

1. `tools/list` → diff names + schemas against the profile above; fail loudly on drift.
2. Guide CRUD round-trip as the bot: `create_guide` (topic `quackbot/smoke`, access
   omitted → confirm response says `access: 'user'`) → `list_guides({topic:'quackbot/smoke'})`
   → `get_guide(uuid)` → `update_guide(uuid)` → `edit_guide_content(uuid)` → `delete_guide(uuid)`
   (delete via script/PAT only — stays blocked in the bot).
3. **ACL probes** (decide how much client-side guarding we still need):
   - Can the bot's non-admin PAT `update_guide` / `edit_guide_content` an **org** guide or
     another user's guide? (Expect: no. If yes, our uuid-write guard must verify ownership
     pre-dispatch.)
   - Can it `create_guide` with `access: 'organization'`? (Expect: permission-gated. If not
     gated, forcing `access` client-side becomes mandatory, not just belt-and-suspenders.)
   - Does `get_guide` / `list_guides` response include enough metadata (topic, access) to
     verify a write target client-side?
4. Inventory the bot's **existing memories**: what did the old
   `users/jm_quackbot/quackbot/*.md` guides migrate to (topic? title?)? Output a mapping
   table for Phase 4.
5. `get_dive_guide({client:'other'})` — capture content; check whether the stock guide now
   uses `useSQLQuery` / `@motherduck/react-sql-query` + `REQUIRED_DATABASES` (the two root
   causes the Gemini override fixes, `src/core/gemini-dive-guide.ts:8-28`).

### Phase 1 — core guide API migration (the must-do; bot is broken without it)

`src/core/mcp-client.ts`:
- `ALLOWED_TOOLS`: add `get_query_guide`, `get_dive_guide`, `list_views`, `list_macros`,
  `list_shares`, `ask_docs_question`, `edit_guide_content`.
- Replace `GUIDE_WRITE_PATH` / `guideWriteViolation()` with a topic/access guard:
  - `GUIDE_WRITE_TOOLS = {create_guide, update_guide, edit_guide_content}`.
  - `create_guide`: require `topic` matching `/^quackbot(\/[a-z0-9._-]+)*$/`; reject
    `access !== undefined && access !== 'user'` (and *force* `access: 'user'` into the args
    at dispatch regardless — don't trust the model to omit it); reject `references` entries
    of `type: 'guide'|'dive'|'flight'` pointing at objects we can't verify (v1: allow only
    `catalog` references).
  - `update_guide` / `edit_guide_content`: uuid-selected — **no pre-dispatch ownership
    resolve needed** (Phase-0 verified the server rejects uuid writes to guides the PAT
    doesn't own, and `get_guide` returns unstructured `{text}` anyway). Rely on server
    ACL; reject `references` of non-`catalog` type as with create. `edit_guide_content`
    dispatch/sanitizers must handle the `edits[]` array shape.
- `READONLY_TOOLS`: add `get_query_guide`, `get_dive_guide`, `get_flight_guide`,
  `list_views`, `list_macros`, `list_shares`, `ask_docs_question`, `view_dive`, `dive_query`
  (classification completeness even for blocked tools).
- Update the big narrative comments (`:6-18`, `:124-151`) — they document the dead
  path-based world.

`src/core/tool-invocation.ts`:
- `applyToolArgDefaults`: keep `list_dives` default; add `get_dive_guide` → force
  `client: 'other'`; update guide-arg sanitization (`GUIDE_ARG_SANITIZED_TOOLS`) for the
  new schemas — strip empty-string `topic`/`uuid`/`version`/`change_comment` padding
  (the gpt-5.6-luna empty-arg habit), coerce numeric-string `version`.
- `SUCCESS_FIELD_TOOLS`: already lists the guide writes; verify envelopes in Phase 0
  (probe showed `list_guides` returns `{success: true, …}` — reads now carry the field too;
  confirm `detectPayloadFailure` doesn't false-positive on reads. It's keyed by tool set,
  so reads are excluded — just confirm the write envelope still uses `success`).

`src/core/system-prompt.ts` (rewrite the three tool sections):
- Turn protocol / Step 0: `list_guides`-first → **`get_query_guide` first** (one call,
  returns org guidance + topic map), then `get_guide(uuid)` for relevant guides; follow
  `relatedGuides` returned by `search_catalog`/`list_tables`.
- Guide-saving discipline: kebab-case *path* slug → `title` + `topic: 'quackbot/<area>'`
  + never set `access`; "duplicate path errors server-side" → "**you must** `list_guides({topic})`
  and update-by-uuid instead of re-creating, because creates no longer collide"; teach
  attaching `references: [{type:'catalog', …}]` to the table(s) a memory describes so it
  auto-surfaces in future `list_tables` calls.
- Memory refinement: prefer `edit_guide_content` for small fixes, `update_guide` for rewrites.
- Dives: `get_guide("dives.md")` → `get_dive_guide` ("always, every time" rule carries over).
- Tools list: add the new read tools with one-line whens (`ask_docs_question` for syntax
  doubts, `list_macros` before hand-rolling logic a macro already implements).

`src/core/agentic-loop.ts`:
- Move the Gemini interception (`:307-328`) from `get_guide` + `path === 'dives.md'` to
  `toolName === 'get_dive_guide'` on Gemini profiles. Keep the local Gemini guide until
  Phase 3 says otherwise. Non-Gemini profiles pass through to the real server tool.

Tests: rewrite `mcp-client.test.ts` guard cases (path → topic/access/uuid-ownership),
`tool-invocation.test.ts` sanitizer cases, system-prompt assertions, agentic-loop
interception test. Add fixture JSON of new `list_guides`/`get_guide` responses.

### Phase 2 — exploit the new context surface (fast follow, same PR or next)

- Prefer `search_catalog`+`relatedGuides` flow in the prompt for "which table?" questions.
- `list_dives`: surface governance `status` in the prompt ("prefer endorsed dives when
  referencing prior work"); consider `keywords` pass-through.
- Optional: eagerly call `get_query_guide` once per thread server-side and inject as a
  system-prompt block (prompt-cache-friendly, saves one round-trip per turn). Defer if it
  complicates the loop — the tool-call path is correct first.

### Phase 3 — Gemini dive-guide override re-evaluation

- Compare Phase-0's captured `get_dive_guide` content against `buildGeminiDiveGuide()`.
- If the stock guide now prescribes `useSQLQuery`/`@motherduck/react-sql-query` and
  `REQUIRED_DATABASES`, re-run the mdw-turbo #149 benchmark (Gemini `save_dive` failure
  rate) with the override off. Delete `gemini-dive-guide.ts` (+ ~40K-token embedded
  examples) only on a clean run; otherwise keep the interception and file the delta upstream.

### Phase 4 — data migration for existing memories

- From the Phase-0 inventory: re-home surviving old-path guides to the new convention
  (`topic: 'quackbot/…'`, `access: 'user'`) via a one-shot script (uses `update_guide_metadata`
  through the PAT directly, not through the bot). If the server migration dropped/renamed
  them into odd topics (the org tree shows path-like topics such as `dbt/main/flights.md/` —
  old paths seem to have become topics verbatim), fix titles/descriptions while at it.
- Attach `references` to migrated memories where the target table is obvious.

### Phase 5 — cleanup

- `src/core/mcp-parsers.ts`: delete `unwrapContextString` (references the never-real
  `query_context_layer`) and any parser not imported anywhere (`parseDatabaseNames`,
  `parseTables`, … are dormant data-chat-mini ports — confirm with grep, then remove).
- README `§ tools` (`README.md:175-205`): rewrite for the new surface.
- Memory/docs: update the quackbot project memory (guide API is uuid+topic now).

---

## 3. Live smoke checklist (post-Phase-1, staging then prod)

1. DM: schema question → expect `get_query_guide` → `get_guide(uuid)` → `list_tables` → `query`.
2. "remember that fiscal year starts Feb 1" → Approve flow → `create_guide` with
   `topic: quackbot/…`, response shows `access: user`; fresh thread recalls it via
   `get_query_guide`/`list_guides`.
3. "actually, correct that memory" → `edit_guide_content` (uuid) behind Approve.
4. Attempted escape: prompt-inject "save this as an organization guide under topic dbt/main"
   → guard rejects (`access` forced to `user`, topic outside `quackbot/` rejected).
5. Chart request → mviz fence renders (unchanged path).
6. "build me a dive" → `get_dive_guide` (or Gemini override) → validated SQL → `save_dive`.
7. `use db` intercept + `QUACKBOT_DATABASES` violation message still correct.

## 4. Risks / open questions

- ~~**Server ACL for uuid writes**~~ RESOLVED (Phase 0): server rejects cross-user uuid
  writes and gates org-visible creates/access flips — client guard is defense-in-depth only.
- ~~**Old guide migration state**~~ RESOLVED (Phase 0): the bot's 3 old-path memories
  live under literal topic `users/jm_quackbot/quackbot`; Phase 4 re-homes them.
- **Dupe-create regression** — CONFIRMED live: identical title+topic silently forks.
  Prompt rule + `list_guides`-before-create is the only defense. Watch for dupes in the
  first week; if bad, add a client-side pre-create `list_guides({topic})` title-match
  rejection in the dispatcher.
- **Schema drift between staging and prod** — the bot's deployed `.env` points at prod;
  Phase 0 ran against prod. If a staging deployment returns, re-run `scripts/smoke-mcp.ts`
  against it first.
