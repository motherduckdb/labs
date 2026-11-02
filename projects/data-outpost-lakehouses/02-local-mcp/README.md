# 2. Get the local DuckDB open source MCP set up

Connect your AI client to DuckDB on your laptop with
[`mcp-server-motherduck`](https://github.com/motherduckdb/mcp-server-motherduck) 1.1.0 and
DuckDB 1.5.6. Every client starts the server on your laptop through `uvx`.

Finish [section 1](../README.md#1-get-uv-python--duckdb-installed) first. Run every command
from the workshop folder (`labs/projects/data-outpost-lakehouses`), not from this folder.

There are two ways to set up the server:

- **Let the agent do it (Dev Mode).** Paste the prompt below. The agent configures an
  in-memory, read-write DuckDB that can create tables and attach other files.
- **Configure it by hand (workshop database).** Use `print_configs.py` and the per-client
  steps below. The server opens `data/workshop.duckdb` read-only.

| Client | Section |
|---|---|
| Claude Code | [Claude Code](#claude-code) |
| Codex CLI | [Codex CLI](#codex-cli) |
| GitHub Copilot (VS Code, CLI) | [GitHub Copilot](#github-copilot) |
| Cursor | [Cursor](#cursor) |
| Claude Desktop | [Claude Desktop](#claude-desktop) |
| ChatGPT desktop app | [ChatGPT desktop app](#chatgpt-desktop-app) |
| OpenCode | [OpenCode](#opencode) |

---

## Option A: let the agent set it up (Dev Mode)

Paste this prompt into your agent:

```text
Set up this MCP server (https://github.com/motherduckdb/mcp-server-motherduck) locally in Dev
Mode as mentioned in the README, with DuckDB pinned to 1.5.6 (run it with
uvx --python 3.13 --with duckdb==1.5.6), and connect it to this agent session.
Refer also to the workshop repo here:
(https://github.com/motherduckdb/labs/tree/main/projects/data-outpost-lakehouses) Do this as
automatically as possible, but if you fail to set it all the way up, give me short clear
instructions to configure it.
```

Dev Mode with DuckDB 1.5.6 runs this command:

```bash
uvx --python 3.13 --with duckdb==1.5.6 mcp-server-motherduck --db-path :memory: --read-write --allow-switch-databases
```

Dev Mode has no guardrails: the agent can write, and `--allow-switch-databases` lets it
switch to other database files. If the agent gets stuck, use option B and copy your client's
config from `print_configs.py`.

## Option B: configure your client by hand (workshop database)

Print every client's config with your absolute paths filled in:

```bash
uv run mcp/print_configs.py
```

Copy each client's config from the output ([`mcp/print_configs.py`](../mcp/print_configs.py)).
The server opens [`data/workshop.duckdb`](../data/) read-only and runs
[`mcp/init.sql`](../mcp/init.sql) on every connection to load the iceberg and httpfs
extensions. Don't leave a read-write `duckdb` session open on the file.

**Test prompt:**

> Using the duckdb tools: list the tables, count the personas in each region (join
> `personas` to `states` on `state`), then run this as a single `execute_query` call:
> `ATTACH IF NOT EXISTS 'https://kszucs-catalog.hf.space' AS hf (TYPE iceberg, ENDPOINT 'https://kszucs-catalog.hf.space', AUTHORIZATION_TYPE 'none'); SELECT state, count(*) AS personas, round(avg(age), 1) AS avg_age FROM hf.nvidia.personas_brazil GROUP BY ALL ORDER BY personas DESC LIMIT 5`

Expected: 2 tables (`personas`, `states`); Sudeste 429,821, Nordeste 262,430, Sul 150,955,
Centro-Oeste 78,822, Norte 77,972; then São Paulo 224,991 (45.0), Minas Gerais 103,935
(45.3), Rio de Janeiro 81,718 (45.9), Bahia 68,851 (44.2), Paraná 57,084 (44.8). The last
query attaches a public Iceberg catalog on Hugging Face (see
[section 3](../03-iceberg/README.md)) and reads the remote table that `personas` was copied
from. It goes in one call because the server opens a new connection for each tool call.

Then set up your client below.

### Claude Code

Run the Claude Code command from `print_configs.py`, then check it with `claude mcp list`
(`duckdb ... ✔ Connected`). Run `claude` and send the test prompt.

### Codex CLI

Run the Codex command from `print_configs.py`, then check it with `codex mcp list`. Run
`codex` and send the test prompt. This also sets up the
[ChatGPT desktop app](#chatgpt-desktop-app).

### GitHub Copilot

#### VS Code

Command Palette → **MCP: Open User Configuration**, then merge in the VS Code block from
`print_configs.py`. Open Copilot Chat, switch to Agent mode, and check that `duckdb` is on in
the tools picker. Send the test prompt.

#### Copilot CLI

Run the Copilot CLI command from `print_configs.py`, then run `copilot` and send the test prompt.

### Cursor

Cursor Settings → Tools & MCP → New MCP Server opens `~/.cursor/mcp.json`. Merge in the
Cursor block from `print_configs.py`.

A green dot next to `duckdb` means it connected. Send the test prompt from the Agent chat
with **Run on** set to **This Mac** (your computer). Cloud agents can't see servers on your
laptop.

### Claude Desktop

Settings → Developer → Edit Config, then merge in the same `mcpServers` block as Cursor.
Quit Claude completely and reopen it. Send the test prompt and click **Allow** when Claude
asks to use duckdb.

### ChatGPT desktop app

The app reads `~/.codex/config.toml`, so the [Codex CLI](#codex-cli) step already set it up.
To add it in the app instead, go to Settings → Plugins → MCPs → Add → Add MCP server, choose
STDIO, and copy the command and arguments from the ChatGPT block of `print_configs.py` (one
Add argument per line). Save and check that the toggle is on.

Switch to Codex (top left), open the workshop folder as a project, pick **This computer**,
and send the test prompt.

### OpenCode

Start `opencode` and pick a model with `/connect`. To use your Claude subscription, run
`claude auth login` first and choose **Claude Agent**.

Run the OpenCode command from `print_configs.py`, then `opencode run "<test prompt>"`.

Ignore `opencode mcp list` if it says `No MCP servers configured`
([OpenCode bug #55811](https://github.com/anomalyco/opencode/issues/55811)).

---

## Query a few example files, create a dataset locally and poke around

Once the server is connected, try these. The prompts are suggestions, not from the slides.

**Query a file in object storage.** DuckDB reads Parquet over `s3://` or `https://` without
downloading it first. MotherDuck's public bucket needs no credentials:

> Using the duckdb tools, describe the columns of
> `read_parquet('s3://us-prd-motherduck-open-datasets/hacker_news/parquet/comments_stories/stories/dt=2024-12-21/data0.parquet')`,
> then count its rows and show the five highest-scoring titles.

Expected: 554 rows. The highest score is 576. The same file works over HTTPS at
`https://us-prd-motherduck-open-datasets.s3.amazonaws.com/hacker_news/parquet/comments_stories/stories/dt=2024-12-21/data0.parquet`.

**Explore the workshop database.** `data/workshop.duckdb` holds `personas` (1,000,000
synthetic Brazilian personas copied from the Iceberg table `nvidia.personas_brazil`; values
are in Portuguese) and `states` (each state's abbreviation and region). See
[`mcp/build_workshop_db.sql`](../mcp/build_workshop_db.sql). Ask for the table comments, a
`SUMMARIZE` of `personas`, the share of personas with a university degree
(`education_level = 'Superior completo'`) by region, or three personas that match a profile.

**Create a dataset locally.** Section 1 already created one: step 4 copied an Iceberg table
into `data/workshop.duckdb`. To have the agent create its own tables, use Dev Mode (option
A); the option B server is read-only, so `CREATE` and `INSERT` fail there. For example:

> Using the duckdb tools, create a table `stories` from all the Parquet files matching
> `s3://us-prd-motherduck-open-datasets/hacker_news/parquet/comments_stories/stories/dt=2024-12-*/*.parquet`,
> then tell me which day had the most stories.

Expected: 6,892 stories; 2024-12-30 had the most (767). Dev Mode's database is in memory, so
these tables disappear when the server stops.

Next: [3. Introduce Iceberg](../03-iceberg/README.md).
