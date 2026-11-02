# 6. Claim the MotherDuck organization

An organization created without a login, by
[motherduck.com/try](../05-motherduck-try/README.md) or by an agent, belongs to nobody until a
person claims it. Claiming means signing up or signing in from the claim link. You then own
the organization and everything in it.

> TODO: Document how to claim the organization created by motherduck.com/try: where the
> claim link or button appears, and whether the 72-hour limit below also applies. The /try
> page doesn't describe this, and it hasn't been tested.

## How claiming works (agent-created organizations)

MotherDuck documents this flow for organizations that agents create:
[Create and claim accounts for AI agents](https://motherduck.com/docs/key-tasks/ai-and-motherduck/agent-account-signup/).
It hasn't been tested in this workshop.

1. The agent sends an unauthenticated `POST` with no body:

   ```bash
   # macOS / Linux (curl)
   curl -X POST https://new.motherduck.com
   # Any OS, including Windows (uv runs a Python one-liner)
   uv run --python 3.13 python -c "import urllib.request; print(urllib.request.urlopen(urllib.request.Request('https://new.motherduck.com', data=b'', method='POST')).read().decode())"
   ```

   With the MotherDuck CLI installed, `motherduck new` wraps this request and saves the token.
2. The JSON response contains `motherduck_token` (for connecting), `claim_org_url` (for the
   human), `how_to_use_motherduck` (connection instructions for the agent) and `region`.
3. A person opens `claim_org_url` in a browser and signs up with an email address, or signs
   in to an existing account. That person becomes the owner.

What the docs say to watch for:

- An unclaimed organization is deleted 72 hours after it's created, along with its data.
- It runs on the Lite plan: no credit card, and it doesn't use anyone's 7-day Free Trial.
- A claimed organization can't be merged into one you already own. It stays separate. If you
  already have a MotherDuck account, you end up with two organizations.
- Sandboxed agents that block outbound network access may not be able to reach
  `new.motherduck.com`.

## After claiming

Connect your AI client to the organization with the remote MCP server:
[7. Set up the MotherDuck Remote MCP](../07-remote-mcp/README.md).

Next: [7. Set up the MotherDuck Remote MCP](../07-remote-mcp/README.md).
