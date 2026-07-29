# quackbot-modal

A fork of [`quackbot`](../quackbot) that runs on **Modal** instead of Fly.io and
talks to **Kimi K3 on Modal** instead of OpenRouter. Same product:
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
| Turn execution | In-process, same Node event loop that received the event | `web` verifies the Slack signature, acks, and `run_turn.spawn()`s a subprocess (`node_modules/.bin/tsx src/worker.ts`) that runs exactly one turn and exits |
| LLM | OpenRouter, multi-provider | The workspace's own Modal endpoint, hard-coded to `moonshotai/Kimi-K3` (`src/core/llm-client.ts`) |
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

1. **Create the Slack app — in two passes.** Go to
   [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** →
   **From an app manifest**, pick your workspace.

   **On this first pass, delete `settings.event_subscriptions.request_url` and
   the whole `settings.interactivity` block out of
   [`manifest.json`](./manifest.json) before pasting it in.** Slack validates a
   request URL at the moment you apply the manifest — it POSTs a
   `url_verification` challenge and rejects the manifest if nothing answers —
   and the endpoint that would answer cannot be deployed yet, because deploying
   needs a `SLACK_SIGNING_SECRET` that does not exist until the app does. That
   circularity is real, and two passes is the way out: create the app with no
   URLs now, come back and paste the *full* manifest after
   [Deploy](#deploy-modal). An earlier version of this README said only "deploy
   before applying the manifest" — true, and not enough, because you cannot
   deploy first either.

   **Check the two `request_url` fields before the second pass.** They're
   hard-coded to the `motherduck` Modal workspace:
   `https://motherduck--quackbot-modal-web.modal.run/slack/events` and
   `.../slack/interactive`. Modal derives that host from
   `<workspace>--<app>-<function>`, so deploying to any other workspace means
   editing both — and JSON can't carry a comment saying so, which is why it's
   called out here. `modal profile list` prints your workspace name.

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
3. **Collect the five values the bot needs.** `.env.example` documents all of
   them and every var has a comment explaining it; copy it to `.env` if you want
   to run `npm run worker` locally. **`.env` is not how the deployed bot gets
   its secrets** — Modal reads them from a `modal.Secret` named
   `quackbot-modal`, built in [Deploy](#deploy-modal). The five required ones
   (`REQUIRED_ENV` in `src/worker.ts`; a container missing any of them refuses
   to start) are `SLACK_BOT_TOKEN`, `MOTHERDUCK_TOKEN`, `DATABASE_URL`,
   `MODAL_INFERENCE_KEY`, and `MODAL_INFERENCE_BASE_URL`.

   The two that aren't self-explanatory:
   - **`MODAL_INFERENCE_KEY`** — a `modal workspace proxy-tokens create` pair,
     **dot-joined** into one value (`wk-xxxx.ws-yyyy`). See
     [Endpoint and auth](#endpoint-and-auth), which also decodes the two
     different 401 bodies the endpoint returns.
   - **`MODAL_INFERENCE_BASE_URL`** — required, with no default, because the
     endpoint is per-workspace. `modal endpoint list` prints yours; for the
     `motherduck` workspace it is
     `https://motherduck--ep-kimi-k3-server.us-west.modal.direct/v1`. Omitting
     it does not degrade gracefully: `getChatCompletionsUrl()` throws and the
     worker refuses to start, so a secret built without it yields containers
     that die at boot.

   `SLACK_SIGNING_SECRET` is required by the *edge* (`modal_app.py` verifies
   every inbound request with it) rather than by the worker, so it is absent
   from `REQUIRED_ENV` but still mandatory — without it no event ever reaches a
   worker to be missed.
4. **Provision Postgres.** quackbot-modal expects a connection string in
   `DATABASE_URL` (built against PlanetScale Postgres, TLS required); anything
   `pg`/`psycopg` can reach over TLS should work. **Applying the migrations is
   step 5 of [Deploy](#deploy-modal), not a step here** — the deployed path
   (`modal run modal_app.py::migrate`) runs them from inside the image against
   the same secret, so the connection string never has to exist in your shell.
   If you'd rather apply them locally, `psql $DATABASE_URL -f
   migrations/001_init.sql` then `002_modal.sql` does the same thing.

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

Deploy is not a single command, and the order matters — each step below exists
because doing it later fails. Steps 1 and 6 are the two Slack passes from
[Setup](#setup).

```bash
modal token new                                  # 2. once, authenticates the CLI
python3 scripts/make-modal-secret.py new-keys.env  # 4. build the secret
modal run modal_app.py::migrate                  # 5. apply migrations
modal deploy modal_app.py                        # 6.
```

1. **Slack app, pass one** — created without request URLs, so you have a bot
   token and a signing secret. See [Setup](#setup) step 1.
2. **`modal token new`**, then `modal workspace proxy-tokens create` for the
   inference key and `modal endpoint list` for the base URL.
3. **Postgres provisioned**, `DATABASE_URL` in hand.
4. **Build the `quackbot-modal` secret with
   [`scripts/make-modal-secret.py`](./scripts/make-modal-secret.py)** — not by
   hand. Put `SLACK_SIGNING_SECRET`, `MODAL_INFERENCE_KEY` and
   `MODAL_INFERENCE_BASE_URL` in a scratch `new-keys.env` and pass its path; the
   script reads `SLACK_BOT_TOKEN`, `MOTHERDUCK_TOKEN` and `DATABASE_URL` out of
   the Fly bot's `../quackbot/.env`, merges the six into a `0600` temp file, and
   hands that to `modal secret create --from-dotenv --force`, deleting it in a
   `finally`.

   Two reasons this is the documented path rather than a convenience. First,
   **no credential is typed into a shell** — so none lands in `~/.zsh_history`,
   a terminal scrollback, or an agent transcript. Second, **the script parses
   the `.env` as data, not as shell**: everything after the first `=` is the
   value, verbatim. Sourcing it instead (`set -a && . ./.env`) breaks outright
   on a `DATABASE_URL` containing `?sslmode=require&channel_binding=require`,
   because zsh reads the bare `&` as a background-job operator — and the failure
   modes that *don't* error are worse, since an unquoted value can be
   glob-expanded or command-substituted on its way into the secret. An inline
   `modal secret create KEY=value …` has both problems.

   Known limitation: the script requires `../quackbot/.env` to exist, because it
   was written to migrate the Fly deploy's credentials rather than to bootstrap
   a fresh one. Deploying without a sibling Fly checkout needs either that file
   or a change to the script.
5. **`modal run modal_app.py::migrate`** — applies every `migrations/*.sql` in
   sorted order, one transaction per file, then prints the resulting table list.
   It needs the secret from step 4 (that's where `DATABASE_URL` comes from), so
   it cannot run earlier; it can run before `modal deploy` and should, because
   **skipping it is what broke the first live turn**: the bot came up against a
   database with no `kv_cache` and no `slack_events` and answered "check the
   logs". Every statement is `create … if not exists`, so re-running is a no-op
   — run it even if you think it already ran. It is deliberately manual rather
   than something a container does on boot; a cold container should not decide
   to migrate a shared database by itself, several times a minute.
6. **`modal deploy modal_app.py`**, then **Slack app, pass two**: paste the full
   `manifest.json` (request URLs included, host corrected for your workspace).
   The `url_verification` challenge now has something to answer it.

If you change the secret after deploying, `modal deploy` again rather than
assuming the always-warm `web` container picks up the new value.

`modal_app.py` defines four functions:

- **`web`** — the always-warm FastAPI ASGI app Slack talks to
  (`min_containers=1`, so there's no cold-start race against Slack's 3-second
  ack deadline). Verifies every request's signature, answers the
  `url_verification` challenge, short-circuits Slack's own HTTP retries, and
  `.spawn()`s `run_turn` for anything that's an actual event.
- **`run_turn`** — one ephemeral container per Slack event. Runs
  `/app/node_modules/.bin/tsx src/worker.ts` with the event JSON on stdin, then
  exits. Not `npx tsx` (which spends ~1s per turn re-resolving a binary whose
  path is known) and not `node --import tsx` (which registers the loader only —
  a different CLI contract). Sized `cpu=2, memory=2048` to give headless
  Chromium room (Modal publishes no documented floor for it; this matches the
  Fly machine's old headroom and is a candidate to tune down once real usage is
  visible), `timeout=900` to comfortably exceed the 120s confirmation wait plus
  a full agentic turn.
- **`migrate`** — a manual `modal run` target that applies `migrations/*.sql`
  (step 5 above). Not scheduled, not called on boot, deliberately.
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

**Status: this is deployed and live.** The manifest is applied with Socket Mode
off, the secret exists, the migrations are applied, and the bot answers in
Slack. (This paragraph used to say the opposite — "none of this has been
deployed or smoke-tested" — and stayed that way through the cutover. Two things
the deploy taught that no test could: the migrations were nobody's step, and the
per-turn cost profile is much worse than expected. See
[Latency and cost](#latency-and-cost--the-migrations-real-bill).)

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
   `node_modules/.bin/tsx src/worker.ts` with the whole Slack event envelope piped
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
   the Slack-specific system prompt (`src/core/system-prompt.ts`), and Kimi K3
   on Modal (`src/core/llm-client.ts`) instead of OpenRouter, driving
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
ported from the internal `mdw-turbo` implementation: the agentic loop can
intercept `get_dive_guide` and append a Gemini-tuned supplement
(`src/core/gemini-dive-guide.ts` — the stock guide produced a 30–42%
dive-write failure rate on Gemini). It used to be gated on the model id
matching `/gemini/i`; that gate is **gone**, and `QUACKBOT_DIVE_SUPPLEMENT`
(default off) is now the only thing that decides (`diveSupplementEnabled` in
`src/core/agentic-loop.ts`). Opting in on K3 is deliberate rather than
accidental. It's kept rather than removed because nobody
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

## LLM: Modal Kimi K3

`src/core/llm-client.ts` was a hard swap from OpenRouter to `moonshotai/Kimi-K3`
served through the workspace's own Modal endpoint — no fallback provider, no
multi-provider abstraction. A few behavior changes came with it, not just a
different base URL:

- **Reasoning is echoed back, not dropped.** Moonshot's docs require the
  entire untouched assistant message — including `reasoning_content` — to be
  replayed across tool calls. The OpenRouter-era loop dropped thinking blocks
  on the floor; this is now wired through in both `llm-client.ts` (serializing
  it back out) and `agentic-loop.ts` (retaining it on the way in).
- **Thinking passes straight through.** `reasoning_effort` accepts exactly
  `none|minimal|low|medium|high|xhigh|max` — which is `QUACKBOT_THINKING_LEVEL`'s
  own ladder verbatim, plus `max` — so `toReasoningEffort` validates rather than
  remaps. Default when unset or unrecognised is `low`, in `toReasoningEffort`
  and in `DEFAULT_THINKING` (src/slack/handlers.ts) both. Those two disagreed
  until recently: handlers defaulted to `medium`, inherited from the OpenRouter
  era, and because it always passed a *valid* level the
  documented `low` fallback in `toReasoningEffort` was unreachable. Production
  pinned `QUACKBOT_THINKING_LEVEL=low` in modal_app.py's `CONFIG`, so the live
  bot never ran at `medium` — but deleting that one line would silently have
  raised every turn's reasoning budget. See "Latency and cost" below for why that matters
  more here than it did on OpenRouter.

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
  Rates drift; the constant carries a link to check them. **The endpoint sends
  `prompt_tokens_details: null`**, so the cached-token count is never populated
  in practice and every prompt token is priced at the uncached rate — an
  over-estimate if the endpoint is caching. See "Latency and cost" below.
- **The model is a constant, not a setting.** `MODEL_ID` and `CONTEXT_WINDOW`
  (1M) are plain exports in `src/core/llm-client.ts` and `getModelProfile()`
  returns them directly. There is no model env var: the endpoint serves exactly
  this model, `computeCostUSD` bills Kimi rates unconditionally, and the request
  dialect is K3's — so an id that could be changed would have relabelled all of
  that rather than switched anything. A second model would arrive with its own
  base URL, rate table and dialect, changed together in one place.

### Endpoint and auth

Both were open questions until the Modal CLI was authenticated, and both are
now settled empirically — the code carries one path each rather than a hedge.

- **Base URL: the workspace's own endpoint,** e.g.
  `https://motherduck--ep-kimi-k3-server.us-west.modal.direct/v1`. Find it with
  `modal endpoint list` or in the dashboard. `MODAL_INFERENCE_BASE_URL` is
  **required** — it is in the worker's `REQUIRED_ENV`, so a container without it
  refuses to start, and `getChatCompletionsUrl` throws as a backstop.

  There is no fallback, deliberately. There was one for a while — Modal's
  multi-tenant Shared API (`https://api.us-west-2.modal.direct/v1`), added
  because it is one fixed host for every workspace and so the only value that
  could be hardcoded. It turned out to need a separate entitlement this
  workspace doesn't have: it 401s. A default that is known not to work is worse
  than no default, because "you forgot to set a variable" arrives disguised as
  an auth failure and the reader goes hunting for a credential problem that
  doesn't exist.
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

### Latency and cost — the migration's real bill

> **This section was wrong once and is rewritten. Read the correction first.**
> An earlier version said the prompt prefix was "~12–14K tokens either way" and
> concluded from that that the slowdown "is dominated by decode throughput". It
> also named the pre-migration baseline as `google/gemini-3-flash-preview`.
> Telemetry falsified both: the baseline calls ran **`openai/gpt-5.6-luna`**, and
> the Kimi prompts were **236–239K tokens**, roughly 20× the claimed size. The
> decode-throughput conclusion rested entirely on the small-prompt premise, so it
> is withdrawn rather than restated with new numbers.
>
> How the errors got in is worth recording, because both are cheap mistakes to
> repeat. The model id was lifted from `PLAN.md`'s *configuration* table — the
> code default in the pre-migration `llm-client.ts` — and presented as what was
> measured; nobody checked what the 171 logged calls actually ran (`gpt-5.6-luna`
> also appears in `src/core/tool-invocation.test.ts:32`, describing live
> behaviour, which would have caught it). And the "≈8K pre-fetched guide block"
> traces to `src/core/query-guide.ts:12`, which says the guide is **~5-10KB** —
> kilobytes, roughly 1.5–2.5K tokens. Nothing measured the prompt; a byte figure
> was read as a token figure and the total was never sanity-checked against the
> `prompt_tokens` that controllog already records per call.

**Kimi K3 is much slower than what it replaced.** Measured from
`model_completion.wall_ms` in controllog:

| | model | p50 wall time per model call | sample |
|---|---|---|---|
| Before (Fly + OpenRouter) | `openai/gpt-5.6-luna` | **2.4s** | 171 calls |
| After (Modal + Kimi K3) | `moonshotai/Kimi-K3` | **39.0s** | 6 calls |

Read the sample sizes before quoting the ratio: **6 calls is thin**, easily
skewed by an endpoint cold start or one long turn, and the p50 could move a lot
with real traffic. A 16× gap is far too large to be noise, but "16×" is not a
number to put in a slide yet. Note also that a Slack turn is several model
calls, so a multi-tool turn multiplies this.

It is also not a like-for-like comparison in any respect: a proprietary model on
one provider's serving stack, replaced by a frontier-scale open-weights MoE on
another — **and, on the evidence below, not carrying a comparable prompt
either.** Both run at `reasoning_effort: low`; that is the only variable held
still.

#### The prompts are enormous, and that is the finding

Five of the six Kimi calls carried prompts of **236–239K tokens**. That is the
measurement; everything after it is inference from code.

At $3.00/MTok uncached, **236K prompt tokens is $0.71 per model call.** Output
barely registers by comparison — even 2K completion tokens at $15/MTok is
$0.03 — so essentially the whole bill is prompt. A Slack turn is several calls,
so priced this way the six logged calls come to roughly **$4 between them**, and
a turn that keeps working costs proportionally more (the loop's ceiling is
`MAX_ITERATIONS = 40`; whether the six calls were one turn or several is not
recorded here). For a chat bot answering one question in a Slack thread, that is
not a rounding error,
and **the cost finding is probably more important than the latency one** — it is
larger, it compounds with usage, and unlike the model's decode speed it is
partly ours to fix.

It also inverts the old section's dismissal of prefill. At 236K tokens, prefill
is no longer "seconds at most" and cannot be waved away — but neither can it be
promoted to the new explanation, because **we do not record time-to-first-token
anywhere.** `wall_ms` is stamped from before the request to after the stream
closes (`callStart` in `src/core/agentic-loop.ts`), which is prefill and decode
and network together. Which term dominates 39s is genuinely unknown.

#### What in the code can produce a 236K-token prompt

The fixed part of the prompt is small and measurable, so it is not the answer:

| Component | Size | How known |
|---|---|---|
| System prompt | 19.4K chars ≈ 5K tokens | `buildSystemPrompt(['db'], null)` measured directly |
| Pre-fetched guide block | ~5-10KB ≈ 1.5–2.5K tokens | `src/core/query-guide.ts:12`, an author's observation, not a measurement |
| Tool schemas (19 allowlisted tools) | unmeasured | fetched from the MCP server at runtime; not in this repo |

Even allowing tool schemas an implausibly generous 10K tokens, the fixed prefix
is under ~20K. The remaining ~215K tokens is about 850KB of text, and there is
exactly one thing in this codebase that puts text of that order into a message
array: **tool results, uncapped.**

- **Nothing truncates a tool result before it enters the history.**
  `executeToolWithStatus` (`src/core/mcp-client.ts:501-512`) returns the server's
  entire response text; `dispatchTool` passes it through unchanged; the agentic
  loop pushes `dispatch.content` verbatim into a `tool_result` block
  (`src/core/agentic-loop.ts:582-587`). There is no row cap, no byte cap, no
  head/tail trim, and no summarisation step anywhere on that path. The `query`
  tool's output is query output — a wide `SELECT` over a few thousand rows is
  hundreds of KB of text, and all of it lands in the prompt of every subsequent
  call.
- **The `slice(0, 500)` calls nearby are a decoy.** Every truncation in this
  repo is display-side: `slice(0, 500)` feeds `sink.onToolEnd` (what Slack
  shows), `MAX_TABLE_ROWS = 30` in `src/slack/viz.ts` caps the rendered table,
  and the sink's `INTERIM_CAP` caps a Slack message. None of them touch
  `messages`. It is easy to read "only the first ~30 rows reach the user" (which
  the system prompt does say) as "results are capped" — they are capped *on the
  way to Slack*, never on the way to the model.
- **History replays in full and grows without bound.** `runTurn` loads
  `stored.messages` and spreads it whole into the new message array
  (`src/slack/handlers.ts:269-312`) — no window, no cap, no eviction — and saves
  `result.finalMessages` back, tool results included
  (`src/store/conversations.ts`). So a large result is paid for once in the turn
  that fetched it and then again on **every** model call of **every** later turn
  in that thread, forever. Nothing ever shrinks a thread.
- **Assistant output cannot explain it.** `max_completion_tokens` is 16384, so
  five prior calls contribute at most ~82K tokens of assistant text even at the
  cap. The bulk has to come from somewhere the model didn't write.

**Which mechanism actually fired is not established.** Two candidates fit:

1. **One very large tool result inside a turn.** This fits the shape of the data
   best *if* the sixth call is the small one: a fixed payload that big would make
   all six calls large, whereas one big result landing after the first call makes
   exactly five of six large, with the ~3K spread between them accounted for by
   the smaller messages accumulating after it.
2. **A thread that had already accumulated a large history** before these six
   calls, so every call in the sample starts from it.

Both reduce to the same root cause — uncapped tool results in an uncapped
history — and neither can be distinguished from code alone. Note that candidate
1's reasoning depends on the sixth call being much smaller than the other five,
which is an inference from the telemetry summary rather than something confirmed
here.

**Ruled out from code:** the system prompt (measured, ~5K, and a pure function of
`(databases, queryGuide)` so it is identical across the calls of a turn); the
Gemini dive supplement (5,172 chars ≈ 1.3K tokens, and default-off — `QUACKBOT_DIVE_SUPPLEMENT`
is unset in `modal_app.py`'s `CONFIG`); any hidden per-call padding (the request
body in `streamChatCompletion` carries no timestamp, nonce, or session id).
**Not ruled out, because it is not visible from this repo:** an unexpectedly huge
`get_query_guide` response, or MCP tool schemas far larger than assumed. Both are
server-side, and both would inflate *every* call equally.

**This is not a context-limit problem, and that is what makes it a cost
problem.** `CONTEXT_WINDOW` is **1,000,000** (`src/core/llm-client.ts`), so 236K
is ~24% of the window — the bot is nowhere near its ceiling and nothing is at
risk of being truncated or rejected. Nothing will stop this. A thread only ever
grows, and there is roughly 764K of headroom to grow into at $3.00/MTok on every
call. The failure mode here is a bill, not an error, which is exactly the kind
that goes unnoticed: no exception, no truncation, no user-visible symptom beyond
the wait. (The 1M figure feeds the cosmetic "% context full" pill and is
Moonshot's published spec for the model rather than a property probed against
this endpoint — which no longer bears on anything, at 24%.)

What *was* ours, and is fixed:

- **Reasoning default.** `DEFAULT_THINKING` was `medium` against a documented
  `low` (see above). Latent rather than live, because production pins the env
  var — but on this model the difference is billed at $15/MTok *and* paid in
  wall-clock before the user sees a character.
- **Prompt-prefix stability across turns.** Tool-call arguments are echoed back
  on every later request, so their exact bytes are part of the cacheable prefix.
  Conversation history is persisted to a `jsonb` column, and jsonb does not
  preserve object key order — so a `{database, sql}` tool call came back out of
  Postgres as `{sql, database}` and `JSON.stringify` reproduced the difference,
  invalidating the cached prefix from the previous turn's first tool call
  onward. `stableStringify` (src/core/llm-client.ts) now sorts keys at every
  depth so in-memory and round-tripped history serialize identically.

  **The prompt sizes above make this fix far more valuable than it looked when
  it was written, and it is still entirely unmeasured.** Cached prompt tokens
  bill at $0.30/MTok against $3.00 uncached. On a 236K prompt that is $0.07
  versus $0.71 — a busted prefix cache is plausibly ~90% of the per-call bill,
  which is a different order of thing from the tidying-up it was filed as. But
  "plausibly" is doing real work in that sentence: the endpoint returns
  `prompt_tokens_details: null`, so we cannot see whether the cache is hit at
  all, before or after the fix. Do not quote the saving as achieved.

What was investigated and found *not* to be a problem:

- **Streaming is not buffered.** The sink paints Slack on the first event of a
  call, not at the end: `lastUpdateAt` starts at 0, so the first `scheduleUpdate`
  bypasses the 1.5s throttle entirely. Since K3 emits `reasoning_content` before
  `content`, the placeholder flips to `_thinking…_` within about a second and
  prose streams in as it arrives. There is no first-token-to-first-post delay to
  reclaim. What the user *does* see is a static `_thinking…_` for the whole
  reasoning phase — honest, but not a progress bar. Making that tick would cost
  a `chat.update` every 1.5s for ~26 updates per call, which is Slack rate-limit
  territory; it was left alone deliberately.
- **Nothing else varies early in the prompt.** The system prompt is a pure
  function of `(databases, queryGuide)`; the guide block is TTL-cached in
  Postgres for 15 minutes precisely to hold it still (src/core/query-guide.ts);
  the tool list preserves MCP server order through `getFilteredTools`; the
  request body carries no timestamp, session id, or nonce. The jsonb key-order
  issue above was the only real cache-buster found.

**Caveat on all of the caching work: we cannot currently verify any of it.** The
endpoint returns `prompt_tokens_details: null` (see the comment in
`src/core/agentic-loop.ts` where reasoning tokens are read), so it reports no
cached-token count at all. `computeCostUSD` therefore bills 100% of prompt
tokens at the uncached $3.00/MTok rate, which makes the cost pill an
*over*-estimate if caching is in fact working, and there is no signal in our
telemetry that would show a cache fix landing.

#### Still unknown, and what would settle each

Stated explicitly, because the last version of this section filled these gaps
with a story instead:

| Unknown | What would settle it |
|---|---|
| Which mechanism produced the 236K prompts | Query the telemetry that is **already being written**: `tool_end.payload.result_bytes` per tool call, and `model_prompt.payload.{iteration, history_len}` per call (`src/core/controllog.ts`). A single oversized `result_bytes` in the same run identifies candidate 1; a large `history_len` on the first call of the run identifies candidate 2. No code change needed — nobody has run the query. |
| Whether the prefix cache is working at all, before or after `stableStringify` | Post the same prefix twice against the live endpoint and read `usage` off the response. If it keeps returning `prompt_tokens_details: null`, ask Modal whether the endpoint reports cached tokens at all; without that field the fix stays unfalsifiable and so does the cost estimate. |
| Whether 39s is prefill or decode | Record time-to-first-token. The loop already has the seam — stamp the first chunk that arrives in the SSE read loop and emit it alongside `wall_ms`. |
| How fast a thread's prompt grows in practice | `model_prompt.payload.{prompt_tokens, history_len}` over successive turns in one thread. This is the number that decides whether uncapped history is a slow leak or a fast one, and it is already being logged. |
| Whether the two rows of the table are comparable at all | Read `model_prompt.payload.prompt_tokens` for the 171 `gpt-5.6-luna` calls — the same telemetry that supplied their `wall_ms`, so it is one more column on a query already run. If those prompts were also ~236K, the 16× is model-vs-model; if they were small, some of it is prompt size rather than the model, and the two effects are confounded today. |

The last row is the one to do first. Until it is answered, "Kimi K3 is 16×
slower" and "our prompts got 20× bigger" are two candidate explanations for the
same observation, and this document cannot tell you which.

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
