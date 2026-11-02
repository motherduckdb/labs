# 7. Set up the MotherDuck Remote MCP

MotherDuck hosts a remote MCP server for your MotherDuck organization. It's a different server
from the local `mcp-server-motherduck` in [section 2](../02-local-mcp/README.md): nothing runs
on your laptop, and queries run on MotherDuck compute against your MotherDuck databases. You
can keep both connected; the local server is named `duckdb` in this workshop.

Everything on this page comes from the MotherDuck docs and hasn't been tested in a workshop
run. Follow the official setup guide for your client:
[Connect to the MotherDuck MCP server](https://motherduck.com/docs/key-tasks/ai-and-motherduck/mcp-workflows/mcp-setup/).

## What the docs say

- Server URL: `https://api.motherduck.com/mcp` (HTTP transport).
- Most clients sign in with OAuth: you log in to MotherDuck in the browser, with no token to
  copy. A few clients (for example Gemini CLI) send a MotherDuck access token in an
  `Authorization: Bearer` header instead.
- The server is read-write. It exposes `query` (read-only) and `query_rw` (read-write) plus
  tools for Dives and Flights ([MCP Server reference](https://motherduck.com/docs/sql-reference/mcp/)).
  To keep an agent read-only, set `query_rw` to require approval or block it in your client.

## Client setup (summary)

The guide has the full steps. In short:

| Client | From the docs |
|---|---|
| Claude Code | `claude mcp add --transport http --scope user MotherDuck https://api.motherduck.com/mcp`, then start `claude`, run `/mcp`, select MotherDuck and choose Authenticate. Drop `--scope user` to add it to the current project only. |
| Claude (web and desktop) | Customize → Connectors → browse, open MotherDuck, Connect, then authorize. |
| Cursor | Settings → Tools & MCP → New MCP Server, with the URL above and `"type": "http"`, then Connect. |
| VS Code / GitHub Copilot | Add a `servers` entry with `"type": "http"` and the URL (the guide also has an install link), start it, sign in, then use Copilot Chat in Agent mode. |
| ChatGPT and Codex | Install the MotherDuck plugin from Plugins, connect your account, then pick MotherDuck with `@` in a chat. |
| Others | An `mcpServers` entry with the URL and `"type": "http"`. |

> TODO: OpenCode and a manual Codex CLI config aren't covered by the setup guide. Add them
> once tested, or point attendees to the plugin route.

> TODO: Add a test prompt and expected output for this section (for example, list the
> databases in the claimed organization and query a sample database). Not yet written or
> tested.

## References

- [Connect to the MotherDuck MCP server](https://motherduck.com/docs/key-tasks/ai-and-motherduck/mcp-workflows/mcp-setup/)
- [MCP Server reference](https://motherduck.com/docs/sql-reference/mcp/)
- [MCP workflows](https://motherduck.com/docs/key-tasks/ai-and-motherduck/mcp-workflows/)

Next: [8. End to end agent example on MotherDuck](../08-end-to-end/README.md).
