# Data Outpost: query local DuckDB files from your AI clients

Connect each client below to `data/workshop.duckdb` with
[`mcp-server-motherduck`](https://github.com/motherduckdb/mcp-server-motherduck) 1.1.0 and
DuckDB 1.5.6. Every client starts the server on your laptop through `uvx`.

| Client | Section |
|---|---|
| Claude Code | [1](#1-claude-code) |
| Codex CLI | [2](#2-codex-cli) |
| GitHub Copilot (VS Code, CLI) | [3](#3-github-copilot) |
| Cursor | [4](#4-cursor) |
| Claude Desktop | [5](#5-claude-desktop) |
| ChatGPT desktop app | [6](#6-chatgpt-desktop-app) |
| OpenCode | [7](#7-opencode) |
| *Next: Frozen DuckLake* | [8](#8-frozen-ducklake) |

---

## 0. Setup (before the workshop)

**Why uv?** The MCP server is a Python package. uv fetches Python if you don't have it, and
`uvx` runs the server from a cached, isolated environment with pinned versions. You never
create a virtualenv or touch your system Python, and the same commands work on macOS, Linux
and Windows. The server commands pin Python 3.13 because DuckDB 1.5.6 has no prebuilt package
for newer Pythons, and without one uv tries to compile DuckDB from source.

Install uv, then open a new terminal:

```bash
# macOS / Linux
curl -LsSf https://astral.sh/uv/install.sh | sh
# Windows (PowerShell)
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
# Or, anywhere you already have Python
pip install uv
```

Then, in a macOS/Linux terminal or Windows PowerShell:

```bash
git clone https://github.com/motherduckdb/labs.git   # or download the repo ZIP from GitHub
cd labs/projects/data-outpost-lakehouses           # run every command in this guide from here

# 1. Install Python 3.13 (uv manages it; your system Python is untouched)
uv python install 3.13

# 2. Install DuckDB 1.5.6 for Python, in a .venv in this folder
uv venv --python 3.13
uv pip install --python .venv duckdb==1.5.6
uv run --python .venv python -c "import duckdb; print(duckdb.__version__)"   # 1.5.6

# 3. Build the workshop database (~1 min; also downloads the iceberg and httpfs extensions)
uvx --from duckdb-cli==1.5.6 duckdb data/workshop.duckdb -f mcp/build_workshop_db.sql

# 4. Pre-download the MCP server so its first start doesn't time out
uvx --python 3.13 --with duckdb==1.5.6 mcp-server-motherduck@1.1.0 --help

# 5. Print every client's config with your absolute paths filled in
uv run mcp/print_configs.py
```

Copy each client's config from step 5. The server opens the file read-only, so don't leave a
read-write `duckdb` session open on it.

**Test prompt:**

> Using the duckdb tools: list the tables, show the three states with the most stores in
> `store` (column `s_state`), then run `SELECT count(*) FROM iceberg_scan('s3://us-prd-motherduck-open-datasets/iceberg/lineitem_iceberg', allow_moved_paths = true)`.

Expected: 4 tables (`date_dim`, `item`, `lineitem`, `store`); SD 53, OH 50, LA 49; 51,793 rows.

---

## 1. Claude Code

Run the Claude Code command from `print_configs.py`, then check it with `claude mcp list`
(`duckdb ... ✔ Connected`). Run `claude` and send the test prompt.

## 2. Codex CLI

Run the Codex command from `print_configs.py`, then check it with `codex mcp list`. Run
`codex` and send the test prompt. This also sets up the ChatGPT desktop app (section 6).

## 3. GitHub Copilot

### VS Code

Command Palette → **MCP: Open User Configuration**, then merge in the VS Code block from
`print_configs.py`. Open Copilot Chat, switch to Agent mode, and check that `duckdb` is on in
the tools picker. Send the test prompt.

### Copilot CLI

Run the Copilot CLI command from `print_configs.py`, then run `copilot` and send the test prompt.

## 4. Cursor

Cursor Settings → Tools & MCP → New MCP Server opens `~/.cursor/mcp.json`. Merge in the
Cursor block from `print_configs.py`.

A green dot next to `duckdb` means it connected. Send the test prompt from the Agent chat
with **Run on** set to **This Mac** (your computer). Cloud agents can't see servers on your
laptop.

## 5. Claude Desktop

Settings → Developer → Edit Config, then merge in the same `mcpServers` block as Cursor.
Quit Claude completely and reopen it. Send the test prompt and click **Allow** when Claude
asks to use duckdb.

## 6. ChatGPT desktop app

The app reads `~/.codex/config.toml`, so section 2 already set it up. To add it in the app
instead, go to Settings → Plugins → MCPs → Add → Add MCP server, choose STDIO, and copy the
command and arguments from the ChatGPT block of `print_configs.py` (one Add argument per
line). Save and check that the toggle is on.

Switch to Codex (top left), open the workshop folder as a project, pick **This computer**,
and send the test prompt.

## 7. OpenCode

Start `opencode` and pick a model with `/connect`. To use your Claude subscription, run
`claude auth login` first and choose **Claude Agent**.

Run the OpenCode command from `print_configs.py`, then `opencode run "<test prompt>"`.

Ignore `opencode mcp list` if it says `No MCP servers configured`
([OpenCode bug #55811](https://github.com/anomalyco/opencode/issues/55811)).

---

## 8. Frozen DuckLake

A [frozen DuckLake](https://ducklake.select/2025/10/24/frozen-ducklake/) is a read-only
DuckLake with no catalog server. The catalog is a single `.ducklake` file that points at
Parquet files already sitting in object storage. Readers attach the file and query; nothing
runs except the storage. To publish one, copy the `.ducklake` file to any bucket or web
server. Readers can attach it over `https://` or `s3://` too.

We'll build one over the Hacker News Parquet files in MotherDuck's public bucket: 60 daily
files, `stories` (22,160 rows) and `comments` (253,097 rows), Dec 21, 2024 to Jan 19, 2025.

```bash
# Build data/hacker_news.ducklake (~15s). Registers the files with ducklake_add_data_files;
# no data is copied. Rebuild from scratch: delete data/hacker_news.ducklake first.
uvx --from duckdb-cli==1.5.6 duckdb -f frozen/build_frozen_ducklake.sql

# Query it read-only (no credentials needed)
uvx --from duckdb-cli==1.5.6 duckdb -c "ATTACH 'ducklake:data/hacker_news.ducklake' AS hn (READ_ONLY); USE hn;
SELECT s.title, count(c.id) AS comments FROM stories s JOIN comments c ON c.parent = s.id
GROUP BY ALL ORDER BY comments DESC LIMIT 3;"
```

Expected: *Ask HN: Who wants to be hired? (January 2025)* 493, *I am rich and have no idea
what to do* 430, *The Origins of Wokeness* 320.

The build registers December's files and January's files in separate snapshots, so you can
time travel. `FROM hn.snapshots()` lists 7 snapshots, and
`SELECT count(*) FROM hn.stories AT (VERSION => 3)` returns December only: 6,892 stories.

**From your AI client.** The MCP server opens a new connection for every query, so an
`ATTACH` doesn't carry over to the next tool call. Ask for the attach and the query in one
call, with the absolute path (`print_configs.py` shows your workshop folder):

> Using the duckdb tools, run this as a single query:
> `ATTACH IF NOT EXISTS 'ducklake:<workshop>/data/hacker_news.ducklake' AS hn (READ_ONLY); SELECT count(*) FROM hn.stories`

Expected: 22,160. A `CREATE` or `INSERT` on `hn` fails with *attached in read-only mode*.

**Updating:** register only new files with another `ducklake_add_data_files` call, then
republish the `.ducklake` file. The call doesn't check for duplicates.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `uv` or `uvx` not found | Open a new terminal, or run `uv tool update-shell`. |
| `spawn uvx ENOENT` in a desktop app | Use the full `uvx` path from `print_configs.py` as `command`. |
| Server times out on first start | Run setup step 4. In Codex, add `startup_timeout_sec = 30` under `[mcp_servers.duckdb]` in `~/.codex/config.toml`. |
| `Could not set lock on file ...workshop.duckdb` | Close the read-write `duckdb` session that has the file open. |
| Copilot CLI: `Classic Personal Access Tokens (ghp_) are not supported` | `unset GH_TOKEN` (PowerShell: `Remove-Item Env:GH_TOKEN`) |
| Claude Desktop doesn't show duckdb | Check `mcp-server-duckdb.log` in `~/Library/Logs/Claude/` (macOS) or `%APPDATA%\Claude\logs\` (Windows). |

## Files

| File | What it does |
|---|---|
| `mcp/build_workshop_db.sql` | Builds `data/workshop.duckdb` from MotherDuck's public Iceberg tables |
| `mcp/init.sql` | Loads the iceberg and httpfs extensions on every server connection |
| `mcp/print_configs.py` | Prints each client's config with your absolute paths |
| `frozen/build_frozen_ducklake.sql` | Builds `data/hacker_news.ducklake`, a frozen DuckLake over public Parquet files (section 8) |
| `public_iceberg_datasets.sql` | Example queries over the public Iceberg tables (`uvx --from duckdb-cli==1.5.6 duckdb -f public_iceberg_datasets.sql`) |
