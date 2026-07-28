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
# unchanged from the Fly deployment. Create it with:
#
#   modal secret create quackbot-modal \
#     SLACK_BOT_TOKEN=xoxb-... \
#     SLACK_SIGNING_SECRET=... \
#     MOTHERDUCK_TOKEN=... \
#     DATABASE_URL=postgres://... \
#     MODAL_INFERENCE_BASE_URL=... \
#     MODAL_KEY=wk-... MODAL_SECRET=ws-...
#
# SLACK_SIGNING_SECRET is new — Socket Mode never needed it, the HTTP Events
# API does. SLACK_APP_TOKEN (xapp-) is no longer used at all.
secret = modal.Secret.from_name("quackbot-modal")

# Non-secret config, mirroring the old fly.toml [env] block.
CONFIG = {
    "MOTHERDUCK_API_URL": "https://api.motherduck.com",
    "QUACKBOT_THINKING_LEVEL": "low",
}


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
        ["npx", "tsx", "src/worker.ts"],
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
# web — the Slack-facing edge
# ---------------------------------------------------------------------------
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

        # Slack retries anything it thinks failed. We ack immediately and do
        # the work out of band, so a retry means "our ack was slow", never
        # "the work didn't happen" — replaying it would double-post. The
        # worker's own (channel, ts) dedupe is the backstop; this just avoids
        # spending a container to discover that.
        if request.headers.get("x-slack-retry-num"):
            return PlainTextResponse("ok (retry ignored)")

        run_turn.spawn(body)
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
