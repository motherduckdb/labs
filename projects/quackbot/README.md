# quackbot

A Slack bot that ports [data-chat-mini](../data-chat-mini)'s **chat with your
data** agent to Slack as the interface: read-only MotherDuck SQL over MCP,
[mviz](https://www.npmjs.com/package/mviz) charts rendered as PNGs, native
Slack tables, a MotherDuck context layer, Postgres-backed conversation state,
and controllog telemetry.

> Experimental. Part of [MotherDuck Labs](../../README.md).

## What it demonstrates

Same required elements as data-chat-mini, mapped onto Slack:

| Element | data-chat-mini | quackbot |
|---|---|---|
| Interface | Next.js chat panel, SSE to the browser | Slack thread, via `@slack/bolt` Socket Mode (`src/slack/app.ts`, `src/slack/handlers.ts`) |
| History | Browser-local IndexedDB | Postgres, keyed by `(channel, thread_ts)` (`src/store/conversations.ts`) |
| Context | Local IndexedDB behind MotherDuck's `query_context_layer` / `update_context_layer` tool *shapes* — an interception, not a real write | The real MotherDuck MCP context layer: both tools are allowlisted directly in `src/core/mcp-client.ts`, so a saved fragment is durable and visible to every future conversation, not just other tabs in one browser |
| Charts | Sandboxed iframe (`MvizFrame.tsx`) | mviz embed HTML rendered by headless Chromium (`src/slack/screenshot.ts`) and uploaded as a PNG into the thread |
| Tables | Same sandboxed iframe | Native Slack `markdown` block — a real GFM table (`src/slack/viz.ts` classifies the fence, `src/slack/markdown.ts` builds the block) |
| Streaming / turn events | SSE frames to the browser (`lib/sse-encoder.ts`) | A `TurnSink` interface (`src/core/turn-sink.ts`) the agentic loop calls directly; `src/slack/sink.ts`'s `SlackTurnSink` repaints one placeholder message with `chat.update`, throttled to roughly one repaint per 1.5s, splitting into continuation messages once a render exceeds Slack's block-size caps |
| System prompt | `lib/system-prompt.ts` | `src/core/system-prompt.ts` — same read-only analyst persona, reworded for Slack threads and image-based charts |
| Tool guardrails | READONLY / MUTATING / DESTRUCTIVE classification (`lib/mcp-client.ts`) | Same classification (`src/core/mcp-client.ts`); `query_context_layer` also joins the allowlist as read-only, `update_context_layer` as an allowlisted (unconfirmed) write — `query_rw` and `delete_dive` stay classified but never allowlisted |
| Telemetry | `lib/controllog.ts` → labs `controllog` / `controllog-viz` | Same emitter, unchanged (`src/core/controllog.ts`), database name `quackbot` |
| Memorialization | — (dives out of scope) | MotherDuck Dives: `save_dive` create-only, Gemini-tuned `get_dive_guide` interception (`src/core/gemini-dive-guide.ts`), advisory react-hooks lint on saved source (`src/core/dive-linter.ts`) — ported from internal `mdw-turbo` |

## Setup

1. **Create the Slack app.** Go to [api.slack.com/apps](https://api.slack.com/apps)
   → **Create New App** → **From an app manifest**, pick your workspace, and
   paste in [`manifest.json`](./manifest.json). It's pre-configured for Socket
   Mode (no public URL needed) with the bot scopes and event subscriptions
   quackbot needs (`app_mention`, `message.im`, plus the two
   `assistant_thread_*` events for Slack's AI-assistant container).
   Interactivity is off — there's no button/interactive-message flow in v1
   (see [Out of scope](#out-of-scope)).
2. **Install the app to your workspace**, then collect two tokens:
   - **`SLACK_BOT_TOKEN`** — OAuth & Permissions → Bot User OAuth Token
     (`xoxb-...`).
   - **`SLACK_APP_TOKEN`** — Basic Information → App-Level Tokens → create
     one with the `connections:write` scope (`xapp-...`). This is what Socket
     Mode uses instead of a public URL.
3. **Copy `.env.example` to `.env`** and fill in each value — every var has a
   comment explaining it, including the `MOTHERDUCK_TOKEN` caveat (see
   [How it works](#how-it-works)).
4. **Provision Postgres and apply the migration.** quackbot expects a
   connection string in `DATABASE_URL` (built against PlanetScale Postgres,
   TLS required); anything `pg` can reach over TLS should work.
   ```bash
   psql $DATABASE_URL -f migrations/001_init.sql
   ```
   This creates two tables: `conversations` (message history keyed by
   `(channel, thread_ts)`) and `channel_settings` (per-channel database
   overrides).
5. **Install a headless browser for chart rendering.**
   ```bash
   npx playwright install chromium
   ```
   Slack can't render the mviz iframe directly, so `src/slack/screenshot.ts`
   renders the same embed HTML data-chat-mini shows in-browser through
   headless Chromium and uploads a PNG instead.

## Run

```bash
npm install
cp .env.example .env   # if you haven't already — fill in the values from Setup
npm run dev
```

Invite the bot to a channel (or DM it), then:

- `@quackbot what tables are in <database>?` — schema exploration
- `@quackbot chart revenue by month` — a `bar`/`line` fence, rendered as a PNG in the thread
- `@quackbot remember that orders.customer_id joins customers.id` — saves a durable context fragment via `update_context_layer`
- `@quackbot use database <name>` — switches which database(s) the channel queries by default (`src/store/settings.ts`)
- `@quackbot save that as a dive` — memorializes the thread's finding as a MotherDuck Dive (`save_dive`, create-only)

## How it works

Turn flow, one Slack message at a time (`src/slack/handlers.ts`'s `buildTurnRunner`):

1. An `app_mention` or a DM `message` event reaches the Socket Mode handler. Events are deduped on `(channel, ts)` (Slack redelivers on retry, and a DM @-mention can fire both `message.im` and `app_mention`), and a per-`(channel, thread_ts)` mutex means at most one turn runs per thread at a time — a message that arrives mid-turn gets an :hourglass_flowing_sand: reaction and a "still working" reply instead of queuing.
2. A `use db <name>[, <name>…]` message is intercepted before any LLM call and just updates `channel_settings` (`src/store/settings.ts`) — no model turn.
3. Otherwise the bot reacts :eyes: to the triggering message, loads the conversation from Postgres by `(channel, thread_ts)`, and posts a placeholder reply ("_:duck: on it…_").
4. An MCP client connects to MotherDuck with `${channel}:${thread_ts}` as the `session_name` hint, for read-scaling replica affinity (`src/core/mcp-client.ts`'s `createMCPClient`).
5. The agentic loop (`src/core/agentic-loop.ts`) runs against that MCP client and the Slack-specific system prompt (`src/core/system-prompt.ts`), driving a `TurnSink` instead of an SSE stream. `src/slack/sink.ts`'s `SlackTurnSink` implements it: text/thinking/tool-status deltas repaint the placeholder via `chat.update`, throttled to roughly one repaint per 1.5s; a completed ` ```table ` fence splices in as a native Slack `markdown` block inline (`src/slack/viz.ts` + `src/slack/markdown.ts`); a completed chart fence (`bar` / `line` / `dumbbell`) renders to a PNG through headless Chromium and uploads as its own thread message (`src/slack/screenshot.ts` + `files.uploadV2`); context-layer tool calls (`query_context_layer` / `update_context_layer`) dispatch straight through MCP like any other allowlisted tool — the agentic loop's own comment header notes data-chat-mini's `'context_pause'` finish reason "no longer exists" here, since nothing pauses for a browser round-trip.
6. If the thread is a Slack AI-assistant container, the sink also calls `assistant.threads.setStatus` with the current tool verb (e.g. "running query…") — best-effort, and silently disabled the first time it's unsupported (plain channels/DMs never call it).
7. On finish, the sink paints its final render, the updated message array is saved back to Postgres, the controllog session for the turn is flushed to `logs/controllog/*.jsonl`, and the :eyes: reaction swaps to :white_check_mark: or :warning:.

**The context-layer swap.** data-chat-mini's README describes its local-IndexedDB
context interception as "swappable to the real MotherDuck context layer later
by simply not intercepting." quackbot is that swap: `query_context_layer` and
`update_context_layer` are allowlisted directly in `src/core/mcp-client.ts`
and dispatch to the real MCP tools, so a fragment saved from one Slack thread
is durable and visible to every other conversation — not just other tabs in
one browser.

**Memorializing discoveries as Dives.** When a user explicitly asks to save a
finding ("save that as a dive"), the model fetches the dive-authoring guide
via `get_dive_guide`, composes a Dive from the thread's validated SQL, and
calls `save_dive` — create-only, so it can never clobber an existing dive
(`edit_dive_content` / `update_dive` / `delete_dive` / `share_dive_data` stay
blocked; see Out of scope). Two pieces ported from the internal `mdw-turbo`
implementation: on Gemini model profiles the agentic loop intercepts
`get_dive_guide` and serves a Gemini-tuned guide
(`src/core/gemini-dive-guide.ts` — the stock guide's `other` variant produced
a 30–42% dive-write failure rate on Gemini), and every saved dive's source
gets an advisory react-hooks lint (`src/core/dive-linter.ts`) folded into the
tool result so the model can self-correct without blocking the save.

**Token caveat.** `update_context_layer` and `save_dive` are writes. A
MotherDuck read-scaling token (the kind data-chat-mini uses, read-only by
design) may reject them — a standard PAT might be required for
`MOTHERDUCK_TOKEN` instead. This hasn't been confirmed against a live token
yet; `.env.example` flags it, and it's worth checking on first run — if
context or dive saves fail, that's the first thing to try.

**Verification status.** The flow above is unit-tested (agentic-loop event
ordering, fence→Slack mapping, sink throttling/splitting, store round-trips)
and typechecks clean, but has not yet been exercised against a live Slack
workspace, MotherDuck token, or Postgres instance — treat the live smoke in
[Setup](#setup)/[Run](#run) as the remaining acceptance step.

## Telemetry (controllog)

Same emitter as data-chat-mini, unchanged (`src/core/controllog.ts`): every
model prompt/completion and tool call is written as spec-compliant JSONL to
`logs/controllog/{events,postings}.jsonl` (disable with
`NEXT_PUBLIC_DISABLE_LOGGING=1`). Hand off to the same labs Python tooling,
pointed at a `quackbot` database instead:

```bash
pip install "controllog[duckdb] @ git+https://github.com/motherduckdb/labs#subdirectory=projects/controllog"
python -c "from controllog import motherduck; from pathlib import Path; \
  motherduck.upload(motherduck_db='quackbot', log_dir=Path('logs'))"
```

Then point [`controllog-viz`](../controllog-viz) at that database for the
same per-run conversation explorer and cost/latency/token rollups.

## Out of scope

OAuth / multi-identity auth (the bot token is the only identity — every user
in a channel shares it), a confirmation handshake for the two allowlisted
writes (v1 lets `update_context_layer` and `save_dive` run unattended;
restoring confirmation means a Slack interactive-button flow, and
interactivity is off in the manifest), Dive *mutation* (`edit_dive_content`,
`update_dive`, `delete_dive`, `share_dive_data` are classified but never
allowlisted — creation can't clobber an existing dive, edits to a
caller-supplied id can, and there's no confirmation UI to gate that), canvas,
`query_rw` (classified but never allowlisted), and DM-vs-channel permission
separation (a DM and a channel mention are handled the same way once the
message reaches the loop). Slack Enterprise Grid specifics (org-wide app
install, Grid-level tokens) are untested.
