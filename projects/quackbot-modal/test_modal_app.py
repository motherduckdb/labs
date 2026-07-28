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

print()
if fails:
    print("FAILURES:"); [print(" ", f) for f in fails]; sys.exit(1)
print("all signature checks passed")
