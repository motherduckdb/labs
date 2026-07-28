# quackbot-modal

A fork of [`quackbot`](../quackbot) that runs on **Modal** instead of Fly.io and
talks to **Modal's Kimi K3 Shared API** instead of OpenRouter. Same product:
a Slack bot that ports [data-chat-mini](../data-chat-mini)'s **chat with your
data** agent to Slack as the interface — read-only MotherDuck SQL over MCP,
[mviz](https://www.npmjs.com/package/mviz) charts rendered as PNGs, native
Slack tables, a MotherDuck context layer, Postgres-backed conversation state,
and controllog telemetry.

> Experimental. Part of [MotherDuck Labs](../../README.md). See `PLAN.md` for
> the full migration rationale; this README documents the code as it landed,
> which differs from the plan in a few places noted below.

## What changed from `quackbot` (Fly)

| | Fly (`quackbot`) | Modal (this project) |
|---|---|---|
| Hosting | Fly machine, one always-on process | Modal: an always-warm web endpoint + ephemeral per-turn workers |
| Ingress | Socket Mode (`@slack/bolt`, outbound websocket) | Slack HTTP Events API (`modal_app.py`'s `web`, a FastAPI ASGI app) |
| Turn execution | In-process, same Node event loop that received the event | `web` verifies the Slack signature, acks, and `run_turn.spawn()`s a subprocess (`node --import tsx src/worker.ts`) that runs exactly one turn and exits |
| LLM | OpenRouter, multi-provider | Modal's Shared API, hard-coded to `moonshotai/Kimi-K3` (`src/core/llm-client.ts`) |
| Cross-request state | In-process `Map`/`Set`/TTL cache | Postgres (`migrations/002_modal.sql`: `slack_events`, `confirmations`, `kv_cache`, `controllog_events`, `controllog_postings`) |
| Confirmation handshake | Same process posts the buttons and awaits the click | Split across two containers — see [Security & data boundaries](#security--data-boundaries) and `src/slack/confirm.ts`'s header |
| Telemetry | JSONL on local disk (`logs/controllog/`) | Postgres tables (`controllog_events` / `controllog_postings`) |
| Entrypoint | `src/main.ts` + `src/slack/app.ts` (deleted) | `src/worker.ts` — one Slack event envelope on stdin, one turn, exit |
| Deps | `@slack/bolt` | `@slack/web-api` only — Bolt is gone |

Modal caps a function's execution at 24 hours and has no supported always-on
outbound-websocket pattern, so Socket Mode had to go. That one change is what
forces the rest: an ephemeral per-turn process can't hold anything in memory
between turns, so every piece of cross-request state moved into Postgres.

## What it demonstrates

Same required elements as data-chat-mini, mapped onto Slack:

| Element | data-chat-mini | quackbot-modal |
|---|---|---|
| Interface | Next.js chat panel, SSE to the browser | Slack thread, via the HTTP Events API: a Modal web endpoint (`modal_app.py`) verifies the request and spawns a per-turn worker (`src/worker.ts`, `src/slack/handlers.ts`) |
| History | Browser-local IndexedDB | Postgres, keyed by `(channel, thread_ts)` (`src/store/conversations.ts`) |
| Context | Local IndexedDB behind invented `query_context_layer` / `update_context_layer` tool *shapes* — an interception, not a real write (no such tools exist on the live MCP server) | Real MotherDuck **guides** (uuid-selected, topic-grouped): `get_query_guide` / `list_guides` / `get_guide` / `create_guide` / `update_guide` / `edit_guide_content` are allowlisted in `src/core/mcp-client.ts`, and a saved convention becomes a private guide under `topic: 'quackbot/<area>'` — durable and visible to every future conversation, not just other tabs in one browser |
| Charts | Sandboxed iframe (`MvizFrame.tsx`) | mviz embed HTML rendered by headless Chromium (`src/slack/screenshot.ts`) and uploaded as a PNG into the thread |
| Tables | Same sandboxed iframe | Native Slack `markdown` block — a real GFM table (`src/slack/viz.ts` classifies the fence, `src/slack/markdown.ts` builds the block) |
| Streaming / turn events | SSE frames to the browser (`lib/sse-encoder.ts`) | A `TurnSink` interface (`src/core/turn-sink.ts`) the agentic loop calls directly; `src/slack/sink.ts`'s `SlackTurnSink` repaints one placeholder message with `chat.update`, throttled to roughly one repaint per 1.5s, splitting into continuation messages once a render exceeds Slack's block-size caps |
| System prompt | `lib/system-prompt.ts` | `src/core/system-prompt.ts` — same read-only analyst persona, reworded for Slack threads and image-based charts |
| Tool guardrails | READONLY / MUTATING / DESTRUCTIVE classification (`lib/mcp-client.ts`) | Same classification (`src/core/mcp-client.ts`); guide reads join the allowlist as read-only, `create_guide` / `update_guide` / `edit_guide_content` as allowlisted confirmed writes gated to the `quackbot/` topic namespace with `access` forced private — `query_rw`, `set_guide_access`, `delete_dive`, and `delete_guide` stay classified but never allowlisted |
| Telemetry | `lib/controllog.ts` → labs `controllog` / `controllog-viz` | Same emitter, unchanged in shape (`src/core/controllog.ts`), now flushing to Postgres (`controllog_events` / `controllog_postings`) instead of JSONL — database name `quackbot` |
| Memorialization | — (dives out of scope) | MotherDuck Dives: `save_dive` create-only, Gemini-tuned interception of the dive-authoring guide (`get_dive_guide`, `src/core/gemini-dive-guide.ts`) gated behind `QUACKBOT_DIVE_SUPPLEMENT` (default off — see [Setup](#setup)), advisory react-hooks lint on saved source (`src/core/dive-linter.ts`) — ported from internal `mdw-turbo` |

## Setup

1. **Create the Slack app.** Go to [api.slack.com/apps](https://api.slack.com/apps)
   → **Create New App** → **From an app manifest**, pick your workspace.

   **Check the two `request_url` fields in [`manifest.json`](./manifest.json)
   before pasting it in.** They're hard-coded to the `motherduck` Modal
   workspace:
   `https://motherduck--quackbot-modal-web.modal.run/slack/events` and
   `.../slack/interactive`. Modal derives that host from
   `<workspace>--<app>-<function>`, so deploying to any other workspace means
   editing both — and JSON can't carry a comment saying so, which is why it's
   called out here. `modal profile list` prints your workspace name.
   **Slack will not accept a manifest whose URL doesn't resolve, so deploy
   before applying the manifest** (see [Deploy](#deploy-modal)).

   The manifest is pre-configured for the HTTP Events API (no Socket Mode) with
   the bot scopes and event subscriptions quackbot needs (`app_mention`,
   `message.im`, plus the two `assistant_thread_*` events for Slack's
   AI-assistant container). **Interactivity is on** with a request URL — it
   powers the Approve/Deny buttons for durable-write confirmations, now
   delivered as an HTTP POST to `/slack/interactive` rather than over a
   websocket (see [How it works](#how-it-works)).
2. **Install the app to your workspace**, then collect:
   - **`SLACK_BOT_TOKEN`** — OAuth & Permissions → Bot User OAuth Token
     (`xoxb-...`).
   - **`SLACK_SIGNING_SECRET`** — Basic Information → App Credentials. This is
     new versus the Fly deploy: Socket Mode never needed it, but every request
     the HTTP Events API sends has to be verified as actually coming from
     Slack (HMAC over the raw body + a 5-minute replay window — see
     `modal_app.py`'s `_verify_slack_signature`). `SLACK_APP_TOKEN` (`xapp-...`)
     is gone; there's no outbound websocket to authenticate any more.
3. **Copy `.env.example` to `.env`** and fill in each value — every var has a
   comment explaining it. The one that isn't self-explanatory is
   **`MODAL_INFERENCE_KEY`**: mint it from the Modal dashboard, and note that a
   `modal workspace proxy-tokens create` pair will *not* work here — see
   [Endpoint and auth](#endpoint-and-auth) for why the failure it produces is
   misleading. `MODAL_INFERENCE_BASE_URL` has a working default and can stay
   unset.
4. **Provision Postgres and apply both migrations.** quackbot-modal expects a
   connection string in `DATABASE_URL` (built against PlanetScale Postgres,
   TLS required); anything `pg`/`psycopg` can reach over TLS should work.
   ```bash
   psql $DATABASE_URL -f migrations/001_init.sql
   psql $DATABASE_URL -f migrations/002_modal.sql
   ```
   `001_init.sql` creates `conversations` (message history keyed by
   `(channel, thread_ts)`) and `channel_settings` (per-channel database
   overrides) — same as the Fly deploy. `002_modal.sql` is additive on top of
   that: it creates `slack_events` (event dedupe), `confirmations` (the
   Approve/Deny handshake), `kv_cache` (the query-guide TTL cache, now shared
   across containers instead of per-process), and `controllog_events` /
   `controllog_postings` (telemetry, replacing the JSONL files). It's written
   `if not exists` throughout, so re-running it is a no-op — apply it even if
   you're not sure whether it already ran.
5. **A headless browser ships in the container image already.** Unlike the
   Fly deploy, there's no separate `npx playwright install chromium` step —
   `modal_app.py` builds on the same Playwright base image (pinned by digest)
   the Fly `Dockerfile` used, so Chromium and the npm `playwright` package
   can't drift apart. Slack can't render the mviz iframe directly, so
   `src/slack/screenshot.ts` renders the same embed HTML data-chat-mini shows
   in-browser through headless Chromium and uploads a PNG instead.

## Run (local dev loop)

```bash
npm install
cp .env.example .env   # if you haven't already — fill in the values from Setup
npm run dev   # = modal serve modal_app.py
```

`modal serve` runs the same `web` + `run_turn` functions this project deploys,
against your local source, with a temporary public URL — useful for iterating
without a full `modal deploy`. There's no local Node process listening on a
port the way the old `npm run dev` worked on Fly; ingress is HTTP from Slack,
handled entirely by the ASGI app Modal serves. (`npm run worker` runs
`src/worker.ts` directly against stdin, useful for exercising one event without
going through Modal at all.)

Invite the bot to a channel (or DM it), then:

- `@quackbot what tables are in <database>?` — schema exploration
- `@quackbot chart revenue by month` — a `bar`/`line` fence, rendered as a PNG in the thread
- `@quackbot remember that orders.customer_id joins customers.id` — saves a durable convention as a MotherDuck guide via `create_guide`
- `@quackbot use database <name>` — switches which database(s) the channel queries by default (`src/store/settings.ts`)
- `@quackbot save that as a dive` — memorializes the thread's finding as a MotherDuck Dive (`save_dive`, create-only)

## Deploy (Modal)

Deploy is a single command:

```bash
modal token new                     # once, authenticates the CLI
modal secret create quackbot-modal \
  SLACK_BOT_TOKEN=xoxb-... \
  SLACK_SIGNING_SECRET=... \
  MOTHERDUCK_TOKEN=... \
  DATABASE_URL=postgres://... \
  MODAL_INFERENCE_KEY=...
modal deploy modal_app.py
```

`modal_app.py` defines three functions:

- **`web`** — the always-warm FastAPI ASGI app Slack talks to
  (`min_containers=1`, so there's no cold-start race against Slack's 3-second
  ack deadline). Verifies every request's signature, answers the
  `url_verification` challenge, short-circuits Slack's own HTTP retries, and
  `.spawn()`s `run_turn` for anything that's an actual event.
- **`run_turn`** — one ephemeral container per Slack event. Runs
  `node --import tsx src/worker.ts` with the event JSON on stdin, then exits.
  Sized `cpu=2, memory=2048` to give headless Chromium room (Modal publishes
  no documented floor for it; this matches the Fly machine's old headroom and
  is a candidate to tune down once real usage is visible), `timeout=900` to
  comfortably exceed the 120s confirmation wait plus a full agentic turn.
- **`housekeeping`** — a `modal.Period(days=1)` scheduled function that runs
  `src/housekeeping.ts` to prune `slack_events`, `kv_cache`, and
  `confirmations`. None of those tables need pruning for correctness — dedupe,
  the cache, and the handshake are all right whether or not this ever runs —
  which is exactly why it's a separate scheduled job instead of something on
  the request path.

`test_modal_app.py` checks the Slack signature verifier — the endpoint's front
door — against Slack's own published test vector, plus the replay-window and
malformed-header rejections. It needs no credentials, no container and no
Slack workspace, so run it before deploying, not after. It's a standalone
script that exits nonzero; `python3 test_modal_app.py`, or point at the
interpreter the Modal CLI installed itself into if `modal` isn't importable
from your default python.

Logs: `modal app logs quackbot-modal -f`. **The Starter tier only retains one
day of logs** — worth knowing before relying on them for a postmortem days
later.

**This is a one-app-at-a-time cutover with `projects/quackbot`.** Flipping a
Slack app's manifest to `socket_mode_enabled: false` with an HTTP
`request_url` immediately stops that same app from delivering events over
Socket Mode — a Slack app has one ingress configuration, not two side by side.
If you want the Fly bot and this one both reachable for comparison, that needs
a **second Slack app** (its own manifest, its own bot token) pointed at either
a shared or separate Postgres — decide that before cutting over.

None of this has been deployed or smoke-tested against a live Slack workspace
yet. The Modal CLI is authenticated and the endpoint and auth questions are
settled; what remains is creating the `quackbot-modal` secret, which needs
credentials nobody has put in front of the deploy yet.

## Security & data boundaries

Now that the bot is cloud-hosted, everyone who can message it is an untrusted
input source, and so is the content of any database row it reads (a value can
carry injected instructions). The boundaries that matter:

- **The MotherDuck token's grants are the tenancy wall.** Every query runs
  under one shared `MOTHERDUCK_TOKEN`; there is no per-user impersonation (the
  sibling `superduck` bot makes the same tradeoff). A user can `use db
  <anything>` or coax the model toward another database, but the token can
  only ever reach databases it was actually granted — `ATTACH` doesn't widen
  that, it just names an already-granted database. **So the operative rule is:
  only grant the bot's MotherDuck account databases that are OK for every
  Slack user who can reach it.** There is no per-channel data isolation. Note
  this is unchanged from the Fly deploy's reasoning, except for one detail: a
  Fly/Socket-Mode bot genuinely couldn't host a public callback endpoint for
  real per-user OAuth, so that was a hard constraint rather than a choice.
  quackbot-modal *does* now have a public HTTP endpoint (`modal_app.py`'s
  `web`) — per-user OAuth is technically possible on this architecture — but
  it isn't built, so the shared-token boundary above is still the one that's
  real today.
- **`QUACKBOT_DATABASES` is an optional hard cap** (defense-in-depth). When
  set, a tool call whose `database` argument is outside the list is rejected at
  dispatch (`databaseAllowViolation` in `src/core/mcp-client.ts`), and `use db`
  refuses un-listed names. Unset ⇒ no restriction and the token grants remain
  the only boundary. It gates the explicit `database` arg, not a fully-qualified
  `db.schema.table` buried in SQL — the token grant still covers that.
- **Durable writes are confirmed, then confined — and the confirmation
  handshake itself is now a database, not a promise.** The only mutating tools
  the model can reach are `create_guide` / `update_guide` / `save_dive`;
  `query_rw` and every delete/edit tool are blocked at the allowlist and can
  never run, even under a fully hijacked model. Each allowed write pauses for
  an Approve/Deny click from the **initiating user** before it runs. On Fly
  the same always-on process posted the Block Kit buttons and awaited the
  click, so an in-memory `Map` was a correct rendezvous. On Modal the two
  halves run in different containers: the ephemeral worker that posts the
  buttons exits before a human has had time to click anything, and the click
  itself lands on the `web` endpoint. The only thing both sides can see is
  Postgres, so the rendezvous is a `confirmations` row (`migrations/002_modal.sql`):
  the worker inserts it `pending` and polls it once a second; `web`'s
  `/slack/interactive` handler `UPDATE`s it to `approved`/`denied`, gated on
  `status = 'pending'` (first click wins) and on the click coming from the
  same Slack user who triggered the turn (so a bystander can't approve a
  write someone else's, possibly injected, prompt proposed). Deny, timeout (2
  min), or a failed prompt-post all still fail closed. The full contract
  between the TypeScript poller and the Python updater — which columns each
  side may touch, and why the two `UPDATE` statements must stay byte-for-byte
  equivalent — is documented in `src/slack/confirm.ts`'s file header; treat
  that as the source of truth if the two ever drift. Behind that, the writes
  stay confined the same way they did on Fly: guide writes are guarded to the
  bot's own `quackbot/` topic namespace with `access` forced private (the
  guard rejects `.`/`..` segments so a topic can never mimic path traversal)
  and `save_dive` is create-only with a fresh id.
- **Chart rendering is network-isolated.** Chart specs are attacker-influenced,
  so the headless-Chromium screenshot path denies all egress except the Google
  Fonts the embed needs, and the spec sanitizer strips raw-JS
  option keys and neutralizes `</script>` breakout — no SSRF/exfil even if
  injected markup runs (`src/slack/screenshot.ts`, `src/core/mviz-processor.ts`).
  The embed is *not* self-contained — mviz `document.write`s a `<script src>` for
  echarts on every chart tile — so echarts is a pinned dependency of this
  project and `resolveVendoredAsset` fulfills that one request off disk rather
  than allowlisting `cdn.jsdelivr.net`, which would hand attacker-influenced
  page content a live fetch channel to any npm package. Charts render with the
  network unplugged. Anything else the embed starts requesting fails closed
  (aborted, chart visibly empty) and trips a test — see the "covers every
  external script" case in `src/slack/screenshot.test.ts`.
- **The Slack request signature is the new front door, and it's checked on
  every inbound HTTP request.** `modal_app.py`'s `_verify_slack_signature`
  recomputes Slack's v0 HMAC over the raw request body and rejects anything
  whose signature doesn't match or whose timestamp is more than 5 minutes old
  (replay bound). This didn't exist on Fly because Socket Mode has no inbound
  request to spoof — the bot dialed out, so there was nothing to verify.
  `SLACK_SIGNING_SECRET` is what this check is keyed on; treat it with the
  same care as a bot token.
- **Secrets** never reach logs, prompts, Slack, or rendered output. On Modal
  they're a `modal.Secret` (`quackbot-modal`), surfaced to both `web` and
  `run_turn` as plain environment variables — `.env` is still git-ignored for
  local dev but is no longer how secrets reach the deployed bot. Postgres
  always connects over verified TLS (`resolvePoolConfig` in `src/store/pg.ts`).

## How it works

Turn flow, one Slack event at a time:

1. Slack POSTs the event to `modal_app.py`'s `web` endpoint
   (`/slack/events`). It verifies the v0 signature, answers the
   `url_verification` handshake if that's what arrived, and returns `200`
   immediately for anything Slack marks as a retry (`X-Slack-Retry-Num`) —
   the worker's own dedupe is the real backstop, so there's no reason to spend
   a container discovering that a retry is a retry. Everything else is handed
   to `run_turn.spawn(event)` and acked with `200` before the turn has done
   any work — Slack requires that ack within 3 seconds, long before an
   agentic turn can finish.
2. `run_turn` starts a fresh container and runs
   `node --import tsx src/worker.ts` with the whole Slack event envelope piped
   to stdin. `src/worker.ts` normalizes it into an `IncomingMessage` — the same
   shape `handlers.ts` used to build from Bolt's decoded event — filtering out
   anything that isn't a real user utterance addressed to the bot (edited
   messages, other bots, channel chatter the bot wasn't mentioned in; see the
   filter comments in `toIncomingMessage`).
3. Two things that used to be in-process module state are now Postgres
   lookups the worker makes before doing anything else: the bot's own user id
   (`kv_cache`, 24h TTL — Bolt resolved this once via `auth.test()` and kept it
   in memory; a one-shot worker has no "later" to resolve it in) and whether
   the channel is a Slack AI-assistant container (also `kv_cache`, written by
   the `assistant_thread_started` event's own worker invocation, read by every
   later turn in that channel).
4. Event dedupe and the per-thread mutex — a `Set` and a `Map<key, Promise>` on
   Fly — are now `slack_events` (an `insert ... on conflict do nothing`,
   atomic by construction) and a Postgres session-level advisory lock
   (`pg_try_advisory_lock`, non-blocking: a second worker that loses the race
   posts "still working on your last message" rather than queueing — queueing
   would mean billing a container to sit idle on a lock). Dedupe still keys on
   `(channel, ts)`, not Slack's own `event_id` — a DM @-mention fires both
   `message.im` and `app_mention` with two different `event_id`s for one human
   utterance, so deduping on the real id would let the double-fire through.
5. A `use db <name>[, <name>…]` message is intercepted before any LLM call and
   just updates `channel_settings` (`src/store/settings.ts`) — no model turn.
6. Otherwise the worker reacts :eyes: to the triggering message, loads the
   conversation from Postgres by `(channel, thread_ts)`, and posts a
   placeholder reply ("_:duck: on it…_").
7. An MCP client connects to MotherDuck with `${channel}:${thread_ts}` as the
   `session_name` hint, for read-scaling replica affinity
   (`src/core/mcp-client.ts`'s `createMCPClient`).
8. The agentic loop (`src/core/agentic-loop.ts`) runs against that MCP client,
   the Slack-specific system prompt (`src/core/system-prompt.ts`), and Modal's
   Kimi K3 Shared API (`src/core/llm-client.ts`) instead of OpenRouter, driving
   a `TurnSink` instead of an SSE stream. `src/slack/sink.ts`'s
   `SlackTurnSink` implements it: text/thinking/tool-status deltas repaint the
   placeholder via `chat.update`, throttled to roughly one repaint per 1.5s; a
   completed ` ```table ` fence splices in as a native Slack `markdown` block
   inline (`src/slack/viz.ts` + `src/slack/markdown.ts`); a completed chart
   fence (`bar` / `line` / `dumbbell`) renders to a PNG through headless
   Chromium and uploads as its own thread message (`src/slack/screenshot.ts` +
   `files.uploadV2`); guide tool calls (`get_query_guide` / `list_guides` /
   `get_guide` / `create_guide` / `update_guide` / `edit_guide_content`)
   dispatch straight through MCP like any other allowlisted tool.
9. A durable-write tool call (`create_guide` / `update_guide` / `save_dive`)
   pauses for the Approve/Deny handshake described in
   [Security & data boundaries](#security--data-boundaries) before it runs.
10. If the thread is a Slack AI-assistant container, the sink also calls
    `assistant.threads.setStatus` with the current tool verb (e.g. "running
    query…") — best-effort, and silently disabled the first time it's
    unsupported (plain channels/DMs never call it).
11. On finish, the sink paints its final render, the updated message array is
    saved back to Postgres, the controllog session for the turn is flushed to
    Postgres (`controllog_events` / `controllog_postings` — not JSONL; see
    [Telemetry](#telemetry-controllog)), and the :eyes: reaction swaps to
    :white_check_mark: or :warning:.
12. The worker process exits. `run_turn`'s container scales to zero; nothing
    is left running between turns.

**The context-layer swap.** data-chat-mini's README describes its local-IndexedDB
context interception as "swappable to the real MotherDuck context layer later
by simply not intercepting." It turns out no `query_context_layer` /
`update_context_layer` tools exist on the live MCP server — those shapes were
data-chat-mini's invention. What the server does expose is **guides** (durable
markdown documents, uuid-selected, grouped by `topic`, private-by-default via
`access: 'user'`), and quackbot's memory layer is built on them directly:
"remember that…" becomes a `create_guide` with `topic: 'quackbot/<area>'` (one
atomic convention per guide, catalog `references` attached so it auto-surfaces
next to the tables it describes), Step 0 of every data turn is a
`get_query_guide` read (org guidance + topic map in one call), and a convention
saved from one Slack thread is durable and visible to every other conversation.
A code-level guard (`guideWriteViolation` in `src/core/mcp-client.ts`) confines
the three allowlisted guide writes to the `quackbot/` topic namespace and
rejects any attempt to set non-private `access`; the server independently
rejects cross-user uuid writes and gates org-visible creates. One sharp edge:
`create_guide` is no longer collision-safe — a duplicate title+topic silently
forks a second guide — so the system prompt mandates `list_guides({topic})`
before every create, updating an existing guide by uuid instead.

**Memorializing discoveries as Dives.** When a user explicitly asks to save a
finding ("save that as a dive"), the model fetches the dive-authoring guide
via `get_dive_guide` (the dispatcher pins `client: 'other'`), composes a Dive
from the thread's validated SQL, and calls `save_dive` — create-only, so it can
never clobber an existing dive (`edit_dive_content` / `update_dive` /
`delete_dive` / `share_dive_data` stay blocked; see Out of scope). One piece
ported from the internal `mdw-turbo` implementation: on Gemini model profiles
the agentic loop can intercept `get_dive_guide` and serve a Gemini-tuned guide
(`src/core/gemini-dive-guide.ts` — the stock guide produced a 30–42%
dive-write failure rate on Gemini). This project runs Kimi K3, not Gemini, so
that supplement no longer applies by default; it's gated behind
`QUACKBOT_DIVE_SUPPLEMENT` (default off) rather than removed, because nobody
has benchmarked what K3 does with the stock dive-authoring guide, and the seam
is cheap to keep around for that follow-up. Every saved dive's source still
gets an advisory react-hooks lint (`src/core/dive-linter.ts`) folded into the
tool result so the model can self-correct without blocking the save.

**Token caveat.** `create_guide`, `update_guide`, `edit_guide_content`, and
`save_dive` are writes. A MotherDuck read-scaling token (the kind
data-chat-mini uses, read-only by design) may reject them — use a standard
write-capable PAT for `MOTHERDUCK_TOKEN`. With a non-admin PAT the server
confines guide writes to guides the bot owns (cross-user uuid writes are
rejected, org-visible creates and `set_guide_access` are permission-gated),
which is exactly the boundary quackbot's own guard assumes.

## LLM: Modal Kimi K3 Shared API

`src/core/llm-client.ts` was a hard swap from OpenRouter to `moonshotai/Kimi-K3`
served through Modal's Shared API — no fallback provider, no multi-provider
abstraction. A few behavior changes came with it, not just a different base
URL:

- **Reasoning is echoed back, not dropped.** Moonshot's docs require the
  entire untouched assistant message — including `reasoning_content` — to be
  replayed across tool calls. The OpenRouter-era loop dropped thinking blocks
  on the floor; this is now wired through in both `llm-client.ts` (serializing
  it back out) and `agentic-loop.ts` (retaining it on the way in).
- **Thinking passes straight through.** `reasoning_effort` accepts exactly
  `none|minimal|low|medium|high|xhigh|max` — which is `QUACKBOT_THINKING_LEVEL`'s
  own ladder verbatim, plus `max` — so `toReasoningEffort` validates rather than
  remaps. Default when unset or unrecognised is `low`.

  `none` genuinely disables reasoning (8 completion tokens and an empty
  `reasoning_content`, against 38 tokens and 104 characters at `low`), and is
  worth reaching for: reasoning bills at the full $15/MTok completion rate. An
  earlier version of this code folded `none` and `minimal` up into `low` on the
  belief that K3 always reasons — which billed for thinking on precisely the
  setting that asks for none. The accepted set isn't guesswork: posting a bad
  value returns a 400 naming the literal set.
- **Cost is computed locally**, not read off the response. OpenRouter handed
  back `usage.cost` in dollars; Modal doesn't, so `computeCostUSD` in
  `src/core/llm-client.ts` prices it from a local constant
  (`KIMI_K3_RATES_PER_MTOK` — $3.00 prompt / $0.30 cached / $15.00 completion
  per MTok, with `prompt_tokens_details.cached_tokens` read off the response in
  `src/core/agentic-loop.ts`). Reasoning bills at the full completion rate.
  Rates drift; the constant carries a link to check them.
- **Vision support and 1M context** are recognized by
  `getContextWindow`/`VISION_MODEL_PATTERNS` matching Kimi/Moonshot ids, ported
  from the OpenRouter regexes.

### Endpoint and auth

Both were open questions until the Modal CLI was authenticated, and both are
now settled empirically — the code carries one path each rather than a hedge.

- **Base URL: the workspace's own endpoint,** e.g.
  `https://motherduck--ep-kimi-k3-server.us-west.modal.direct/v1`. Find it with
  `modal endpoint list` or in the dashboard. Set `MODAL_INFERENCE_BASE_URL` —
  treat it as required despite the fallback, which is Modal's multi-tenant
  Shared API (`https://api.us-west-2.modal.direct/v1`). That fallback needs a
  separate entitlement this workspace doesn't have, so a missing variable
  surfaces as a 401, not as something that quietly works.
- **Auth: `Authorization: Bearer $MODAL_INFERENCE_KEY`,** where the key is a
  `modal workspace proxy-tokens create` pair **dot-joined** into one value:
  `wk-xxxx.ws-yyyy`. Modal's quickstart sends the same pair as separate
  `Modal-Key` and `Modal-Secret` headers; the endpoint accepts both (verified
  200 each way), and the joined bearer keeps this to a single env var and a
  one-line `buildAuthHeaders`. A colon instead of a dot does not work.

  **Reading Modal's 401s.** Two different bodies come back and they mean
  different things: `{"error": "missing or invalid Authorization header"}` means
  the header shape wasn't understood, while `{"error": "invalid token"}` means a
  bearer parsed fine and the credential was refused. The first is easy to
  misread as "you forgot to authenticate" when the real cause is a credential
  for the wrong product — a proxy pair against the Shared API host returns it,
  as does a CLI `ak-`/`as-` token.

### Which Modal product this is

Worth stating plainly, because the two are easy to mix up and the Kimi K3
library page funnels toward one button. This endpoint is **token-billed**, not
GPU-second billed: after the first few test calls, `modal billing summary`
attributed the spend to `LLM Tokens`, with `Deployed Apps` at `0.00`. So
`KIMI_K3_RATES_PER_MTOK` is the right cost model and the figure in the usage
pill is a real estimate of the bill rather than a proxy for it.

The surface *looks* dedicated — it has an `ep-` id in `modal endpoint list`, a
workspace-prefixed hostname, and proxy-token auth, all of which match Modal's
Auto Endpoints documentation. Don't infer per-second billing from those signals;
check `modal billing summary` instead.

## Telemetry (controllog)

Same emitter as data-chat-mini and as the Fly deploy, unchanged in shape
(`src/core/controllog.ts`): every model prompt/completion and tool call is
recorded as a spec-compliant event/posting pair. What changed is where it
lands — Postgres tables (`controllog_events` / `controllog_postings` in
`migrations/002_modal.sql`) instead of JSONL files on local disk. That wasn't
optional: Modal's ephemeral containers have no durable local disk to write
to, and even a shared Modal Volume resolves concurrent appends to the same
file last-write-wins, which would silently drop one turn's log every time two
turns finished close together. Appends became inserts; disable with
`NEXT_PUBLIC_DISABLE_LOGGING=1` same as before.

Point the labs Python tooling at Postgres instead of a log directory to hand
off to the same per-run conversation explorer and cost/latency/token rollups
in [`controllog-viz`](../controllog-viz):

```bash
pip install "controllog[duckdb] @ git+https://github.com/motherduckdb/labs#subdirectory=projects/controllog"
```

TODO: the upload invocation itself (`controllog.motherduck.upload(...)` in the
Fly README) assumed a `log_dir` of JSONL files. Whether the labs `controllog`
package has a Postgres-source variant of that upload, or whether
`controllog-viz` can be pointed at these tables directly, hasn't been checked
against this project's code — confirm against the `controllog` package before
relying on this section.

## Out of scope

OAuth / multi-identity auth (the bot token is the only identity — every user
in a channel shares it; the token's grants are the tenancy boundary, see
[Security & data boundaries](#security--data-boundaries) for how the public
`web` endpoint changes the *feasibility* of this without changing what's
actually built), Dive *mutation* (`edit_dive_content`, `update_dive`,
`delete_dive`, `share_dive_data` are classified but never allowlisted —
creation can't clobber an existing dive, edits to a caller-supplied id can,
and there's no confirmation UI to gate that), guide re-scoping and deletion
(`update_guide_metadata`, `set_guide_access`, `delete_guide` are classified but
never allowlisted, and the allowlisted guide writes are confined to the
`quackbot/` topic namespace with `access` forced private — the server
independently rejects cross-user uuid writes and gates org-visible creates),
canvas, `query_rw` (classified but never allowlisted), and DM-vs-channel
permission separation (a DM and a channel mention are handled the same way
once the message reaches the loop). Re-benchmarking the Gemini dive-guide
supplement for Kimi K3 (see [How it works](#how-it-works)) is also out of
scope for this migration. Slack Enterprise Grid specifics (org-wide app
install, Grid-level tokens) are untested. Decommissioning the Fly deployment
is a separate decision after this one proves out — `projects/quackbot` stays
deployed and untouched.
