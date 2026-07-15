# data-chat-mini

A minimal **chat with your data** app for MotherDuck — distilled from the
internal `mdw-turbo` tool down to just the chat panel. Ask questions in natural
language; the agent explores the schema, runs **read-only** SQL over MCP, and
renders answers as inline [mviz](https://www.npmjs.com/package/mviz) charts and
tables. Conversation history lives in your browser (IndexedDB); durable context
lives in MotherDuck's versioned **guides** subsystem.

> Experimental. Part of [MotherDuck Labs](../../README.md).

## What it demonstrates

Each required element of an agentic data-chat app, kept as small as possible:

| Element | Where |
|---|---|
| Database with data (MotherDuck) | MCP `query` + catalog tools; production PAT |
| Interact with the DB (MCP) | `lib/mcp-client.ts` — StreamableHTTP MCP client, read-only allowlist |
| Visual request / tool calls / response | `app/chat/ChatPanel.tsx` — SSE stream, inline content segments |
| Fast charting | `lib/mviz-*.ts` + `app/components/MvizFrame.tsx` (mviz 1.7.0, embed mode) |
| History | `lib/chat-storage.ts` (IndexedDB) + `ChatHistorySidebar` |
| Context | MCP guides + `app/api/guides`; IndexedDB context remains only for the legacy demo replay |
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

- **`MOTHERDUCK_TOKEN`** — a production MotherDuck **user-scoped PAT** (Settings → Tokens). The username claim is needed to create personal guides. Data access stays read-only because `query_rw` is never exposed.
- **`OPENROUTER_API_KEY`** — the LLM is called via OpenRouter (default model `google/gemini-3-flash-preview`, swap with `OPENROUTER_MODEL`).
- **`MOTHERDUCK_API_URL`** — defaults to production (`https://api.motherduck.com`). Override it only for explicit staging tests, using a token from the same environment.

Pick a database, then ask away — e.g. *"what tables are here?"*, *"chart revenue by
month"*, *"remember that orders join customers on customer_id"*.

## Deploy (Vercel)

The app is a self-contained Next.js project — deploy it straight from this
subdirectory.

1. **Root Directory** → set to `projects/data-chat-mini` in the Vercel project
   settings (the repo root is a monorepo with no top-level `package.json`).
   Deploying from inside this folder with the CLI handles this automatically.
2. **Environment variables** (Production): `MOTHERDUCK_TOKEN`,
   `OPENROUTER_API_KEY`, and `OPENROUTER_MODEL` (optional). Production is the
   built-in MotherDuck API default; setting
   `MOTHERDUCK_API_URL=https://api.motherduck.com` explicitly is harmless.
3. **Protect the deployment.** This app has **no application-level auth** and
   uses one server-side PAT for every visitor. An open URL therefore exposes the
   PAT owner's catalog and personal guides, and lets visitors spend the shared
   OpenRouter budget. Turn on Vercel **Deployment Protection → Password
   Protection** with scope **All Deployments** (not just Preview) before sharing
   the URL.
4. **Use a user-scoped PAT** for `MOTHERDUCK_TOKEN`. The username claim enables
   personal guide creation. Data remains read-only at the MCP boundary: the app
   allowlists `query` and never advertises or dispatches `query_rw`. Guide writes
   are separately constrained to `users/<username>/...` paths.
5. **Function timeout / plan.** `app/api/chat/route.ts` sets `maxDuration = 300`
   for the streaming agentic loop. Vercel Hobby clamps functions to ~60s
   (long turns get cut off); Pro / Fluid Compute honors 300s. A single MCP query
   is independently capped by MotherDuck at ~55s.

```bash
# from projects/data-chat-mini/
npx vercel link            # create/link the project
npx vercel env add MOTHERDUCK_TOKEN production   # repeat per required var
npm run mcp:validate                            # validate the production contract
npx vercel deploy --prod
```

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
- **Token and session model.** Production uses a user-scoped PAT so guide writes
  have an authenticated owner. Each browser still gets a random session id
  (localStorage), passed as `session_name` for cache affinity when supported by
  the MCP transport. A read scaling token can be substituted for read-only
  deployments, but it may not support personal guide creation.
- **Context = MotherDuck guides.** The model reads `guides.md` before SQL and can
  read relevant org/personal guides, then persist durable learnings as small
  personal guides. The guide manager uses `/api/guides` for viewing, editing,
  history, and deletion. The old IndexedDB context-tool round trip remains only
  to support the recorded demo until it is re-recorded.
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

Canvas, prism, dives, data writes, the HMAC/ledger confirmation handshake, chat
sharing, compaction, server-side chat history, and OAuth/multi-identity auth.
This is a protected single-identity deployment; Vercel deployment protection is
the application access boundary.
