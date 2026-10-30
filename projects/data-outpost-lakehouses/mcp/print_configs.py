# Prints the MCP config for every client with YOUR absolute paths filled in. Copy-paste from here.
# Run from the workshop folder:  uv run mcp/print_configs.py
import json
import shutil
from pathlib import Path

WS = Path(__file__).resolve().parent.parent
DB = str(WS / "data" / "workshop.duckdb")
INIT = str(WS / "mcp" / "init.sql")
UVX = shutil.which("uvx") or "/ABSOLUTE/PATH/TO/uvx"
ARGS = ["--python", "3.13", "--with", "duckdb==1.5.6", "mcp-server-motherduck@1.1.0", "--db-path", DB, "--init-sql", INIT]

cmd = "uvx " + " ".join(f'"{a}"' if a in (DB, INIT) else a for a in ARGS)
server = {"command": UVX, "args": ARGS}


def block(title, body):
    print(f"# -- {title} " + "-" * max(0, 60 - len(title)))
    print(body + "\n")


block("Claude Code", f"claude mcp add --scope user duckdb -- {cmd}")
block("Codex CLI (also sets up the ChatGPT desktop app)", f"codex mcp add duckdb -- {cmd}")
block("GitHub Copilot CLI", f"copilot mcp add duckdb -- {cmd}")
block("OpenCode", f"opencode mcp add --global duckdb -- {cmd}")
block("VS Code: Command Palette > MCP: Open User Configuration, merge in",
      json.dumps({"servers": {"duckdb": {"type": "stdio", **server}}}, indent=2))
block("Cursor (~/.cursor/mcp.json) and Claude Desktop (Settings > Developer > Edit Config), merge in",
      json.dumps({"mcpServers": {"duckdb": server}}, indent=2))
block("ChatGPT desktop app: Settings > Plugins > MCPs > Add MCP server (STDIO)",
      f"Command: {UVX}\nArguments (one per Add argument):\n" + "\n".join(f"  {a}" for a in ARGS))
