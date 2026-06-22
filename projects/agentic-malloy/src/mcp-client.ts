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

// --- transport retry ---------------------------------------------------------
// Connect / listTools / callTool can fail for TRANSPORT reasons (network blip,
// dropped HTTP session, 5xx/429 from the MCP endpoint) — those are retryable.
// They can also fail for SEMANTIC reasons (a bad SQL query, an unknown tool):
// the SDK surfaces semantic failures as a RESOLVED result with isError=true,
// NOT a thrown error, so retrying only thrown transport errors never masks a
// model-visible query/compiler error.

const MCP_MAX_ATTEMPTS = 4;
const MCP_BASE_DELAY_MS = 300;
const MCP_MAX_DELAY_MS = 5_000;

/** A thrown MCP error is transport-level unless it's clearly a protocol/usage
 *  error (e.g. JSON-RPC "method not found"/"invalid params"); those won't get
 *  better with a retry, so don't waste attempts on them. */
function isRetryableTransportError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (/invalid params|method not found|-32600|-32601|-32602|not in the allowed/.test(msg)) return false;
  return true;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Module-scoped retry tally per session-hinted client, so the harness can read
 *  how many transport retries a task incurred. Keyed by the Client instance. */
const mcpRetries = new WeakMap<Client, { count: number }>();
export function mcpRetryCount(client: Client): number {
  return mcpRetries.get(client)?.count ?? 0;
}

async function withTransportRetry<T>(client: Client | null, label: string, fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < MCP_MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryableTransportError(err) || attempt === MCP_MAX_ATTEMPTS - 1) throw err;
      if (client) {
        const slot = mcpRetries.get(client) ?? { count: 0 };
        slot.count++;
        mcpRetries.set(client, slot);
      }
      const delay = Math.min(MCP_BASE_DELAY_MS * 2 ** attempt, MCP_MAX_DELAY_MS);
      await sleep(Math.floor(Math.random() * delay));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`MCP ${label} failed`);
}

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
  mcpRetries.set(client, { count: 0 }); // track connect retries on this client too
  try {
    // A fresh transport per attempt — a half-open transport from a failed
    // connect cannot be reused.
    await withTransportRetry(client, 'connect', () =>
      client.connect(
        new StreamableHTTPClientTransport(url, {
          requestInit: { headers: { Authorization: `Bearer ${token}` } },
        }),
      ),
    );
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
  const result = await withTransportRetry(client, 'listTools', () => client.listTools());
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
  // Retry only THROWN transport failures. A semantic failure (bad SQL, etc.)
  // comes back as a resolved result with isError=true and is returned to the
  // model unchanged — never retried.
  const result = await withTransportRetry(client, `callTool:${name}`, () =>
    client.callTool({ name, arguments: args }),
  );
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
  // Production MotherDuck MCP `query` requires database + sql + new_fragments.
  const args: Record<string, unknown> = {
    database: database ?? process.env.MD_DATABASE ?? 'agentic_sql_claude',
    sql,
    new_fragments: [],
  };
  const result = await withTransportRetry(client, 'query', () => client.callTool({ name: 'query', arguments: args }));
  if (result.isError === true) {
    const msg = Array.isArray(result.content)
      ? result.content.map((b: { text?: string }) => b.text ?? '').join('\n')
      : 'query failed';
    throw new Error(msg);
  }
  const sc = result.structuredContent as { rows?: unknown[] } | undefined;
  // The MotherDuck MCP `query` returns rows already as positional arrays
  // ({columns, rows: [[v0, v1], ...]}) — exactly score.py's shape.
  if (sc && Array.isArray(sc.rows)) return sc.rows as unknown[][];
  return [];
}
