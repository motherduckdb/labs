"""Modal entrypoint for quackbot.

This is the only Python in the project, and it exists because Modal Functions
can only be *defined* in Python — the `modal` npm package is a client for
invoking already-deployed functions, and Modal's own docs say defining
Functions "will likely remain exclusive to Python". Everything with an opinion
about Slack, SQL, or the agentic loop stays in TypeScript.

Shape:

    Slack ──HTTPS──> web (this file, always warm)
                       verify signature, ack 200 in <3s
                       run_turn.spawn(event)
                              │
                              v
                     run_turn (this file)
                       subprocess: node src/worker.ts

Why not run the Node HTTP server directly under `@modal.web_server`? Because
Modal scales a container down once its HTTP response is returned, and Slack
requires that response within 3 seconds — long before a turn is finished. Bolt
does its real work *after* acking, so the turn would be killed mid-flight. The
spawn split is what makes "ack fast, work slowly" safe here.

Deploy:  modal deploy modal_app.py
Logs:    modal app logs quackbot-modal -f   (note: Starter tier keeps 1 day)
"""

import hashlib
import hmac
import json
import os
import subprocess
import time
import traceback

import modal

APP_NAME = "quackbot-modal"

app = modal.App(APP_NAME)

# Reuse the Playwright base image the Fly build already pinned by digest, so
# Chromium and the npm `playwright` package cannot drift apart — the same
# reason the Fly Dockerfile pinned it. `add_python` installs a standalone
# interpreter, since this image ships Node but no Python and Modal needs one.
#
# Layer order matters: package*.json are copied and installed BEFORE src/, so
# editing a source file doesn't invalidate the `npm ci` layer. `copy=True` is
# required on anything a later build step reads — without it Modal mounts the
# files at container start, which is after `npm ci` would have run.
PLAYWRIGHT_IMAGE = (
    "mcr.microsoft.com/playwright:v1.61.1-noble"
    "@sha256:5b8f294aff9041b7191c34a4bab3ac270157a28774d4b0660e9743297b697e48"
)

image = (
    modal.Image.from_registry(PLAYWRIGHT_IMAGE, add_python="3.12")
    .workdir("/app")
    .add_local_file("package.json", "/app/package.json", copy=True)
    .add_local_file("package-lock.json", "/app/package-lock.json", copy=True)
    # tsx lives in "dependencies" (it is the runtime), so --omit=dev still
    # installs it while dropping typescript/vitest/@types from the image.
    .run_commands("cd /app && npm ci --omit=dev")
    .pip_install("fastapi[standard]==0.115.*", "psycopg[binary]==3.2.*")
    .add_local_dir("src", "/app/src", copy=True)
    .add_local_dir("migrations", "/app/migrations", copy=True)
    .env({"NODE_ENV": "production"})
)

# One secret carrying everything the bot needs. Modal surfaces these as plain
# environment variables, so the TypeScript side's `process.env` reads are
# unchanged from the Fly deployment. Build it with:
#
#   python3 scripts/make-modal-secret.py
#
# and NOT by hand. The script assembles the secret without any credential
# being typed into a shell, and reads the source .env as data rather than
# sourcing it — a DATABASE_URL carrying `&channel_binding=require` breaks zsh
# on the bare `&`, and the failures that don't error (glob expansion, command
# substitution) are worse than the one that does.
#
# The keys it sets are SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET, MOTHERDUCK_TOKEN,
# DATABASE_URL, MODAL_INFERENCE_KEY and MODAL_INFERENCE_BASE_URL. There is no
# MODAL_KEY/MODAL_SECRET pair: buildAuthHeaders sends one dot-joined bearer
# (llm-client.ts), so the two-variable form authenticates nothing.
#
# SLACK_SIGNING_SECRET is new — Socket Mode never needed it, the HTTP Events
# API does. SLACK_APP_TOKEN (xapp-) is no longer used at all.
secret = modal.Secret.from_name("quackbot-modal")

# Non-secret config, mirroring the old fly.toml [env] block.
CONFIG = {
    "MOTHERDUCK_API_URL": "https://api.motherduck.com",
    "QUACKBOT_THINKING_LEVEL": "low",
}

# How the TypeScript entrypoints are launched, and NOT via `npx`. Every Slack
# turn pays this once, before any Slack, database, MCP or model work starts;
# `npx` spends roughly a second of that re-resolving a binary whose location we
# already know, because it re-walks node_modules and consults its own cache on
# every invocation.
#
# This is the exact file `npx tsx` ends up executing. `npm ci --omit=dev`
# (image build, above) installs tsx — it is a runtime dependency, not a dev one
# — and npm links every dependency's `bin` entry into `node_modules/.bin`;
# tsx's is `dist/cli.mjs`, so the shim is a mode-755 symlink to a file starting
# `#!/usr/bin/env node`. Verified against a clean `npm ci --omit=dev` from this
# repo's lockfile (tsx 4.23.0), not assumed.
#
# `node node_modules/tsx/dist/cli.mjs` would be equivalent; `node --import tsx`
# would not — that registers the loader only, and is a different CLI contract.
TSX = "/app/node_modules/.bin/tsx"


# ---------------------------------------------------------------------------
# run_turn — one Slack event, one turn, then exit
# ---------------------------------------------------------------------------
# cpu/memory are sized for headless Chromium (chart PNGs), which is the memory
# hog; Modal's defaults of 0.125 core / 128 MiB will not launch it. Modal
# publishes no guidance on Chromium's floor, so this starts at the Fly
# machine's headroom and should be tuned down once real usage is visible.
#
# timeout=900 has to comfortably exceed the 120s Approve/Deny wait plus a full
# agentic loop; MDW-scale turns have been observed near 108K tokens.
@app.function(
    image=image,
    secrets=[secret, modal.Secret.from_dict(CONFIG)],
    cpu=2.0,
    memory=2048,
    timeout=900,
    # A turn is not idempotent — it posts to Slack. Retrying a failed one would
    # double-post rather than recover, so failures stay failures.
    retries=0,
)
def run_turn(event: dict) -> None:
    """Run the TypeScript worker for exactly one Slack event."""
    proc = subprocess.run(
        [TSX, "src/worker.ts"],
        input=json.dumps(event),
        capture_output=True,
        text=True,
        cwd="/app",
    )
    # Surface the worker's own logs into Modal's, so `modal app logs` shows the
    # bot's output rather than an opaque exit code.
    if proc.stdout:
        print(proc.stdout, end="")
    if proc.stderr:
        print(proc.stderr, end="")
    if proc.returncode != 0:
        raise RuntimeError(f"worker exited {proc.returncode}")


# ---------------------------------------------------------------------------
# migrate — apply migrations/*.sql
# ---------------------------------------------------------------------------
# Run with: modal run modal_app.py::migrate
#
# This exists because its absence broke the first live turn. `migrations/` was
# baked into the image and `src/store/*.ts` was written against it, but nothing
# ever executed the SQL, so the first real Slack message reached a database with
# no `kv_cache` and no `slack_events` and the bot answered "check the logs".
#
# It is deliberately a manual `modal run` rather than something the web endpoint
# or run_turn does on boot. Migrations against a database shared with the live
# Fly bot are not something a cold container should decide to do by itself,
# concurrently, several times a minute.
#
# Every statement in every file is `create … if not exists`, so this is
# idempotent and safe to re-run; applying an already-applied file is a no-op.
# Files run in sorted order, which is why they are numbered.
@app.function(image=image, secrets=[secret, modal.Secret.from_dict(CONFIG)], timeout=300)
def migrate() -> None:
    import pathlib
    import psycopg

    files = sorted(pathlib.Path("/app/migrations").glob("*.sql"))
    if not files:
        raise RuntimeError("no migrations found at /app/migrations")

    with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
        for path in files:
            # One transaction per file: a file that fails leaves the ones
            # before it applied, which is the behaviour that makes re-running
            # after a fix the obvious move.
            with conn.transaction(), conn.cursor() as cur:
                cur.execute(path.read_text())
            print(f"applied {path.name}")

        with conn.cursor() as cur:
            cur.execute(
                "select table_name from information_schema.tables "
                "where table_schema = 'public' order by table_name"
            )
            print("tables now present: " + ", ".join(r[0] for r in cur.fetchall()))


# ---------------------------------------------------------------------------
# housekeeping — daily table maintenance
# ---------------------------------------------------------------------------
# `slack_events`, `kv_cache` and `confirmations` all accumulate rows that
# nothing in the request path has any reason to delete: dedupe, the cache and
# the confirmation handshake are each correct whether or not old rows are
# cleaned up. That is precisely why this needs to be its own scheduled job —
# unbounded growth here will never be anybody's bug until the database is full.
#
# Modal's scheduler guarantees at-least-once, so this can double-run; every
# prune is an idempotent age-bounded DELETE, so that is harmless.
@app.function(
    image=image,
    secrets=[secret, modal.Secret.from_dict(CONFIG)],
    schedule=modal.Period(days=1),
    timeout=300,
)
def housekeeping() -> None:
    proc = subprocess.run(
        [TSX, "src/housekeeping.ts"],
        capture_output=True,
        text=True,
        cwd="/app",
    )
    if proc.stdout:
        print(proc.stdout, end="")
    if proc.stderr:
        print(proc.stderr, end="")
    if proc.returncode != 0:
        raise RuntimeError(f"housekeeping exited {proc.returncode}")


# ---------------------------------------------------------------------------
# web — the Slack-facing edge
# ---------------------------------------------------------------------------
def _should_spawn(body: dict) -> bool:
    """Would the worker treat this event as a turn? Cheap, conservative subset.

    Measured on the first live day: 28 events, 21 of which spawned a 2-CPU /
    2-GiB container that booted Node purely to log "is not a turn" and exit.
    Fifteen were `message_changed` — the bot's own streaming edits arriving back
    as events. On Fly this cost nothing, because an always-on process did the
    same check in memory; here every one of them is a container. It is also
    self-amplifying, since the more the bot streams the more it spawns.

    This mirrors `toIncomingMessage` in src/worker.ts, and only the parts of it
    that need no I/O. That function additionally drops events whose author IS
    the bot user, which requires resolving the bot user id — a Slack call and a
    kv read — so that check stays in the worker where the id is already needed.

    ASYMMETRIC ON PURPOSE: a false negative silently drops a user's message,
    a false positive wastes a container. So this returns True whenever it is
    not certain, and the worker remains the authority. Keep it that way — do
    not "tighten" this into the real decision.
    """
    if body.get("type") != "event_callback":
        return True  # not an event envelope; let the worker sort it out

    event = body.get("event")
    if not isinstance(event, dict):
        return True

    kind = event.get("type")

    # Assistant lifecycle events carry no channel/ts but DO drive kv writes in
    # the worker, so they must still spawn.
    if kind in ("assistant_thread_started", "assistant_thread_context_changed"):
        return True

    if kind in ("app_mention", "message"):
        # Anything a bot authored, including this bot. Covers `bot_message`.
        if event.get("bot_id"):
            return False
        if not event.get("channel") or not event.get("ts"):
            return False
        if kind == "message":
            # `message_changed`, `message_deleted`, `channel_join`, file shares
            # — the worker takes plain messages only.
            if event.get("subtype"):
                return False
            # Plain messages are a turn in DMs only; elsewhere it takes a mention.
            if event.get("channel_type") != "im":
                return False
        return True

    return True


def _spawn_decision(body: dict, headers) -> tuple[bool, str]:
    """Does this HTTP delivery get a container, and what should be logged about it?

    Returns `(spawn, note)`, where `note` names the delivery — "first delivery"
    or the retry number and Slack's stated reason — for the log line.

    RETRIES ARE SPAWNED LIKE ANY OTHER DELIVERY. This is the part that was
    wrong before: the endpoint used to answer 200 and drop anything carrying
    `x-slack-retry-num`, arguing that we ack before doing the work, so a retry
    can only mean "our ack was slow" and the turn is already running. That is
    true of *most* retries and of none of these:

      * `run_turn.spawn()` runs BEFORE the 200 is returned. If the spawn
        raises — a Modal API blip, a transient auth failure, a scheduling
        error — FastAPI answers 500 and no turn exists.
      * The same window loses the event if this container dies inside it: an
        eviction, or a `modal deploy` rolling the web container mid-request.
      * Anything that makes the request never reach the handler at all — a
        Modal-side 502, a connection reset — has the same shape from Slack's
        side, and equally no turn.

    In each case Slack's retry is the only remaining copy of the user's
    message, and ignoring it loses that message permanently and silently: the
    bot simply never answers, with nothing in any log saying why.

    Duplicates are caught where they can be caught correctly — in the worker,
    against shared state, rather than here in a container that knows nothing
    about the other deliveries. `handle()` in src/slack/handlers.ts claims
    `(channel, ts)` with `insert … on conflict do nothing` BEFORE any Slack,
    database or model work, so a retry landing mid-turn loses the claim and
    exits without posting. (Checked, because the fix depends on it: if the
    claim were written at the END of a turn, letting retries through would
    double-post.) Assistant lifecycle events bypass that claim, but all they
    do is an idempotent `kvSet`, so replaying one is a no-op too.

    The trade, priced: ignoring retries costs a permanently lost message every
    time a spawn fails. Spawning them costs one extra container that boots,
    loses the dedupe claim and exits — at most three times per event, since
    that is Slack's whole retry budget. A silent unrecoverable loss is worth
    more than three seconds of a 2-CPU container.

    The `_should_spawn` filter still applies to retries: it is a pure function
    of the body, so a retried non-turn is still a non-turn.
    """
    retry_num = headers.get("x-slack-retry-num")
    if retry_num:
        reason = headers.get("x-slack-retry-reason") or "-"
        note = f"slack retry {retry_num} (reason={reason})"
    else:
        note = "first delivery"
    return _should_spawn(body), note


def _verify_slack_signature(signing_secret: str, headers, raw_body: bytes) -> bool:
    """Slack's v0 request signature.

    Two independent checks, both required: the HMAC proves the request came
    from Slack, and the timestamp window bounds how long a captured request
    stays replayable. Slack's own guidance is 5 minutes.
    """
    timestamp = headers.get("x-slack-request-timestamp", "")
    signature = headers.get("x-slack-signature", "")
    if not timestamp or not signature:
        return False

    try:
        if abs(time.time() - int(timestamp)) > 60 * 5:
            return False
    except ValueError:
        return False

    basestring = b"v0:" + timestamp.encode() + b":" + raw_body
    expected = (
        "v0="
        + hmac.new(signing_secret.encode(), basestring, hashlib.sha256).hexdigest()
    )
    # compare_digest, not ==, so a mismatch's position doesn't leak by timing.
    return hmac.compare_digest(expected, signature)


# The Block Kit action_ids that src/slack/confirm.ts puts on its buttons. These
# two strings are a contract across the language boundary — changing one here
# without changing it there breaks the Approve/Deny handshake silently, with
# the confirmation simply timing out (and, because timeout fails closed, being
# denied). Keep them in sync.
APPROVE_ACTION = "quackbot_confirm_approve"
DENY_ACTION = "quackbot_confirm_deny"


def _record_decision(confirm_id: str, approved: bool, user_id: str) -> bool:
    """Hand a button click to the worker that is polling for it.

    The worker posted the buttons and is blocked on this row; it lives in a
    different container, so the database is the only channel between them.

    This UPDATE is the Python half of the contract documented at the top of
    src/slack/confirm.ts, and `pgConfirmStore.decide` there is the reference
    implementation — the two statements must stay identical. Both WHERE
    conditions past the id are load-bearing:

      status = 'pending'
          Makes this idempotent. A double-click, or Slack redelivering the
          interaction, cannot overwrite a decision already made. First click
          wins.

      coalesce(payload->>'initiating_user', %s) = %s
          Authorization, and the reason this is not just an idempotency guard.
          Only the user whose prompt proposed the write may approve it. Without
          this clause any workspace member who can see the message could commit
          a durable guide write that somebody else's turn — possibly a turn
          steered by an injected instruction — proposed. `coalesce` allows a row
          that recorded no initiating user to be decided by anyone, which is the
          pre-existing behaviour for turns that don't carry one.

    Returns whether a row was actually updated. False means already-decided,
    expired, or wrong user; the caller cannot tell those apart and does not need
    to — the worker owns all user-facing messaging about this confirmation.
    """
    import psycopg

    with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
        cur = conn.execute(
            """
            update confirmations
               set status = %s, decided_by = %s, decided_at = now()
             where confirm_id = %s
               and status = 'pending'
               and coalesce(payload->>'initiating_user', %s) = %s
            """,
            (
                "approved" if approved else "denied",
                user_id,
                confirm_id,
                user_id,
                user_id,
            ),
        )
        return cur.rowcount == 1


@app.function(
    image=image,
    secrets=[secret, modal.Secret.from_dict(CONFIG)],
    # Slack wants a 200 within 3 seconds and treats a miss as a failure worth
    # retrying. A cold container plus a spawn can lose that race, and the retry
    # then has to be deduped anyway — so keep exactly one container warm. At
    # Modal's default 0.125 core / 128 MiB that is a few dollars a month, well
    # inside the $30 free credit, and it removes the failure mode entirely.
    min_containers=1,
    timeout=60,
)
@modal.asgi_app()
def web():
    from fastapi import FastAPI, Request
    from fastapi.concurrency import run_in_threadpool
    from fastapi.responses import JSONResponse, PlainTextResponse

    api = FastAPI()
    signing_secret = os.environ["SLACK_SIGNING_SECRET"]

    @api.post("/slack/events")
    async def slack_events(request: Request):
        raw = await request.body()
        if not _verify_slack_signature(signing_secret, request.headers, raw):
            return PlainTextResponse("bad signature", status_code=401)

        body = json.loads(raw)

        # Slack proves it owns the request URL before it will save it in the
        # app config. This has to answer before the manifest can be flipped.
        if body.get("type") == "url_verification":
            return JSONResponse({"challenge": body.get("challenge")})

        # Drop the events that provably aren't turns before paying for a
        # container, and decide how to treat a Slack retry. The worker still
        # re-checks both; this is an optimisation, not the decision. See
        # `_spawn_decision` and `_should_spawn`.
        spawn, note = _spawn_decision(body, request.headers)
        event = body.get("event") or {}
        if not spawn:
            print(
                f"[edge] not a turn, not spawning: type={event.get('type')} "
                f"subtype={event.get('subtype') or '-'} [{note}]"
            )
            return PlainTextResponse("ok (not a turn)")

        try:
            run_turn.spawn(body)
        except Exception as err:
            # The spawn is the entire handoff. Acking a delivery whose spawn
            # failed throws the message away, so answer 500 instead and let
            # Slack redeliver — which now reaches the same path rather than
            # being dropped. Log it as well: a bare 500 surfaces as a Slack
            # delivery failure with no cause attached to it anywhere.
            print(
                f"[edge] spawn FAILED [{note}] type={event.get('type')} "
                f"channel={event.get('channel')} ts={event.get('ts')}: {err!r}\n"
                f"{traceback.format_exc()}"
            )
            return PlainTextResponse("spawn failed", status_code=500)

        print(f"[edge] spawned run_turn [{note}] type={event.get('type')}")
        return PlainTextResponse("ok")

    @api.post("/slack/interactive")
    async def slack_interactive(request: Request):
        raw = await request.body()
        if not _verify_slack_signature(signing_secret, request.headers, raw):
            return PlainTextResponse("bad signature", status_code=401)

        # Interactivity arrives form-encoded with the JSON in a `payload` field,
        # unlike the events API which posts JSON directly.
        form = await request.form()
        payload = json.loads(form["payload"])

        user_id = payload.get("user", {}).get("id") or "unknown"

        for action in payload.get("actions", []):
            action_id = action.get("action_id")
            if action_id not in (APPROVE_ACTION, DENY_ACTION):
                continue
            confirm_id = action.get("value")
            if not confirm_id:
                continue
            # psycopg's connect/execute are blocking, and this handler is
            # async — running them inline would stall the event loop for the
            # whole round trip, on the one container that owes Slack a 3s ack
            # for every other event in flight. The threadpool keeps the loop
            # free.
            recorded = await run_in_threadpool(
                _record_decision,
                confirm_id,
                action_id == APPROVE_ACTION,
                user_id,
            )
            if not recorded:
                # Already decided, expired, or a user who isn't allowed to
                # decide this one. Not an error: log and let the worker's own
                # rendering stand.
                print(f"decision not recorded for {confirm_id} (clicked by {user_id})")

        # The worker owns updating the message to drop the buttons — it knows
        # what the confirmation was for. Acking with an empty 200 leaves the
        # message alone in the meantime.
        return PlainTextResponse("")

    @api.get("/health")
    async def health():
        return PlainTextResponse("ok")

    return api
