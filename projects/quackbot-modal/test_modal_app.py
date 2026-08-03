"""Exercise modal_app._verify_slack_signature against Slack's own published
test vector plus the rejection cases, before anything is deployed.

    $ python3 test_modal_app.py     # needs `modal` importable; see below

Why this file exists at all, when everything else here is tested with vitest:
`_verify_slack_signature` is the entire front door. Every other check in this
system runs *after* it has decided a request is genuinely from Slack, so a bug
in it is not one bug among many — it is the difference between a private bot
and one anybody on the internet can drive. It is also the one piece of the
deploy that can be verified with no credentials, no container and no Slack
workspace, which makes it worth verifying before, not after.

The vector below is Slack's own, from their verification docs, so this checks
our HMAC against their arithmetic rather than against itself. Its timestamp is
from 2019 and the 5-minute replay window correctly rejects it, so the vector
runs with the clock stubbed to when it was captured, and the window gets its
own cases against a live clock.

No pytest, no dev-dependency, no runner config: it is one file that exits
nonzero. If `modal` is not on your default python, use the interpreter the CLI
installed itself into — `python3 $(dirname $(readlink -f $(which modal)))/python
test_modal_app.py`.
"""
import os, sys, time, hmac, hashlib
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import modal_app as m

# https://api.slack.com/authentication/verifying-requests-from-slack
SECRET = "8f742231b10e8888abcd99yyyzzz85a5"
TS = "1531420618"
BODY = (
    b"token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&team_domain=testteamnow"
    b"&channel_id=G8PSS9T3V&channel_name=foobar&user_id=U2CERLKJA&user_name=roadrunner"
    b"&command=%2Fwebhook-collect&text=&response_url=https%3A%2F%2Fhooks.slack.com%2F"
    b"commands%2FT1DC2JH3J%2F397700885554%2F96rGlfmibIGlgcZRskXaIFfN&trigger_id="
    b"398738663015.47445629121.803a0bc887a14d10d2c447fce8b6703c"
)
SIG = "v0=a2114d57b48eac39b9ad189dd8316235a7b4a8d21a10bd27519666489c69b503"

def sign(secret, ts, body):
    base = b"v0:" + ts.encode() + b":" + body
    return "v0=" + hmac.new(secret.encode(), base, hashlib.sha256).hexdigest()

def hdr(ts, sig):
    return {"x-slack-request-timestamp": ts, "x-slack-signature": sig}

fails = []
def check(name, got, want=True):
    if got is not want:
        fails.append(f"{name}: got {got}, want {want}")
    print(f"{'ok  ' if got is want else 'FAIL'}  {name}")

# 1. Slack's published vector, with the clock moved to when it was captured.
real_time = time.time
m.time.time = lambda: int(TS) + 3
check("accepts Slack's published test vector", m._verify_slack_signature(SECRET, hdr(TS, SIG), BODY))
check("rejects a tampered body", m._verify_slack_signature(SECRET, hdr(TS, SIG), BODY + b"x"), False)
check("rejects the wrong signing secret", m._verify_slack_signature("wrong", hdr(TS, SIG), BODY), False)
m.time.time = real_time

# 2. The replay window, against the live clock.
now = str(int(time.time()))
check("accepts a freshly signed request", m._verify_slack_signature(SECRET, hdr(now, sign(SECRET, now, BODY)), BODY))
old = str(int(time.time()) - 60 * 6)
check("rejects a 6-minute-old replay", m._verify_slack_signature(SECRET, hdr(old, sign(SECRET, old, BODY)), BODY), False)
skew = str(int(time.time()) + 60 * 6)
check("rejects a far-future timestamp", m._verify_slack_signature(SECRET, hdr(skew, sign(SECRET, skew, BODY)), BODY), False)

# 3. Malformed / absent headers must be a clean False, never an exception.
check("rejects a missing signature header", m._verify_slack_signature(SECRET, {"x-slack-request-timestamp": now}, BODY), False)
check("rejects a missing timestamp header", m._verify_slack_signature(SECRET, {"x-slack-signature": SIG}, BODY), False)
check("rejects a non-numeric timestamp", m._verify_slack_signature(SECRET, hdr("not-a-number", SIG), BODY), False)
check("rejects empty headers", m._verify_slack_signature(SECRET, {}, BODY), False)


# ---------------------------------------------------------------------------
# _oversized — the pre-read body-size gate
# ---------------------------------------------------------------------------
# This runs before request.body(), so it only ever sees Content-Length. The
# rejection direction matters: anything Slack actually sends must pass, and
# anything without a trustworthy declared length must not.
print()

check("passes a typical Slack event size", m._oversized({"content-length": "4096"}), False)
check("passes exactly the limit",          m._oversized({"content-length": str(m.MAX_BODY_BYTES)}), False)
check("rejects one byte over the limit",   m._oversized({"content-length": str(m.MAX_BODY_BYTES + 1)}))
check("rejects a missing content-length",  m._oversized({}))
check("rejects a non-numeric length",      m._oversized({"content-length": "banana"}))
# int() alone would happily parse these three; they must not slip under the cap.
check("rejects a negative length",         m._oversized({"content-length": "-1"}))
check("rejects a plus-signed length",      m._oversized({"content-length": "+5"}))
check("rejects non-ASCII digits",          m._oversized({"content-length": "١٢٣"}))
check("rejects any transfer-encoding",     m._oversized({"transfer-encoding": "chunked", "content-length": "4"}))


# ---------------------------------------------------------------------------
# _should_spawn — the pre-spawn filter
# ---------------------------------------------------------------------------
# The costly direction is a false NEGATIVE: dropping a real turn loses a user's
# message silently, where a false positive only wastes a container. So the
# "must spawn" cases below are the load-bearing ones.
print()

def env(event, **kw):
    return {"type": "event_callback", "event": {**event, **kw}}

DM = {"type": "message", "channel": "D123", "ts": "1.2", "channel_type": "im", "user": "U1", "text": "hi"}
MENTION = {"type": "app_mention", "channel": "C123", "ts": "1.2", "user": "U1", "text": "<@B1> hi"}

# Must spawn.
check("spawns for a plain DM",              m._should_spawn(env(DM)))
check("spawns for an app_mention",          m._should_spawn(env(MENTION)))
check("spawns for assistant_thread_started",
      m._should_spawn({"type": "event_callback", "event": {"type": "assistant_thread_started"}}))
check("spawns for assistant_thread_context_changed",
      m._should_spawn({"type": "event_callback", "event": {"type": "assistant_thread_context_changed"}}))
# Unknown shapes must fall through to the worker, never be swallowed here.
check("spawns for an unknown event type",   m._should_spawn(env({"type": "future_event_type"})))
check("spawns for a non-event_callback",    m._should_spawn({"type": "something_else"}))
check("spawns when event is missing",       m._should_spawn({"type": "event_callback"}))
check("spawns when event is not a dict",    m._should_spawn({"type": "event_callback", "event": "nope"}))

# Must not spawn — these are exactly what the worker logs as "is not a turn".
check("skips message_changed (the streaming-edit echo)",
      m._should_spawn(env(DM, subtype="message_changed")), False)
check("skips message_deleted",              m._should_spawn(env(DM, subtype="message_deleted")), False)
check("skips a bot-authored message",       m._should_spawn(env(DM, bot_id="B999")), False)
check("skips a bot-authored app_mention",   m._should_spawn(env(MENTION, bot_id="B999")), False)
check("skips a plain message in a channel", m._should_spawn(env(DM, channel_type="channel")), False)
check("skips a message with no channel",    m._should_spawn(env(DM, channel=None)), False)
check("skips a message with no ts",         m._should_spawn(env(DM, ts=None)), False)


# ---------------------------------------------------------------------------
# _spawn_decision — the per-delivery decision, retries included
# ---------------------------------------------------------------------------
# The same asymmetry as above, sharpened. A Slack RETRY that we refuse to spawn
# is a false negative with no second chance: Slack retries because it never saw
# a 200, and among the reasons for that are ones where the turn never started
# at all — `run_turn.spawn()` runs *before* the ack, so a Modal API blip, or
# this container being evicted between the spawn and the response, both leave a
# retry as the only surviving copy of the user's message. Dropping it is a
# silent, permanent loss; the user just sees a bot that ignored them.
#
# The other direction costs one container that boots, loses the worker's
# (channel, ts) dedupe claim — written BEFORE any work in handlers.ts, so a
# retry arriving mid-turn cannot double-post — and exits. At most three of
# those per event, since three is Slack's whole retry budget. Spend the
# container.
#
# These cases pin the behaviour a previous version got wrong by short-circuiting
# on `x-slack-retry-num`, so that reintroducing that shortcut fails here.
print()

NEW = {}                                       # first delivery: no retry headers
RETRY1 = {"x-slack-retry-num": "1", "x-slack-retry-reason": "http_timeout"}
RETRY3 = {"x-slack-retry-num": "3"}            # Slack's last attempt; also no reason header

def spawns(body, headers):
    return m._spawn_decision(body, headers)[0]

def note(body, headers):
    return m._spawn_decision(body, headers)[1]

# Retries of a real turn MUST spawn — this is the event-loss fix.
check("spawns a retried DM",                spawns(env(DM), RETRY1))
check("spawns a retried app_mention",       spawns(env(MENTION), RETRY1))
check("spawns Slack's final retry",         spawns(env(DM), RETRY3))
check("spawns a retried assistant_thread_started",
      spawns({"type": "event_callback", "event": {"type": "assistant_thread_started"}}, RETRY1))
# Unchanged for first deliveries.
check("spawns a first-delivery DM",         spawns(env(DM), NEW))

# The body filter still decides; a retried non-turn is still a non-turn.
check("skips a retried message_changed",    spawns(env(DM, subtype="message_changed"), RETRY1), False)
check("skips a retried bot message",        spawns(env(DM, bot_id="B999"), RETRY1), False)

# The note is what makes a retry visible in `modal app logs` — without it a
# duplicate-looking turn and a genuine re-delivery are indistinguishable there.
check("note names the retry attempt",       "slack retry 1" in note(env(DM), RETRY1))
check("note carries Slack's reason",        "http_timeout" in note(env(DM), RETRY1))
check("note tolerates a missing reason",    "slack retry 3" in note(env(DM), RETRY3))
check("note marks a first delivery",        note(env(DM), NEW) == "first delivery")

print()
if fails:
    print("FAILURES:"); [print(" ", f) for f in fails]; sys.exit(1)
print("all signature and spawn-filter checks passed")
