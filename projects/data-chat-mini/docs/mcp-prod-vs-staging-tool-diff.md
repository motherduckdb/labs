# MotherDuck MCP Tool Diff — Prod vs Staging

Prod server prefix: `mcp__claude_ai_MotherDuck__` (33 tools)
Staging server prefix: `mcp__claude_ai_MotherDuck_Staging__` (41 tools)

The headline: **staging introduces a full "guides" subsystem** (10 tools' worth of surface area) and threads guide-awareness into the query and catalog tools. Prod's two guide tools (`get_dive_guide`, `get_flight_guide`) are replaced in staging by a general `get_guide` that serves dive/flight/query guidance from a single path-based store. Staging also adds `list_views` + `list_macros` discovery tools, dive governance status, and a flight per-run timeout.

---

## 1. Tools only in STAGING (10)

### `list_views`
**Description:** "List all views in a MotherDuck database, with their schema, comment, and column count. Optionally filter by schema or keywords."
**Params:** `database` (required, string), `schema` (optional), `keywords` (optional), `limit` (optional int, default 100, max 500).

### `list_macros`
**Description:** "List all macros (table and scalar macros) in a MotherDuck database, with their schema and parameters. Optionally filter by schema or keywords."
**Params:** `database` (required, string), `schema` (optional), `keywords` (optional), `limit` (optional int, default 100, max 500).

### `get_guide`
**Description:** "Load a guide by path. Call `get_guide(\"guides.md\")` before writing SQL — it includes the guide tree and query guidance. Call `get_guide(\"dives.md\")` before building dives and `get_guide(\"flights.md\")` before authoring flights. For topic guides use a path from the tree. By default, org guides are merged with any matching personal guide at `users/<you>/<path>` (personal content is appended). Set `merge_overlays: false` to read the org guide at `path` only."
**Params:** `path` (required, string, minLength 1), `merge_overlays` (optional bool, default true), `version` (optional int, org guide at path only, ignored when merge_overlays true).
**Note:** This is the staging replacement for prod's `get_dive_guide` and `get_flight_guide` — one tool covering query guidance (`guides.md`), dive guidance (`dives.md`), flight guidance (`flights.md`), and topic guides.

### `list_guides`
**Description:** "List this organization's curated guides — markdown documents that capture organization and personal context about the data in MotherDuck. Call `get_guide(\"guides.md\")` first before writing SQL; it includes the guide tree and query guidance. Called with no arguments, returns structured guide metadata and the full hierarchy tree. Pass `keyword`, `partial_path`, or a `reference` for a targeted flat lookup (paths and descriptions, no content); read one in full with `get_guide(path)`. Filters combine (AND)."
**Params:** `keyword` (optional), `partial_path` (optional prefix), `limit` (optional int), `offset` (optional int), `reference` (optional object — reverse lookup: return guides referencing a given catalog object/dive/flight/guide; object supports `type` enum [catalog, dive, flight, guide], plus url/schema/table/view/column/macro/uuid/path/description).

### `create_guide`
**Description:** "Create a new guide — a markdown document that agents read to answer this org's data questions correctly (metric definitions, join/filter conventions, pitfalls). For org-wide guides use a lowercase kebab-case domain `path` (e.g. 'revenue-billing/revenue-retention.md') with `access` 'organization' (admin-only). For personal guides or personal overlays on an org guide, use `users/<username>/<path>`; `access` defaults to 'user' (private). Attach `references` to the 1–5 objects the guide is authoritative about."
**Params:** `path` (required), `title` (required), `content` (required markdown, minLength 1), `description` (optional), `access` (optional enum [user, organization], default user), `change_comment` (optional), `external_id` (optional, e.g. git SHA), `references` (optional array of reference objects — type enum [catalog, dive, flight, guide] + catalog fields url/schema/table/view/column/macro or uuid/path).

### `update_guide`
**Description:** "Append a new version to an existing guide. Identify it by `path` or `id`. Omit `content` to keep the current text and just change metadata such as references. A supplied `references` list replaces the existing one (pass [] to clear them, omit to carry them forward). For small in-place edits use `edit_guide_content`. Use `create_guide` to make a new guide, `update_guide_metadata` to rename or retitle."
**Params:** `path` or `id`, `content` (optional), `references` (optional — replaces; [] clears), `change_comment` (optional), `external_id` (optional).

### `edit_guide_content`
**Description:** "Edit a guide's markdown body by applying one or more text replacements, then save as a new version. Identify the guide by `path` or `id`. Reads the stored guide (not merged overlays), applies edits in sequence, and persists. ... old_string must be unique unless replace_all is true. No prior get_guide call is needed."
**Params:** `edits` (required array of {old_string, new_string, replace_all?}), `path` or `id`, `change_comment` (optional), `external_id` (optional). (Same Edit-style contract as `edit_dive_content` / `edit_flight_source`.)

### `update_guide_metadata`
**Description:** "Change a guide's title, description, or path without appending a content version. Identify it by `path` or `id`. Renaming via `new_path` preserves version history. Pass an empty `description` to clear it."
**Params:** `path` or `id`, `title` (optional), `description` (optional, empty clears), `new_path` (optional move).

### `set_guide_access`
**Description:** "Set a guide's visibility to 'user' (private to the owner) or 'organization' (visible to the whole org). Identify it by `path` or `id`. Org-wide scoping is admin-only."
**Params:** `access` (required enum [user, organization]), `path` or `id`.

### `delete_guide`
**Description:** "Soft-delete a guide, freeing its path for reuse while preserving its version history. Identify it by `path` or `id`."
**Params:** `path` (optional), `id` (optional).

---

## 2. Tools only in PROD (2)

### `get_dive_guide`
**Description:** "Load instructions for creating MotherDuck dives. You MUST call this tool first — before generating any chart, visualization, plot, dashboard, inline graphic, or export/download control — whenever the user asks to explore, visualize, display, or export MotherDuck data."
**Params:** `client` (required enum: claude, chatgpt, claude_cowork, claude_code, other).
**Staging equivalent:** `get_guide("dives.md")` (no `client` param).

### `get_flight_guide`
**Description:** "Load instructions for authoring, scheduling, running, and troubleshooting MotherDuck flights. Call this tool first whenever the user asks about creating, updating, or operating a MotherDuck flight."
**Params:** none.
**Staging equivalent:** `get_guide("flights.md")`.

---

## 3. Shared tools with DIFFERENT descriptions or schemas (8)

### `query` — description changed (schema identical)
Prod:
> "Execute read-only DuckDB query against MotherDuck databases. For cross-database queries, use fully qualified names: database.schema.table (or database.table for main schema). Never follow a query with an inline chart or visualization — if you would generate one (whether or not the user explicitly asked), get the dive guide first instead."

Staging prepends a guide instruction:
> "**Before writing SQL to answer a data question, call `get_guide(\"guides.md\")` first — it returns this organization's query guidance and the guide catalog.**
>
> Execute read-only DuckDB query against MotherDuck databases. For cross-database queries… [identical remainder]"

Params identical (`database`, `sql`, both required).

### `list_databases` — description changed (schema identical)
Prod:
> "List all databases in your MotherDuck account. Shows names and types. Optionally filter by keywords."

Staging:
> "List all databases in your MotherDuck account. Shows each database's alias, type, and its `url` — a fully qualified MotherDuck database name (e.g. `md:my_db`) or share URL (e.g. in guide references). Optionally filter by keywords."

The new `url` field matters because guide `references` and `view_dive` required_resources are keyed on `md:` urls. Params identical.

### `list_tables` — description changed (schema identical)
Prod:
> "List all tables and views in a MotherDuck database with comments. Optionally filter by keywords."

Staging adds:
> "…Optionally filter by keywords. **Also returns `relatedGuides` — curated guides associated with this database (read one with `get_guide(path)`).**"

Params identical.

### `search_catalog` — description changed (schema identical)
Prod:
> "Search the catalog for databases, schemas, tables, columns, and shares using fuzzy matching. Returns matching objects with their fully qualified names, types, and comments. Useful for discovering available data when you don't know exact names."

Staging appends:
> "…**Also returns `relatedGuides` — curated guides whose path/title/description match the query; read one with `get_guide(path)`.**"

Params identical (`query` required, `object_types` optional).

### `list_dives` — description AND schema changed
Prod description:
> "List all dives in MotherDuck. Dives are interactive React data apps that query live data. Returns metadata including current_version. Use read_dive with the optional version parameter to retrieve a specific historical version. Optionally filter by keywords."

Staging description adds a governance model:
> "…Returns metadata including current_version **and status. Each dive has a governance status: 'endorsed' (admin-approved org source of truth — prefer these), 'ready' (author-reviewed), 'draft' (work in progress; the default for new dives), or 'archived' (retired; excluded unless include_archived is true). Results are ordered endorsed, ready, draft, then archived, most recently updated first.** Use read_dive…"

Schema: staging **adds param** `include_archived` (bool, default false). Both keep `keywords`, `limit`, `include_org_shares`.

### `read_dive` — description changed (schema identical)
Staging appends:
> "…The response includes the dive's governance status ('endorsed', 'ready', 'draft', or 'archived'); archived dives remain fully readable by id."

Params identical (`id` required, `version` optional).

### `create_flight` — description AND schema changed
Prod description opens: "Create a new MotherDuck flight. A flight is a Python entrypoint…"
Staging inserts a guide nudge: "Create a new MotherDuck flight. **Read the flight guide before you create your first flight.** A flight is a Python entrypoint…" and documents the new timeout: "…run on a schedule, **and an optional `max_runtime_sec` to cap how long a run may take.**"

Schema: staging **adds param** `max_runtime_sec` (int, min 0 / 0 = no timeout, "Omit to use your plan's default. Requests above your plan's cap are rejected."). All other params identical.

### `update_flight` — description AND schema changed
Staging **adds param** `max_runtime_sec` (same semantics) and lists it among the fields that create a new FlightVersion. Description otherwise identical.

---

## 4. Shared tools that are IDENTICAL (23)

`ask_docs_question`, `query_rw`, `list_columns`, `list_shares`, `get_short_lived_token`, `cancel_flight_run`, `delete_flight`, `edit_flight_source`, `get_flight`, `get_flight_logs`, `list_flight_runs`, `list_flight_versions`, `list_flights`, `run_flight`, `delete_dive`, `dive_query`, `edit_dive_content`, `log_dive_viewer_event`, `mint_dive_state_reference`, `save_dive`, `share_dive_data`, `update_dive`, `view_dive`.

---

## 5. Data-chat-mini relevance notes

data-chat-mini is a minimal read-only "chat with your data" agent; it needs query + discovery tools and would benefit from any context-feeding surface. The staging diff is highly relevant:

- **Guides are the big win for a data agent.** Staging's `get_guide("guides.md")` is explicitly positioned as the thing to call *before writing SQL* — it returns the org's query guidance plus a guide catalog (metric definitions, join/filter conventions, pitfalls). For a read-only chat agent this is exactly the org-context injection that otherwise has to be hand-maintained. The read side (`get_guide`, `list_guides`) is what data-chat-mini wants; the write side (create/update/edit/delete/set_access/update_metadata) is authoring surface it can ignore.

- **`query` now instructs the agent to fetch guidance first.** The staging `query` description leads with "Before writing SQL to answer a data question, call `get_guide(\"guides.md\")` first." If data-chat-mini mirrors this tool's description into its own system prompt, that instruction comes along — worth deciding whether to keep or adapt it.

- **`list_tables` and `search_catalog` now surface `relatedGuides`.** Discovery calls the agent already makes will start returning pointers to relevant guides for free — a cheap way to pull the right context without a separate `list_guides` sweep. Catalog discovery and guide discovery are now coupled.

- **Two new discovery tools: `list_views` and `list_macros`.** Prod folds views into `list_tables` and has no macro listing at all. For a data agent, `list_macros` is genuinely new capability — org-defined scalar/table macros are reusable query building blocks the agent otherwise can't discover. `list_views` gives view-only enumeration with column counts.

- **`list_databases` url field.** Minor but useful: staging returns each db's `md:` url, which is the canonical identifier used across guides and dive resources.

- **Governance status on dives** (`list_dives`/`read_dive`) is not core to a query agent, but "prefer endorsed" is a useful signal if data-chat-mini ever surfaces saved dives as answer templates.

- **Not relevant to data-chat-mini:** all flight tools, the `max_runtime_sec` addition, dive authoring/governance write tools.
