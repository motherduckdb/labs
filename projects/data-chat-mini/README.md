# data-chat-mini

A minimal **chat with your data** app for MotherDuck — distilled from the
internal `mdw-turbo` tool down to just the chat panel. Ask questions in natural
language; the agent explores the schema, runs **read-only** SQL over MCP, and
renders answers as inline [mviz](https://www.npmjs.com/package/mviz) charts and
tables. Conversation history and a local context layer live in your browser
(IndexedDB). It's built to run a **large fleet of concurrent users** on a single
MotherDuck **read scaling token**.

> Experimental. Part of [MotherDuck Labs](../../README.md).

## What it demonstrates

Each required element of an agentic data-chat app, kept as small as possible:

| Element | Where |
|---|---|
| Database with data (MotherDuck) | MCP `query` + catalog tools; read scaling token |
| Interact with the DB (MCP) | `lib/mcp-client.ts` — StreamableHTTP MCP client, read-only allowlist |
| Visual request / tool calls / response | `app/chat/ChatPanel.tsx` — SSE stream, inline content segments |
| Fast charting | `lib/mviz-*.ts` + `app/components/MvizFrame.tsx` (mviz 1.7.0, embed mode) |
| History | `lib/chat-storage.ts` (IndexedDB) + `ChatHistorySidebar` |
| Context | `lib/context-store.ts` (IndexedDB) behind MotherDuck context-tool shapes |
| Schema explorer | `app/chat/SchemaExplorerSidebar.tsx` + `app/api/schema` |
| System prompt (the "intelligence") | `lib/system-prompt.ts` — when to explore, when to chart, read-only |
| Tool guardrails | `lib/mcp-client.ts` — READONLY / MUTATING / DESTRUCTIVE classification |
| Telemetry | `lib/controllog.ts` → labs [`controllog`](../controllog) + [`controllog-viz`](../controllog-viz) |

## Run

```bash
npm install
cp .env.example .env.local   # fill in MOTHERDUCK_TOKEN + OPENROUTER_API_KEY
npm run dev                  # http://localhost:3000
```

- **`MOTHERDUCK_TOKEN`** — a MotherDuck **read scaling token** (Settings → Tokens). Read-only by nature; safe for a fleet.
- **`OPENROUTER_API_KEY`** — the LLM is called via OpenRouter (default model `google/gemini-3-flash-preview`, swap with `OPENROUTER_MODEL`).
- **`MOTHERDUCK_API_URL`** — defaults to staging; set to `https://api.motherduck.com` for prod.

Pick a database, then ask away — e.g. *"what tables are here?"*, *"chart revenue by
month"*, *"remember that orders join customers on customer_id"*.

## Demo Mode

The picker includes a presenter-ready **Demo Mode** for the canonical
`nba_box_scores_v2` workshop. Use **Replay demo** to run the full guided flow
without MotherDuck or OpenRouter tokens; it replays the deterministic validation
transcript, including tool timeline entries and rendered mviz artifacts. Use
**Live demo** to run the same prompts against real tokens.

The guided rail covers:

- picking `nba_box_scores_v2`
- inspecting schema and saving the schedule join as local durable context
- asking the adversarial team-grain question
- charting with the saved grain rule
- refusing unsupported injury analysis
- resetting browser-local conversations and context for the next workshop run

## How it works

- **MCP, read-only.** `query`, `list_databases`, `list_tables`, `list_columns`,
  `search_catalog`, `ask_docs_question` are the entire allowlist. `query_rw`,
  dives, and MotherDuck context writes are *classified but not allowed* — they're
  rejected before execution. The guardrail layer is the named boundary; re-enabling
  a write means adding it to the allowlist **and** restoring a confirmation
  handshake.
- **Read scaling fan-out.** A [read scaling token](https://motherduck.com/docs/key-tasks/authenticating-and-connecting-to-motherduck/read-scaling/)
  directs each connection to one of the read replicas, so concurrent users
  spread across the fleet on a single token. Each browser also gets a random
  session id (localStorage), passed as `session_name` (the canonical param;
  `session_hint` is its legacy alias) for per-session replica cache affinity.
  Note: `session_name` affinity is documented for the DuckDB/Postgres
  connection strings, not (yet) the MCP HTTP transport — we pass it on the MCP
  URL, honored if forwarded, harmless if not. The token-level fan-out works
  regardless.
- **Context = local IndexedDB behind MotherDuck tool shapes.** The model calls
  `query_context_layer` / `update_context_layer` (the real MotherDuck names), but
  those calls are intercepted server-side, streamed to the browser as a
  `context_tool` event, serviced against IndexedDB, and the loop resumes with the
  result. Swappable to the real MotherDuck context layer later by simply not
  intercepting.
- **mviz inline.** The model emits ` ```table ` / ` ```bar ` / ` ```line ` /
  ` ```dumbbell ` fenced blocks; a streaming fence detector renders each into a
  sandboxed iframe at its natural position in the reply.

## Telemetry (controllog)

Every model prompt/completion and tool call is written as spec-compliant JSONL to
`logs/controllog/{events,postings}.jsonl` (disable with
`NEXT_PUBLIC_DISABLE_LOGGING=1`). To review runs, hand off to the labs Python
tooling:

```bash
pip install "controllog[duckdb] @ git+https://github.com/motherduckdb/labs#subdirectory=projects/controllog"
python -c "from controllog import motherduck; from pathlib import Path; \
  motherduck.upload(motherduck_db='data_chat_mini', log_dir=Path('logs'))"
```

Then point [`controllog-viz`](../controllog-viz) at that database for the per-run
conversation explorer and cost/latency/token rollups. (The emitter uses the
spec's `truth.money` / `truth.time` account names so those rollups are correct.)

## Demo validation

`nba_box_scores_v2` is the canonical demo dataset. Run the repeatable harness
with no external tokens:

```bash
npm run demo:validate
```

It writes a concise latest report plus full JSON artifacts under
`reports/demo-validation/`, covering database selection, schema browsing,
Demo Mode, replay mapping, guided prompt insertion, reset behavior, context
lifecycle, adversarial grain/unsupported-field questions, conversation reopen,
database switching, tool visibility, and mviz table/chart rendering.
Optional live mode is available with
`npm run demo:validate:live` when `MOTHERDUCK_TOKEN` and `OPENROUTER_API_KEY`
are present. See [docs/demo-validation.md](docs/demo-validation.md).

## Out of scope

Canvas, prism, dives, MotherDuck-side writes, the HMAC/ledger confirmation
handshake, chat sharing, compaction, server-side chat history, and OAuth/multi-
identity auth — a single read scaling token + per-session id replaces auth.
