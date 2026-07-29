# quackbot-modal — migration plan

A fork of `projects/quackbot` that runs on **Modal** instead of Fly.io and talks to
**Kimi K3 on Modal** instead of OpenRouter (the Shared API was the initial assumption; the
workspace turned out to be entitled only to its own dedicated endpoint). The Fly-deployed
`projects/quackbot`
is left untouched and stays live until this one is proven.

Two changes drive everything else:

1. **Fly → Modal.** Modal caps function execution at **24 hours** and has no supported
   always-on outbound-websocket pattern, so **Socket Mode has to go**. Ingress becomes the
   Slack **HTTP Events API**: a Modal web endpoint verifies the signature, acks in under 3s,
   and `.spawn()`s a worker that runs one turn and exits.
2. **OpenRouter → Modal Kimi K3.** Hard swap. `moonshotai/Kimi-K3`, OpenAI-compatible,
   $3 / $0.30 cached / $15 per MTok, 1M context.

Change 1 is the expensive one. It converts quackbot from a single always-on process into an
ephemeral per-turn worker, which means **every piece of in-memory cross-request state has to
move into Postgres**.

---

## 1. Architecture

```
Slack ──HTTPS──> web  (@modal.asgi_app, FastAPI, min_containers=1)
                   ├─ url_verification challenge
                   ├─ HMAC signature verify + 5-min replay window
                   ├─ X-Slack-Retry-Num short-circuit → 200
                   ├─ /slack/interactive → UPDATE confirmations, ack
                   └─ run_turn.spawn(payload) → 200 in <3s
                                │
                                v
                 run_turn  (@app.function, cpu=2, memory=2048, timeout=900)
                   └─ subprocess: node --import tsx src/worker.ts  (event JSON on stdin)
                        ├─ pg advisory lock ......... per-thread mutex
                        ├─ pg unique insert ......... event dedupe
                        ├─ pg poll .................. Approve/Deny handshake
                        ├─ pg kv .................... query-guide TTL cache
                        ├─ pg insert ................ controllog
                        └─ Chromium ................. chart PNGs
                   container exits → scales to zero
```

`web` is the only always-on piece. At Modal's default 0.125 core / 128 MiB that is
**~$4.90/mo list**, comfortably inside the $30/mo free credit. `run_turn` bills only while a
turn is running.

**Why `min_containers=1` on `web`:** Slack requires a 200 within 3 seconds. A cold FastAPI
container plus `.spawn()` can miss that, and a missed ack makes Slack retry — which we'd then
have to dedupe anyway. One warm container removes the whole failure mode for ~$5/mo list.

### Why the split is Python-at-the-edge

Modal Functions can only be **defined in Python** — the `modal` npm package is a client that
invokes already-deployed functions, and Modal's own docs say "defining Modal Functions will
likely remain exclusive to Python." So there is a Python shim no matter what. Given that, the
edge (signature verify, ack, spawn, button clicks) is ~80 lines of Python and the entire
agentic loop stays in TypeScript, unchanged in shape.

The alternative — `@modal.web_server(3000)` running Bolt's HTTP receiver in Node — was
rejected: Modal scales the container down once the HTTP response is returned, and Bolt does
its real work *after* acking. The turn would be killed mid-flight.

---

## 2. Files

### New

| File | What |
|---|---|
| `modal_app.py` | Image, secrets, `web` (FastAPI ASGI), `run_turn` (subprocess shim) |
| `src/worker.ts` | New entrypoint: one event from stdin → one turn → exit |
| `src/store/locks.ts` | `pg_try_advisory_lock` thread mutex |
| `src/store/events.ts` | Dedupe via `INSERT … ON CONFLICT DO NOTHING` |
| `src/store/kv.ts` | TTL key/value cache (backs the query-guide cache) |
| `migrations/002_modal.sql` | `slack_events`, `confirmations`, `kv_cache`, `controllog_*` |
| `src/housekeeping.ts` | Daily prune of the three growing tables (not anticipated; see §8) |

### Deleted

`fly.toml`, `Dockerfile`, `MCP_MIGRATION_PLAN.md` (already removed), and `src/main.ts` /
`src/slack/app.ts` outright — not reduced to a dev harness. `registerHandlers` went with
them: once events arrive over HTTP, the bolt listener wiring has no caller.
`registerConfirmationActions` was kept despite also having no production caller, because it
is the only *tested* statement of the contract `modal_app.py`'s UPDATE implements.

### Modified

| File | Change |
|---|---|
| `src/core/llm-client.ts` | Hard swap to Modal Kimi K3 (see §3) |
| `src/core/agentic-loop.ts` | Local cost table, `provider: 'modal'`, reasoning echo-back |
| `src/slack/handlers.ts` | In-memory mutex + dedupe → Postgres |
| `src/slack/confirm.ts` | In-memory pending Map → Postgres poll |
| `src/core/query-guide.ts` | Module-level TTL cache → `kv_cache` |
| `src/core/controllog.ts` | JSONL on local disk → Postgres |
| `manifest.json` | `socket_mode_enabled: false`, add request URLs |
| `package.json` | Drop `@slack/bolt` for `@slack/web-api`; scripts point at Modal. Not a pure swap — `@slack/web-api` was only ever transitive via Bolt, so it has to become an explicit dependency or `npm ci --omit=dev` ships an image with no `WebClient` |
| `README.md`, `.env.example` | Rewrite for Modal |

---

## 3. LLM swap — OpenRouter → Modal Kimi K3

Today `llm-client.ts` is the only file that talks to OpenRouter, but it leans on several
OpenRouter-specific behaviours. Each needs a decision:

| Today (OpenRouter) | On Modal Kimi K3 |
|---|---|
| `https://openrouter.ai/api/v1/chat/completions` | `https://motherduck--ep-kimi-k3-server.us-west.modal.direct/v1/chat/completions` — **RESOLVED**. Per-workspace, from `modal endpoint list`, so `MODAL_INFERENCE_BASE_URL` is required — in `REQUIRED_ENV`, and `getChatCompletionsUrl` throws without it. The Shared API host (`api.us-west-2.modal.direct/v1`) was briefly the code default; it needs an entitlement this workspace lacks, so the default was a silent 401 and is gone |
| `Authorization: Bearer $OPENROUTER_API_KEY` | `Authorization: Bearer $MODAL_INFERENCE_KEY` — **RESOLVED**. The key is a `wk-`/`ws-` proxy pair **dot-joined**: `wk-xxxx.ws-yyyy`. The endpoint takes that or the `Modal-Key`/`Modal-Secret` header pair (200 both ways); one bearer keeps it to a single env var |
| `X-Title`, `HTTP-Referer` headers | Drop — OpenRouter-only conventions |
| `provider: { order: [...] }` | Drop — no equivalent |
| `usage: { include: true }` | `stream_options: { include_usage: true }` (standard OpenAI) |
| `usage.cost` in dollars | **Not provided** — compute locally from a price table |
| `reasoning: { effort }` | Top-level `reasoning_effort`: `low` \| `high` \| `max` |
| `temperature: 0.3` | **Remove** — K3 locks sampling params |
| `max_tokens` | `max_completion_tokens` (`max_tokens` is deprecated) |
| Default `google/gemini-3-flash-preview` | Default `moonshotai/Kimi-K3` |

Five of these are behaviour changes rather than renames, and they're where the risk sits:

**a) Reasoning echo-back is mandatory.** Moonshot's docs are explicit: the *entire untouched*
assistant message, including `reasoning_content`, must be echoed back across tool calls —
"do not keep only `content`." Our loop currently drops thinking blocks on the floor
(`llm-client.ts:198-199` has a comment claiming otherwise, but the branch is a no-op). This
is the single most likely source of subtly-degraded agentic behaviour if missed, and it
touches both `llm-client.ts` (serialize back out) and `agentic-loop.ts` (retain on the way in).

**b) Thinking passes through — CORRECTED.** This section originally said K3 always reasons
and the `QUACKBOT_THINKING_LEVEL` ladder had to collapse onto `low|high|max`. It does not.
Posting an invalid `reasoning_effort` returns a 400 naming the accepted literals:
`none|minimal|low|medium|high|xhigh|max` — quackbot's ladder verbatim, plus `max`. So
`toReasoningEffort` validates and passes through, defaulting to `low` when unset or
unrecognised. `none` really does disable reasoning (8 completion tokens, empty
`reasoning_content`, vs 38 tokens and 104 chars at `low`), which matters because reasoning
bills at the full $15/MTok — the original collapse charged for thinking on the one setting
that asks for none.

The unset default is `low` in *both* places that decide it. `DEFAULT_THINKING` in
`src/slack/handlers.ts` was `medium`, a leftover from Gemini 3 Flash where thinking was fast
and cheap enough not to show; because it always supplied a valid level, `toReasoningEffort`'s
documented `low` fallback could never fire. Production pinned `QUACKBOT_THINKING_LEVEL=low`
in `modal_app.py`'s `CONFIG`, so the live bot was never affected — the bug was that deleting
one line of Python would have raised every turn's reasoning budget with nothing to catch it.

**c) Cost display.** `src/core/usage.ts` renders a dollar figure that only exists because
OpenRouter hands back `usage.cost`. Modal won't. We compute it from
`$3.00 / $0.30 cached / $15.00` per MTok using `prompt_tokens_details.cached_tokens`. Rates
go in one constant with a comment pointing at the model library page, since they'll drift.

**d) Model-id regexes.** `getContextWindow` and `VISION_MODEL_PATTERNS` pattern-match
OpenRouter id shapes. Add a Kimi case: 1M context, vision-capable.
*Note:* `modelSupportsVision` is exported but never called anywhere, and the bot has no Slack
file-upload handling — the vision path is dead code inherited from data-chat-mini. Updating
the regex is cheap correctness, not a feature.

**e) The Gemini dive-guide supplement dies.** `agentic-loop.ts:342-345` gates
`buildGeminiDiveSupplement()` behind `/gemini/i.test(profile.id)`. Kimi won't match, so the
1.5K-token supplement silently stops applying. That supplement was benchmarked *for Gemini*
(PR #81 Phase 3) and is un-benchmarked for K3. **Plan: keep the seam, gate it behind an
explicit env flag, default off, and note in the README that dive-authoring quality on K3 is
unmeasured.** Re-benchmarking via `scripts/bench-dive-guide.ts` is follow-up work, not part
of this migration.

One more quirk to defend against: the vLLM recipe for K3 warns it "occasionally emits a
tool-call format its own parser doesn't expect." The loop already JSON-parses accumulated
tool-call arguments — we add a schema-shaped guard and a single retry rather than letting a
malformed call throw the turn.

---

## 4. Ephemeral-worker rework

Everything below is in-memory today and correct **only** because exactly one process runs.
Modal will run zero-to-many, so each needs a Postgres home.

| State | Today | Becomes | Notes |
|---|---|---|---|
| Per-thread mutex | `Map<key, Promise>` `handlers.ts:154` | `pg_try_advisory_lock(hashtext(key))` | Non-blocking: if held, post "still working on the last one" rather than queueing |
| Event dedupe | `Set<key>` + TTL `handlers.ts:154,339` | `slack_events(event_id primary key)`, insert-or-skip | ⚠️ The id must stay `${channel}:${ts}`, **not** Slack's `event_id` — see below |
| Approve/Deny | `Map<confirmId, Pending>` `confirm.ts:43-55` | `confirmations` row; worker polls 1s, 120s timeout; edge writes the decision | **Biggest single change** — see below |
| Query-guide cache | 15-min module TTL `query-guide.ts:37` | `kv_cache(key, value, expires_at)` | Was per-process; now genuinely shared |
| controllog | JSONL → `./logs` `controllog.ts:219-236` | Postgres tables | Modal Volumes are last-write-wins on concurrent same-file appends — explicitly wrong for this |
| Chromium | Module singleton `screenshot.ts:15` | Launch per worker, close on exit | Adds ~1s to chart turns; acceptable |
| Postgres pool | Singleton, `max:5` | Unchanged, but `max:2` and always close | Many short-lived containers, not one long one |

**Dedupe key correction.** An earlier draft of this plan said to dedupe on Slack's
`event_id`. That is wrong. The in-memory `Set` keys on `${channel}:${ts}` deliberately,
because a DM @-mention arrives **twice** — once as `message.im` and once as `app_mention` —
carrying two *different* Slack event_ids. Deduping on the real event_id would let that
double-fire straight through and the bot would answer itself twice. The `slack_events`
column keeps the name `event_id`, but the value written must remain `${channel}:${ts}`.
(Slack's own HTTP retries are handled separately, by the `X-Slack-Retry-Num` short-circuit
at the edge.)

**The confirmation handshake** is the part that genuinely changes shape. Today the same
process that posts the Approve/Deny buttons is the one waiting on them. With an ephemeral
worker, the button click lands on the `web` endpoint instead. So:

1. Worker inserts a `confirmations` row (`pending`) and posts the Block Kit message.
2. Worker polls that row every second, up to the existing 120s timeout.
3. User clicks. Slack POSTs `/slack/interactive` to `web`. Python `UPDATE`s the row to
   `approved`/`denied` and acks.
4. Worker's next poll sees the decision and proceeds.
5. Timeout still **fails closed** to deny, matching today's behaviour.

This means the Python edge needs a Postgres client (`psycopg`) for one `UPDATE`. That splits
a small amount of schema knowledge across two languages, which is a real if minor cost — the
alternative (spawning a whole Node container per button click) is worse on both latency and
money.

`run_turn`'s `timeout=900` has to comfortably exceed the 120s confirm wait plus the agentic
loop. 15 minutes is generous; MDW-scale turns have been observed near 108K tokens.

---

## 5. Slack app reconfiguration

Not a code change, but it gates the live smoke and is **not reversible without a redeploy**:

- `socket_mode_enabled: true` → `false`
- Add `settings.event_subscriptions.request_url` → `https://<workspace>--quackbot-modal-web.modal.run/slack/events`
- Add `settings.interactivity.request_url` → same host, `/slack/interactive`
- Keep `features.app_home.messages_tab_enabled: true` — without it DMs fail with
  `restricted_action_read_only_channel` (learned the hard way on the Fly deploy).
- **New secret required:** `SLACK_SIGNING_SECRET`. Socket Mode never needed it; the HTTP
  Events API does. It's in Slack → Basic Information → App Credentials.
- `SLACK_APP_TOKEN` (`xapp-`) becomes unnecessary.

Slack won't accept the request URL until the endpoint is live and answers the
`url_verification` challenge, so **deploy before flipping the manifest**.

⚠️ **This is a one-app-at-a-time cutover.** Flipping the manifest to HTTP immediately stops
the Fly bot from receiving events. If you want both alive at once for comparison, that needs
a **second Slack app** pointed at the same Postgres — worth deciding before the smoke.

---

## 6. Image

Reuse the Playwright base image the Fly build already pins, and let Modal add Python:

```python
image = (
    modal.Image.from_registry(
        "mcr.microsoft.com/playwright:v1.61.1-noble@sha256:5b8f294a...",
        add_python="3.12",
    )
    .workdir("/app")
    .add_local_file("package.json", "/app/package.json", copy=True)
    .add_local_file("package-lock.json", "/app/package-lock.json", copy=True)
    .run_commands("cd /app && npm ci --omit=dev")
    .pip_install("fastapi[standard]", "psycopg[binary]")
    .add_local_dir("src", "/app/src", copy=True)
    .add_local_dir("migrations", "/app/migrations", copy=True)
)
```

Chromium ships in the base image, so no `playwright install` step and no drift between the
npm package version and the browser build — the same reason the Fly Dockerfile pins by digest.
`copy=True` is required on the files that later build steps depend on; without it Modal mounts
them at container start, after `npm ci` would have run.

Deploy: `modal deploy modal_app.py`. Logs: `modal app logs quackbot-modal -f` (note: Starter
tier retains **1 day** of logs — worth knowing before relying on them for a postmortem).

---

## 7. Open questions

1. **Modal base URL + auth scheme — RESOLVED.** Not published anywhere public; the endpoints
   page is login-gated, so both were settled by probing the live endpoint. The bot uses the
   workspace's own Kimi K3 endpoint with a dot-joined proxy pair as a bearer (see §2). It is
   token-billed, not GPU-second billed: `modal billing summary` attributes the spend to
   `LLM Tokens` with `Deployed Apps` at `0.00`, so `KIMI_K3_RATES_PER_MTOK` is the right cost
   model. Don't read billing off the surface — the `ep-` id, workspace-prefixed hostname and
   proxy-token auth all look like a dedicated Auto Endpoint.

   How the code currently hedges, and what to delete once this is answered:

   - `getChatCompletionsUrl()` has **no default** and throws if `MODAL_INFERENCE_BASE_URL` is
     unset. A plausible-looking guess (`https://api.modal.com/v1`) was written first and then
     removed on purpose: it resolves, fails at request time as an opaque 404, and sends
     whoever debugs it hunting for a credential problem that does not exist. Throwing names
     the actual missing thing.

     This got re-litigated once and the answer held. After the workspace was authenticated,
     the Shared API host was briefly installed as a default on the reasoning that it is one
     fixed host for every workspace, so requiring the variable would refuse to start an
     already-correct container. Probing then showed the Shared API needs an entitlement this
     workspace lacks — it 401s. So the default wasn't a fallback, it was a known-broken
     endpoint chosen silently, which is the *same* failure the original guess was rejected
     for. Restored to throwing, with the real per-workspace URL named in the message.
   - `buildAuthHeaders()` supports **both** schemes and prefers the proxy-token pair when
     `MODAL_KEY` and `MODAL_SECRET` are both set, falling back to
     `Authorization: Bearer $MODAL_INFERENCE_KEY`. Collapse to the winner and drop the dead
     env vars from `.env.example` once the dashboard settles it.
   - `src/worker.ts` lists `MODAL_INFERENCE_BASE_URL` in `REQUIRED_ENV` so a container fails
     at startup rather than mid-turn, after the placeholder is posted. The credentials are
     deliberately *not* listed, because "exactly one of two sets" is not a check that list can
     express.
2. **Chromium's resource floor on Modal** is undocumented. Starting at `cpu=2, memory=2048`
   to match the Fly machine's headroom; tune down once we see real usage.
3. **`add_python` against the Playwright image** is a documented pattern but untested with
   this specific base. Fallback: `debian_slim` + the Node/Chromium install chain from Modal's
   webscraper example.
4. **Cold-start latency for `run_turn`** is unmeasured. The bot posts a placeholder message
   immediately today, so a second or two of extra latency is cosmetic — but worth measuring.
5. **Model latency is the migration's biggest regression, and it is mostly the model.**
   `model_completion.wall_ms` p50 went from **2.4s** (Gemini 3 Flash via OpenRouter, 171
   calls) to **39.0s** (Kimi K3 on Modal, 6 calls). Six calls is a thin sample — one cold
   endpoint or one long turn moves that p50 a lot — so treat "16×" as an order of magnitude,
   not a figure. It is also not a host comparison: a flash-tier proprietary model was
   replaced with a frontier-scale open-weights MoE. Prefill is ~12–14K tokens either way
   (≈5.4K system prompt + ≈8K guide block + tool schemas) and costs seconds at most, so the
   gap is decode throughput.

   Two things were genuinely ours and are fixed: the `DEFAULT_THINKING` mismatch above, and
   prompt-prefix instability across turns — `conversations.messages` is `jsonb`, jsonb does
   not preserve object key order, and tool-call `arguments` are echoed back into the prefix
   verbatim, so every turn after the first re-sent its own history reshuffled and invalidated
   the cache from the prior turn's first tool call onward (`stableStringify` in
   `llm-client.ts` now canonicalises it). Streaming was checked and is *not* buffered — the
   sink paints on the first event of a call, bypassing its own throttle.

   **Unresolved and worth a live probe:** the endpoint returns
   `prompt_tokens_details: null`, so it reports no cached-token count. We cannot confirm the
   prefix cache is being hit at all, cannot measure the fix above, and `computeCostUSD` bills
   every prompt token at the uncached $3.00/MTok rate. Settling it means posting the same
   prefix twice and reading `usage` off the response.

---

## 8. Sequencing

Each step is independently verifiable; the live smoke is deliberately last.

| # | Step | Depends on | Status |
|---|---|---|---|
| 0 | `modal token new`, read the endpoint base URL + key format | you | done — workspace `motherduck`; endpoint `ep-KcanMn16XzCeSucfSimxqB`, URL + auth resolved, see §7.1 |
| 1 | `migrations/002_modal.sql` + `src/store/{locks,events,kv}.ts` + tests | — | done (`1ed3038`) — but *writing* the SQL was not *applying* it; see step 9 |
| 2 | `llm-client.ts` hard swap + reasoning echo-back + local cost table | 0 | done (`1e546f5`); base URL + auth closed later |
| 3 | Postgres-backed mutex, dedupe, confirm, query-guide cache, controllog | 1 | done (`1e546f5`) |
| 4 | `src/worker.ts` entrypoint; drop Bolt for `@slack/web-api` | 3 | done (`9c50af6`) |
| 5 | `modal_app.py` + image | 4 | done (`1e546f5`) |
| 6 | Port the test suite green (243 tests today), typecheck | 2,3,4 | done — 383 tests + 25 Python checks, tsc clean |
| 7 | `modal deploy`, hit the endpoint with a synthetic signed event | 5,6 | done — secret built by `scripts/make-modal-secret.py`; signed challenge 200, bad/stale/unsigned 401 |
| 8 | Flip the Slack manifest, live smoke in Slack | 7 | done — manifest applied, Socket Mode off; bot answers in Slack |
| 9 | Apply the migrations (`modal run modal_app.py::migrate`) | 7 | done (`ee40d1d`) — **this step did not exist and should have.** The first live message hit a database with no `kv_cache` and no `slack_events`, and the bot replied "check the logs". Step 1 read as done because the SQL and the code against it were done; running it was nobody's step |
| 10 | Edge filter so streaming edits don't each spawn a container | 8 | done (`157ac7a`) — 21 of the first 28 events spawned a container only to exit; see §9 |

Steps 1–2 are parallel. Step 6 is the real gate: the existing suite covers the SSE wire
format and the mutex/dedupe semantics, so it should catch most of what §3 and §4 can break —
with the notable exception of anything requiring a real K3 response, which only step 7 exercises.

**Step 2 is now closed.** The base URL is the workspace's own Kimi K3 endpoint and auth is a
dot-joined proxy pair sent as a bearer; both were verified against the live endpoint rather
than read off a doc page, because the docs only describe the header-pair scheme. The
two-scheme hedge in `buildAuthHeaders()` is deleted — one scheme verified 200 beats two
half-believed ones.

**Retrospective on that gate.** What follows was written before the deploy and is left
standing because it was right, and not conservative enough. 383 passing tests and a clean
typecheck said the code was self-consistent; the two things that actually broke in production
were an unapplied migration and a per-turn cost profile — neither of which any unit test could
have caught, because both live in the gap between "the code is correct" and "the system is
deployed". The original text:

**Everything through step 6 is unverified against a live system.** 381 passing tests and a
clean typecheck say the code is self-consistent, not that Modal accepts the image, that the
Shared API speaks the dialect `llm-client.ts` writes, or that Slack likes the signature
verification. Steps 7–8 are where any of that is learned.

Two things were added that the plan did not anticipate:

- **`src/housekeeping.ts` + a daily Modal schedule.** Three tables (`slack_events`,
  `kv_cache`, `confirmations`) accumulate rows nothing in the request path deletes. The plan
  wrote the prune helpers but never gave them a caller.
- **`pruneOldConfirmations`.** Abandoned `pending` rows outlive the worker that was polling
  them — the timeout is enforced by the worker, not the row — so nothing ever closed them.

## 9. What this plan does not do

- **Re-benchmark dive-guide quality on K3** (§3e). The Gemini supplement goes dormant; nobody
  has measured what K3 does with the stock guide.
- **Decommission Fly.** `projects/quackbot` stays deployed and untouched. Tearing it down is a
  separate decision after this proves out.
- **Multi-instance correctness beyond the four state moves above.** Advisory locks make
  concurrent turns on the *same thread* safe; nothing here attempts cross-thread ordering
  guarantees, and none exist today either.
