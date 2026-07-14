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
| Context | Local IndexedDB behind invented `query_context_layer` / `update_context_layer` tool *shapes* — an interception, not a real write (no such tools exist on the live MCP server) | Real MotherDuck **guides**: `list_guides` / `get_guide` / `create_guide` / `update_guide` are allowlisted in `src/core/mcp-client.ts`, and a saved convention becomes a guide under `users/<bot user>/quackbot/` — durable and visible to every future conversation, not just other tabs in one browser |
| Charts | Sandboxed iframe (`MvizFrame.tsx`) | mviz embed HTML rendered by headless Chromium (`src/slack/screenshot.ts`) and uploaded as a PNG into the thread |
| Tables | Same sandboxed iframe | Native Slack `markdown` block — a real GFM table (`src/slack/viz.ts` classifies the fence, `src/slack/markdown.ts` builds the block) |
| Streaming / turn events | SSE frames to the browser (`lib/sse-encoder.ts`) | A `TurnSink` interface (`src/core/turn-sink.ts`) the agentic loop calls directly; `src/slack/sink.ts`'s `SlackTurnSink` repaints one placeholder message with `chat.update`, throttled to roughly one repaint per 1.5s, splitting into continuation messages once a render exceeds Slack's block-size caps |
| System prompt | `lib/system-prompt.ts` | `src/core/system-prompt.ts` — same read-only analyst persona, reworded for Slack threads and image-based charts |
| Tool guardrails | READONLY / MUTATING / DESTRUCTIVE classification (`lib/mcp-client.ts`) | Same classification (`src/core/mcp-client.ts`); guide reads join the allowlist as read-only, `create_guide` / `update_guide` as allowlisted (unconfirmed) writes gated by a path guard to the bot's own `users/<bot user>/quackbot/` folder — `query_rw`, `delete_dive`, and `delete_guide` stay classified but never allowlisted |
| Telemetry | `lib/controllog.ts` → labs `controllog` / `controllog-viz` | Same emitter, unchanged (`src/core/controllog.ts`), database name `quackbot` |
| Memorialization | — (dives out of scope) | MotherDuck Dives: `save_dive` create-only, Gemini-tuned interception of the dive-authoring guide (`get_guide("dives.md")`, `src/core/gemini-dive-guide.ts`), advisory react-hooks lint on saved source (`src/core/dive-linter.ts`) — ported from internal `mdw-turbo` |

## Setup

1. **Create the Slack app.** Go to [api.slack.com/apps](https://api.slack.com/apps)
   → **Create New App** → **From an app manifest**, pick your workspace, and
   paste in [`manifest.json`](./manifest.json). It's pre-configured for Socket
   Mode (no public URL needed) with the bot scopes and event subscriptions
   quackbot needs (`app_mention`, `message.im`, plus the two
   `assistant_thread_*` events for Slack's AI-assistant container).
   **Interactivity is on** — it powers the Approve/Deny buttons for durable-write
   confirmations (Socket Mode delivers the button clicks over the same
   websocket, so no request URL is needed). If you installed an earlier version
   with interactivity off, toggle **Interactivity & Shortcuts → on** (or
   re-apply the manifest), or guide/dive saves will time out and be declined.
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
- `@quackbot remember that orders.customer_id joins customers.id` — saves a durable convention as a MotherDuck guide via `create_guide`
- `@quackbot use database <name>` — switches which database(s) the channel queries by default (`src/store/settings.ts`)
- `@quackbot save that as a dive` — memorializes the thread's finding as a MotherDuck Dive (`save_dive`, create-only)

## Deploy (Fly.io)

quackbot runs on Fly as a plain worker — Socket Mode dials out to Slack, so
there's no inbound HTTP, no public URL, and no health-checked port. The
`Dockerfile` builds on the Playwright base image (pinned to the lockfile's
playwright version) so headless Chromium ships with the machine, and
`fly.toml` carries the non-secret config.

```bash
brew install flyctl && fly auth login   # once
cd projects/quackbot
fly apps create quackbot                # once; pick another name if taken and update fly.toml
```

Set the five secrets from your local `.env` (or type them out with
`fly secrets set KEY=value ...`):

```bash
grep -E '^(SLACK_BOT_TOKEN|SLACK_APP_TOKEN|MOTHERDUCK_TOKEN|OPENROUTER_API_KEY|DATABASE_URL)=' .env | fly secrets import
```

If you're pointing at a fresh Postgres instead of reusing the dev one, apply
the migration first (`psql $DATABASE_URL -f migrations/001_init.sql`). Then:

```bash
fly deploy --ha=false
fly logs   # look for "[quackbot] running (Socket Mode)"
```

Two operational caveats, both consequences of Socket Mode:

- **Run exactly one machine** (`--ha=false`, and don't `fly scale count` up).
  Slack load-balances events across every open Socket Mode connection, and the
  per-thread mutex + event dedupe in `src/slack/handlers.ts` are per-process —
  two machines would each handle a random half of the traffic.
- **Stop `npm run dev` locally while the Fly machine is up** (or vice versa)
  for the same reason: a local dev process and the deployed one count as two
  connections, and messages will land on whichever Slack picks.

Telemetry note: controllog JSONL lands on the machine's ephemeral disk
(`logs/controllog/`) and is lost on redeploy — fine for now; add a Fly volume
or a periodic upload if that starts to matter.

## Security & data boundaries

Now that the bot is cloud-hosted, everyone who can message it is an untrusted
input source, and so is the content of any database row it reads (a value can
carry injected instructions). The boundaries that matter:

- **The MotherDuck token's grants are the tenancy wall.** Every query runs
  under one shared `MOTHERDUCK_TOKEN`; there is no per-user impersonation (the
  sibling `superduck` bot makes the same tradeoff — real per-user OAuth would
  need a public callback endpoint a Socket Mode bot can't host). A user can
  `use db <anything>` or coax the model toward another database, but the token
  can only ever reach databases it was actually granted — `ATTACH` doesn't
  widen that, it just names an already-granted database. **So the operative
  rule is: only grant the bot's MotherDuck account databases that are OK for
  every Slack user who can reach it.** There is no per-channel data isolation.
- **`QUACKBOT_DATABASES` is an optional hard cap** (defense-in-depth). When
  set, a tool call whose `database` argument is outside the list is rejected at
  dispatch (`databaseAllowViolation` in `src/core/mcp-client.ts`), and `use db`
  refuses un-listed names. Unset ⇒ no restriction and the token grants remain
  the only boundary. It gates the explicit `database` arg, not a fully-qualified
  `db.schema.table` buried in SQL — the token grant still covers that.
- **Durable writes are confirmed, then confined.** The only mutating tools the
  model can reach are `create_guide` / `update_guide` / `save_dive`; `query_rw`
  and every delete/edit tool are blocked at the allowlist and can never run,
  even under a fully hijacked model. Each allowed write now pauses for an
  Approve/Deny click from the **initiating user** before it runs
  (`src/slack/confirm.ts` + `requiresConfirmation`) — so prompt-injected content
  can *propose* a write but can't commit one unattended. Deny, timeout (2 min),
  or a failed prompt-post all fail closed (no write). Behind that, the writes
  stay confined: guide paths are guarded to the bot's own
  `users/<bot>/quackbot/` folder (the guard rejects `..`, percent-encoded, and
  Unicode traversal) and `save_dive` is create-only with a fresh id.
- **Chart rendering is network-isolated.** Chart specs are attacker-influenced,
  so the headless-Chromium screenshot path denies all egress except the Google
  Fonts the self-contained embed needs, and the spec sanitizer strips raw-JS
  option keys and neutralizes `</script>` breakout — no SSRF/exfil even if
  injected markup runs (`src/slack/screenshot.ts`, `src/core/mviz-processor.ts`).
- **Secrets** never reach logs, prompts, Slack, or rendered output; `.env` is
  git- and docker-ignored and not baked into any image layer. Postgres always
  connects over verified TLS (`resolvePoolConfig` in `src/store/pg.ts`).

## How it works

Turn flow, one Slack message at a time (`src/slack/handlers.ts`'s `buildTurnRunner`):

1. An `app_mention` or a DM `message` event reaches the Socket Mode handler. Events are deduped on `(channel, ts)` (Slack redelivers on retry, and a DM @-mention can fire both `message.im` and `app_mention`), and a per-`(channel, thread_ts)` mutex means at most one turn runs per thread at a time — a message that arrives mid-turn gets an :hourglass_flowing_sand: reaction and a "still working" reply instead of queuing.
2. A `use db <name>[, <name>…]` message is intercepted before any LLM call and just updates `channel_settings` (`src/store/settings.ts`) — no model turn.
3. Otherwise the bot reacts :eyes: to the triggering message, loads the conversation from Postgres by `(channel, thread_ts)`, and posts a placeholder reply ("_:duck: on it…_").
4. An MCP client connects to MotherDuck with `${channel}:${thread_ts}` as the `session_name` hint, for read-scaling replica affinity (`src/core/mcp-client.ts`'s `createMCPClient`).
5. The agentic loop (`src/core/agentic-loop.ts`) runs against that MCP client and the Slack-specific system prompt (`src/core/system-prompt.ts`), driving a `TurnSink` instead of an SSE stream. `src/slack/sink.ts`'s `SlackTurnSink` implements it: text/thinking/tool-status deltas repaint the placeholder via `chat.update`, throttled to roughly one repaint per 1.5s; a completed ` ```table ` fence splices in as a native Slack `markdown` block inline (`src/slack/viz.ts` + `src/slack/markdown.ts`); a completed chart fence (`bar` / `line` / `dumbbell`) renders to a PNG through headless Chromium and uploads as its own thread message (`src/slack/screenshot.ts` + `files.uploadV2`); guide tool calls (`list_guides` / `get_guide` / `create_guide` / `update_guide`) dispatch straight through MCP like any other allowlisted tool — the agentic loop's own comment header notes data-chat-mini's `'context_pause'` finish reason "no longer exists" here, since nothing pauses for a browser round-trip.
6. If the thread is a Slack AI-assistant container, the sink also calls `assistant.threads.setStatus` with the current tool verb (e.g. "running query…") — best-effort, and silently disabled the first time it's unsupported (plain channels/DMs never call it).
7. On finish, the sink paints its final render, the updated message array is saved back to Postgres, the controllog session for the turn is flushed to `logs/controllog/*.jsonl`, and the :eyes: reaction swaps to :white_check_mark: or :warning:.

**The context-layer swap.** data-chat-mini's README describes its local-IndexedDB
context interception as "swappable to the real MotherDuck context layer later
by simply not intercepting." It turns out no `query_context_layer` /
`update_context_layer` tools exist on the live MCP server — those shapes were
data-chat-mini's invention. What the server does expose is **guides** (durable
markdown documents with list/get/create/update CRUD), and quackbot's memory
layer is built on them directly: "remember that…" becomes a `create_guide`
under the bot's personal `users/<bot user>/quackbot/` folder (one atomic
convention per guide), Step 0 of every data turn is a `list_guides` read, and
a convention saved from one Slack thread is durable and visible to every other
conversation. A code-level path guard (`GUIDE_WRITE_PATH` in
`src/core/mcp-client.ts`) confines the two allowlisted guide writes to that
folder, and `create_guide` is collision-safe server-side — a duplicate path
errors instead of overwriting.

**Memorializing discoveries as Dives.** When a user explicitly asks to save a
finding ("save that as a dive"), the model fetches the dive-authoring guide
via `get_guide("dives.md")`, composes a Dive from the thread's validated SQL, and
calls `save_dive` — create-only, so it can never clobber an existing dive
(`edit_dive_content` / `update_dive` / `delete_dive` / `share_dive_data` stay
blocked; see Out of scope). Two pieces ported from the internal `mdw-turbo`
implementation: on Gemini model profiles the agentic loop intercepts the
dive-guide read (`get_guide` with path `dives.md` — the server retired the
older `get_dive_guide` tool) and serves a Gemini-tuned guide
(`src/core/gemini-dive-guide.ts` — the stock guide produced
a 30–42% dive-write failure rate on Gemini), and every saved dive's source
gets an advisory react-hooks lint (`src/core/dive-linter.ts`) folded into the
tool result so the model can self-correct without blocking the save.

**Token caveat.** `create_guide`, `update_guide`, and `save_dive` are writes.
A MotherDuck read-scaling token (the kind data-chat-mini uses, read-only by
design) may reject them — use a standard write-capable PAT for
`MOTHERDUCK_TOKEN`. With a non-admin PAT the server confines guide writes to
the bot user's personal namespace (`users/<bot user>/…`), which is exactly
where quackbot's own path guard points them anyway.

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
in a channel shares it; the token's grants are the tenancy boundary, see
[Security & data boundaries](#security--data-boundaries)), Dive *mutation* (`edit_dive_content`,
`update_dive`, `delete_dive`, `share_dive_data` are classified but never
allowlisted — creation can't clobber an existing dive, edits to a
caller-supplied id can, and there's no confirmation UI to gate that), guide
mutation outside the bot's own folder (`edit_guide_content`,
`update_guide_metadata`, `set_guide_access`, `delete_guide` are classified but
never allowlisted, and the allowlisted guide writes are path-guarded to
`users/<bot user>/quackbot/`), canvas, `query_rw` (classified but never
allowlisted), and DM-vs-channel permission separation (a DM and a channel
mention are handled the same way once the message reaches the loop). Slack
Enterprise Grid specifics (org-wide app install, Grid-level tokens) are
untested.
