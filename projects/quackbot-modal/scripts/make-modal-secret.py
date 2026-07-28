#!/usr/bin/env python3
"""Build the `quackbot-modal` Modal secret without any credential touching a shell.

    $ python3 scripts/make-modal-secret.py path/to/new-keys.env

Three of the five values already exist in the Fly bot's `../quackbot/.env`
(SLACK_BOT_TOKEN, MOTHERDUCK_TOKEN, DATABASE_URL). Two do not, because Socket
Mode and OpenRouter never needed them: SLACK_SIGNING_SECRET and
MODAL_INFERENCE_KEY. Those go in the file you pass as the argument.

Why a script rather than `set -a && . ./.env`: sourcing a .env runs it as shell.
A DATABASE_URL with `?sslmode=require&channel_binding=require` in it contains a
bare `&`, which zsh parses as a background-job operator and refuses — and the
failure modes that *don't* error are worse, since an unquoted value can be
glob-expanded or command-substituted on its way into a secret. This parser
treats the file as data: everything after the first `=` is the value, verbatim,
with no inline-comment stripping (a `#` is legal inside a Postgres password).

The merged file is written 0600 to a temp path and deleted in a `finally`, so
it does not survive a failure partway through.
"""
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
FLY_ENV = os.path.normpath(os.path.join(HERE, "..", "..", "quackbot", ".env"))

FROM_FLY = ["SLACK_BOT_TOKEN", "MOTHERDUCK_TOKEN", "DATABASE_URL"]
# MODAL_INFERENCE_BASE_URL is not a credential, but it lives here anyway: the
# fallback in llm-client.ts is the Shared API, which this workspace is not
# entitled to, so omitting it turns every LLM call into a 401.
FROM_NEW = ["SLACK_SIGNING_SECRET", "MODAL_INFERENCE_KEY", "MODAL_INFERENCE_BASE_URL"]


def parse_dotenv(path):
    """KEY=VALUE pairs. Value is everything after the first `=`, verbatim."""
    out = {}
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            if key.startswith("export "):
                key = key[len("export ") :].strip()
            value = value.strip()
            # Strip one layer of matching quotes, if present.
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            out[key] = value
    return out


def main():
    if len(sys.argv) != 2:
        sys.exit(f"usage: {sys.argv[0]} <new-keys.env>   (see the docstring)")
    new_path = sys.argv[1]

    for path, what in ((FLY_ENV, "the Fly bot's .env"), (new_path, "your new-keys file")):
        if not os.path.exists(path):
            sys.exit(f"error: {what} not found at {path}")

    fly, new = parse_dotenv(FLY_ENV), parse_dotenv(new_path)

    merged, missing = {}, []
    for key in FROM_FLY:
        if fly.get(key):
            merged[key] = fly[key]
        else:
            missing.append(f"{key} (expected in {FLY_ENV})")
    for key in FROM_NEW:
        # Guard the placeholder explicitly: a secret containing the literal
        # string PASTE deploys fine and then fails at the first Slack request,
        # which is a much more expensive way to learn this.
        if new.get(key) and new[key] != "PASTE":
            merged[key] = new[key]
        else:
            missing.append(f"{key} (fill in {new_path})")

    if missing:
        sys.exit("error: missing values:\n  " + "\n  ".join(missing))

    fd, tmp = tempfile.mkstemp(suffix=".env")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            for key, value in merged.items():
                fh.write(f"{key}={value}\n")
        os.chmod(tmp, 0o600)
        print("creating Modal secret 'quackbot-modal' with: " + ", ".join(merged))
        modal = os.path.expanduser("~/.local/bin/modal")
        rc = subprocess.call(
            [modal if os.path.exists(modal) else "modal",
             "secret", "create", "quackbot-modal", "--from-dotenv", tmp, "--force"]
        )
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)
    sys.exit(rc)


if __name__ == "__main__":
    main()
