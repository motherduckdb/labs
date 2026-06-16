/**
 * MotherDuck MCP client — forked from data-chat-mini/lib/mcp-client.ts.
 * Used for BOTH data exploration (the agent's SQL tools) AND executing the
 * scored Malloy answer's compiled SQL (all-MotherDuck substrate, matching the
 * baseline). Read-only allowlist enforced.
 *
 * Defaults to PRODUCTION MotherDuck (the baseline's data lives there); override
 * with MOTHERDUCK_API_URL.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export const ALLOWED_TOOLS = new Set([
  'query',
  'list_tables',
  'list_columns',
  'list_databases',
  'search_catalog',
  'ask_docs_question',
]);

export interface MCPTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

function mcpUrl(): string {
  const explicit = process.env.MOTHERDUCK_API_URL?.trim();
  const base = explicit ? explicit.replace(/\/$/, '') : 'https://api.motherduck.com';
  return `${base}/mcp`;
}

export async function createMCPClient(sessionHint?: string): Promise<Client> {
  const token = process.env.MOTHERDUCK_TOKEN;
  if (!token) throw new Error('MOTHERDUCK_TOKEN is not set.');
  const url = new URL(mcpUrl());
  if (sessionHint) url.searchParams.set('session_name', sessionHint);
  const client = new Client({ name: 'agentic-malloy', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  try {
    await client.connect(transport);
    return client;
  } catch (err) {
    try {
      await client.close();
    } catch {
      /* ignore */
    }
    throw err;
  }
}

/** The read-only exploration tools, in Anthropic tool-schema shape. */
export async function getExplorationTools(client: Client): Promise<MCPTool[]> {
  const result = await client.listTools();
  return (result.tools || [])
    .filter((t) => ALLOWED_TOOLS.has(t.name))
    .map((t) => ({
      name: t.name,
      description: t.description || '',
      input_schema: t.inputSchema as Record<string, unknown>,
    }));
}

export interface MCPCallResult {
  text: string;
  isError: boolean;
  /** Parsed structured rows when the tool returned structuredContent. */
  rows?: unknown[];
}

/** Execute an MCP tool. Enforces the read-only allowlist unless `internal`. */
export async function callMcpTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
  internal = false,
): Promise<MCPCallResult> {
  if (!internal && !ALLOWED_TOOLS.has(name)) {
    throw new Error(`Tool "${name}" is not in the allowed (read-only) tool set`);
  }
  const result = await client.callTool({ name, arguments: args });
  const isError = result.isError === true;
  if (result.structuredContent != null) {
    const sc = result.structuredContent as Record<string, unknown>;
    const rows = Array.isArray(sc.rows) ? (sc.rows as unknown[]) : undefined;
    return { text: JSON.stringify(sc), isError, ...(rows && { rows }) };
  }
  const content = result.content;
  const text = Array.isArray(content)
    ? content.map((b: { type: string; text?: string }) => (b.type === 'text' ? b.text : JSON.stringify(b))).join('\n')
    : JSON.stringify(content);
  return { text, isError };
}

/**
 * Run a SQL string on MotherDuck and return positional rows (arrays of values
 * in SELECT order) — the shape score.py expects. Used to execute the compiled
 * Malloy answer's SQL on the all-MotherDuck substrate.
 */
export async function runSqlPositional(
  client: Client,
  sql: string,
  database?: string,
): Promise<unknown[][]> {
  const args: Record<string, unknown> = { query: sql };
  if (database) args.database = database;
  const result = await client.callTool({ name: 'query', arguments: args });
  if (result.isError === true) {
    const msg = Array.isArray(result.content)
      ? result.content.map((b: { text?: string }) => b.text ?? '').join('\n')
      : 'query failed';
    throw new Error(msg);
  }
  const sc = result.structuredContent as Record<string, unknown> | undefined;
  // MCP query returns rows as objects keyed by column; convert to positional
  // arrays preserving column order from the first row's keys.
  const rowObjs = (sc && Array.isArray(sc.rows) ? sc.rows : []) as Array<Record<string, unknown>>;
  if (rowObjs.length === 0) return [];
  const cols = Object.keys(rowObjs[0]);
  return rowObjs.map((r) => cols.map((c) => r[c]));
}
