import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { getMotherDuckMcpUrl } from './motherduck-env';

/**
 * Read-only allowlist. This app talks to MotherDuck for data + catalog only;
 * context-layer fragments are handled LOCALLY (IndexedDB) behind the same
 * `query_context_layer` / `update_context_layer` tool names — see
 * lib/context-tools.ts. Those names are deliberately NOT in this set: they're
 * intercepted before MCP dispatch.
 */
export const ALLOWED_TOOLS = new Set([
  'query',
  'list_tables',
  'list_columns',
  'list_databases',
  'search_catalog',
  'ask_docs_question',
]);

/**
 * Tool guardrail classification. Kept intact even though the app ships
 * read-only: it is the named boundary between safe reads and gated writes.
 * `query_rw` / `update_context_layer` (MCP) / `delete_*` are classified here
 * but absent from ALLOWED_TOOLS, so `executeToolWithStatus` rejects them
 * before they ever reach MotherDuck. Re-enabling a write means adding it to
 * ALLOWED_TOOLS *and* restoring a confirmation handshake — see PLAN.md.
 */
export const READONLY_TOOLS = new Set([
  'query', 'list_tables', 'list_columns', 'list_databases',
  'search_catalog', 'ask_docs_question',
]);

export const MUTATING_TOOLS = new Set([
  'query_rw',
  'update_context_layer',
]);

export const DESTRUCTIVE_TOOLS = new Set([
  'delete_dive',
]);

/**
 * Whether a tool call must pause for explicit user approval. In this read-only
 * build nothing mutating is in the allowlist, so this never fires for an
 * executed tool — but it remains the canonical policy if writes are re-enabled.
 */
export function requiresConfirmation(
  toolName: string,
  toolArgs: Record<string, unknown> | undefined,
): boolean {
  if (DESTRUCTIVE_TOOLS.has(toolName)) return true;
  if (!MUTATING_TOOLS.has(toolName)) return false;
  if (toolName === 'update_context_layer') {
    const action = toolArgs && typeof toolArgs.action === 'string' ? toolArgs.action : undefined;
    return action !== 'create';
  }
  return true;
}

export interface MCPTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Create an MCP client authenticated with the MotherDuck read scaling token.
 *
 * Read scaling: a read scaling token directs each connection to one of the
 * read-only replicas ("ducklings"), so a fleet of concurrent users fans out
 * across replicas on a single token — that distribution comes from the token
 * itself, regardless of any hint. `session_name` (legacy alias `session_hint`)
 * additionally pins a session to a specific replica for cache affinity; we set
 * it to the per-browser session id.
 *
 * Caveat: `session_name` affinity is documented for the DuckDB / Postgres
 * connection strings, NOT (yet) for the MCP HTTP transport. We pass it as a
 * URL query param — honored if the MCP server forwards it, harmless if not
 * (the token still spreads connections across replicas). See:
 * https://motherduck.com/docs/.../read-scaling/#session-affinity-with-session-name
 */
export async function createMCPClient(
  sessionHint?: string,
  requestOptions?: RequestOptions,
): Promise<Client> {
  const token = process.env.MOTHERDUCK_TOKEN;
  if (!token) {
    throw new Error('No MOTHERDUCK_TOKEN configured. Set a read scaling token in .env.local.');
  }

  const url = new URL(getMotherDuckMcpUrl());
  if (sessionHint) {
    url.searchParams.set('session_name', sessionHint);
  }

  const client = new Client({ name: 'data-chat-mini', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: {
      headers: { Authorization: `Bearer ${token}` },
    },
  });

  try {
    await client.connect(transport, requestOptions);
    return client;
  } catch (error) {
    try { await client.close(); } catch { /* ignore */ }
    throw error;
  }
}

export async function getFilteredTools(client: Client): Promise<MCPTool[]> {
  const result = await client.listTools();
  return (result.tools || [])
    .filter(tool => ALLOWED_TOOLS.has(tool.name))
    .map(tool => ({
      name: tool.name,
      description: tool.description || '',
      inputSchema: tool.inputSchema as Record<string, unknown>,
    }));
}

export function mcpToolsToAnthropicFormat(tools: MCPTool[]): Array<{
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}> {
  return tools.map(tool => ({
    name: tool.name,
    description: tool.description || '',
    input_schema: tool.inputSchema,
  }));
}

/**
 * Execute an MCP tool and return both the text content and the `isError`
 * flag from the MCP response.
 */
export async function executeToolWithStatus(
  client: Client,
  name: string,
  args: Record<string, unknown>,
  /** Pass `true` to bypass the allowlist — used by internal read-only routes. */
  internal?: boolean,
  requestOptions?: RequestOptions,
): Promise<{ text: string; isError: boolean }> {
  if (!internal && !ALLOWED_TOOLS.has(name)) {
    throw new Error(`Tool "${name}" is not in the allowed (read-only) tool set`);
  }
  const result = await client.callTool({ name, arguments: args }, undefined, requestOptions);
  if (result.structuredContent != null) {
    return { text: JSON.stringify(result.structuredContent), isError: result.isError === true };
  }
  const text = Array.isArray(result.content)
    ? result.content
        .map((block: { type: string; text?: string }) =>
          block.type === 'text' ? block.text : JSON.stringify(block)
        )
        .join('\n')
    : JSON.stringify(result.content);
  return { text, isError: result.isError === true };
}

export async function executeTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
  internal?: boolean,
  requestOptions?: RequestOptions,
): Promise<string> {
  const { text } = await executeToolWithStatus(client, name, args, internal, requestOptions);
  return text;
}
