"""
MotherDuck MCP Client

HTTP client for the MotherDuck Model Context Protocol endpoint.
Implements the MCP JSON-RPC protocol for tool calls.
"""

import json
import os
import uuid
from dataclasses import dataclass
from typing import Any

import httpx
from tenacity import retry, stop_after_attempt, wait_exponential


MCP_ENDPOINT = "https://api.motherduck.com/mcp"
MCP_PROTOCOL_VERSION = "2025-03-26"


@dataclass
class MCPToolResult:
    """Result from an MCP tool call."""
    success: bool
    content: Any
    error: str | None = None


class MotherDuckMCPClient:
    """
    Client for MotherDuck's MCP HTTP endpoint.

    Handles authentication, session management, and tool calls.
    """

    def __init__(self, token: str | None = None):
        self.token = token or os.environ.get("MOTHERDUCK_TOKEN")
        if not self.token:
            raise ValueError("MOTHERDUCK_TOKEN not set")

        self.session_id: str | None = None
        self.client = httpx.Client(timeout=60.0)
        self._initialized = False

    def _get_headers(self) -> dict[str, str]:
        """Get headers for MCP requests."""
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "Authorization": f"Bearer {self.token}",
            "Mcp-Protocol-Version": MCP_PROTOCOL_VERSION,
        }
        if self.session_id:
            headers["Mcp-Session-Id"] = self.session_id
        return headers

    def _make_request(self, method: str, params: dict | None = None) -> dict:
        """Make a JSON-RPC request to the MCP endpoint."""
        request_id = str(uuid.uuid4())

        payload = {
            "jsonrpc": "2.0",
            "id": request_id,
            "method": method,
        }
        if params:
            payload["params"] = params

        response = self.client.post(
            MCP_ENDPOINT,
            headers=self._get_headers(),
            json=payload,
        )

        # Check for session ID in response headers
        if "mcp-session-id" in response.headers:
            self.session_id = response.headers["mcp-session-id"]

        # Handle SSE responses
        content_type = response.headers.get("content-type", "")
        if "text/event-stream" in content_type:
            return self._parse_sse_response(response.text, request_id)

        # Handle JSON response
        response.raise_for_status()

        # Handle empty responses (e.g., notifications return 202 with no body)
        if not response.content:
            return {"status": "accepted"}

        return response.json()

    def _parse_sse_response(self, sse_text: str, request_id: str) -> dict:
        """Parse Server-Sent Events response."""
        result = None
        for line in sse_text.split("\n"):
            if line.startswith("data:"):
                data = line[5:].strip()
                if data:
                    try:
                        msg = json.loads(data)
                        # Look for response matching our request ID
                        if msg.get("id") == request_id:
                            result = msg
                    except json.JSONDecodeError:
                        continue

        if result:
            return result

        # Return last valid JSON message if no ID match
        for line in reversed(sse_text.split("\n")):
            if line.startswith("data:"):
                data = line[5:].strip()
                if data:
                    try:
                        return json.loads(data)
                    except json.JSONDecodeError:
                        continue

        raise ValueError(f"No valid response in SSE stream: {sse_text[:500]}")

    def initialize(self) -> dict:
        """Initialize the MCP session."""
        if self._initialized:
            return {"status": "already_initialized"}

        result = self._make_request("initialize", {
            "protocolVersion": MCP_PROTOCOL_VERSION,
            "capabilities": {
                "tools": {}
            },
            "clientInfo": {
                "name": "bird-bench-eval",
                "version": "0.1.0"
            }
        })

        if "error" not in result:
            self._initialized = True
            # Send initialized notification
            self._make_request("notifications/initialized")

        return result

    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=2, max=30),
        reraise=True,
    )
    def call_tool(self, tool_name: str, arguments: dict | None = None) -> MCPToolResult:
        """
        Call an MCP tool.

        Args:
            tool_name: Name of the tool (e.g., "query", "list_tables")
            arguments: Tool arguments

        Returns:
            MCPToolResult with success status and content
        """
        if not self._initialized:
            self.initialize()

        try:
            response = self._make_request("tools/call", {
                "name": tool_name,
                "arguments": arguments or {}
            })

            if "error" in response:
                return MCPToolResult(
                    success=False,
                    content=None,
                    error=response["error"].get("message", str(response["error"]))
                )

            result = response.get("result", {})
            content = result.get("content", [])

            # Extract text content
            text_parts = []
            for item in content:
                if isinstance(item, dict) and item.get("type") == "text":
                    text_parts.append(item.get("text", ""))
                elif isinstance(item, str):
                    text_parts.append(item)

            return MCPToolResult(
                success=True,
                content="\n".join(text_parts) if text_parts else content
            )

        except httpx.HTTPStatusError as e:
            return MCPToolResult(
                success=False,
                content=None,
                error=f"HTTP {e.response.status_code}: {e.response.text[:200]}"
            )
        except Exception as e:
            return MCPToolResult(
                success=False,
                content=None,
                error=str(e)
            )

    def query(self, sql: str, database: str = "bird_bench") -> MCPToolResult:
        """Execute a SQL query."""
        return self.call_tool("query", {
            "sql": sql,
            "database": database
        })

    def list_databases(self) -> MCPToolResult:
        """List all databases."""
        return self.call_tool("list_databases")

    def list_tables(self, database: str, schema: str | None = None) -> MCPToolResult:
        """List tables in a database/schema."""
        args = {"database": database}
        if schema:
            args["schema"] = schema
        return self.call_tool("list_tables", args)

    def list_columns(self, database: str, table: str, schema: str | None = None) -> MCPToolResult:
        """List columns of a table."""
        args = {"database": database, "table": table}
        if schema:
            args["schema"] = schema
        return self.call_tool("list_columns", args)

    def search_catalog(self, query: str) -> MCPToolResult:
        """Search the catalog."""
        return self.call_tool("search_catalog", {"query": query})

    def close(self):
        """Close the client."""
        self.client.close()


# Tool definitions for model providers (OpenAI function calling format)
# NOTE: OpenAI requires ALL properties to be in 'required' array for strict schema validation
MCP_TOOL_DEFINITIONS = [
    {
        "type": "function",
        "function": {
            "name": "query",
            "description": "Execute a read-only SQL query against the MotherDuck database. Use DuckDB SQL syntax.",
            "parameters": {
                "type": "object",
                "properties": {
                    "sql": {
                        "type": "string",
                        "description": "The SQL query to execute. Must be valid DuckDB SQL."
                    },
                    "database": {
                        "type": "string",
                        "description": "The database to query. Use the database specified in the system prompt."
                    }
                },
                "required": ["sql", "database"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "list_tables",
            "description": "List all tables and views in a database schema.",
            "parameters": {
                "type": "object",
                "properties": {
                    "database": {
                        "type": "string",
                        "description": "The database name from the system prompt."
                    },
                    "schema": {
                        "type": "string",
                        "description": "The schema name (e.g., 'california_schools', 'formula_1')."
                    }
                },
                "required": ["database", "schema"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "list_columns",
            "description": "List columns of a table with their data types.",
            "parameters": {
                "type": "object",
                "properties": {
                    "database": {
                        "type": "string",
                        "description": "The database name from the system prompt."
                    },
                    "schema": {
                        "type": "string",
                        "description": "The schema name."
                    },
                    "table": {
                        "type": "string",
                        "description": "The table name."
                    }
                },
                "required": ["database", "schema", "table"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "search_catalog",
            "description": "Fuzzy search across databases, schemas, tables, and columns to find relevant objects.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Search query string."
                    }
                },
                "required": ["query"]
            }
        }
    },
]


if __name__ == "__main__":
    # Test the client
    from dotenv import load_dotenv
    load_dotenv()

    client = MotherDuckMCPClient()

    print("Initializing MCP session...")
    init_result = client.initialize()
    print(f"Init result: {init_result}")

    print("\nListing databases...")
    dbs = client.list_databases()
    print(f"Databases: {dbs}")

    print("\nQuerying bird_bench...")
    result = client.query("SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema NOT IN ('information_schema', 'pg_catalog', 'main') LIMIT 5", "bird_bench")
    print(f"Query result: {result}")

    client.close()
