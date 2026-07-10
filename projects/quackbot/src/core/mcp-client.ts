import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { getMotherDuckMcpUrl } from './motherduck-env';

/**
 * Read-only allowlist, plus the two context-layer tools.
 *
 * Unlike data-chat-mini — which shadowed `query_context_layer` /
 * `update_context_layer` with LOCAL IndexedDB handlers and kept those names OUT
 * of the allowlist so the browser could intercept them before MCP dispatch —
 * quackbot uses the REAL MotherDuck MCP context-layer tools. There is no client
 * round-trip: the fragments live in MotherDuck and the tools dispatch over MCP
 * like every other allowlisted tool. So both names are allowlisted here, and
 * saving durable data context is a first-class feature of the bot, not a
 * browser-side simulation.
 */
export const ALLOWED_TOOLS = new Set([
  'query',
  'list_tables',
  'list_columns',
  'list_databases',
  'search_catalog',
  'ask_docs_question',
  'query_context_layer',
  'update_context_layer',
  // Dive tools. Reads (`list_dives`, `read_dive`, `get_dive_guide`) are always
  // safe. Among the Dive WRITES, only `save_dive` is allowlisted — see the
  // classification comment below for why the edit tools are deliberately left out.
  'save_dive',
  'list_dives',
  'read_dive',
  'get_dive_guide',
]);

/**
 * Tool guardrail classification. This is the named boundary between safe reads
 * and gated writes, kept intact even where the allowlist is permissive.
 * `query_rw`, `share_dive_data`, `edit_dive_content`, `update_dive`, and
 * `delete_dive` are classified here but absent from ALLOWED_TOOLS, so
 * `executeToolWithStatus` rejects them before they ever reach MotherDuck.
 *
 * Two MUTATING tools are *deliberately* allowlisted:
 *
 *   - `update_context_layer` — writing durable data context (join keys, grain
 *     rules, metric defs) is a core feature and there is no browser round-trip
 *     to gate it behind anymore.
 *   - `save_dive` — and ONLY save_dive among the Dive writes. Per mdw-turbo's
 *     isCanvasAutoApproved rationale, save_dive always mints a FRESH dive id,
 *     so it can never clobber an existing dive. `edit_dive_content` and
 *     `update_dive` mutate a caller-supplied id and can silently overwrite a
 *     wrongly-picked dive — and Slack v1 has no confirmation UI to catch that
 *     before it happens, so they stay blocked. Enabling Dive edits later means
 *     allowlisting them AND adding a Slack interactive confirmation flow (post
 *     a "confirm this edit to dive X?" message, block on the button click).
 *
 * Re-enabling any other write means the same: add it to ALLOWED_TOOLS *and*
 * restore a confirmation handshake — see requiresConfirmation below.
 */
export const READONLY_TOOLS = new Set([
  'query', 'list_tables', 'list_columns', 'list_databases',
  'search_catalog', 'ask_docs_question', 'query_context_layer',
  'list_dives', 'read_dive', 'get_dive_guide',
]);

export const MUTATING_TOOLS = new Set([
  'query_rw',
  'update_context_layer',
  'save_dive',
  'edit_dive_content',
  'update_dive',
  'share_dive_data',
]);

export const DESTRUCTIVE_TOOLS = new Set([
  'delete_dive',
]);

/**
 * Whether a tool call must pause for explicit user approval.
 *
 * In quackbot v1 nothing pauses for confirmation: Slack has no confirmation
 * handshake yet, so this never gates an executed tool. The function and its
 * classification are retained as the canonical policy boundary. The non-
 * allowlisted writes (`query_rw`, `edit_dive_content`, `update_dive`,
 * `share_dive_data`, `delete_dive`) can never reach here in practice — they are
 * rejected at the allowlist. The two allowlisted MUTATING tools return false:
 * `update_context_layer` (saving context runs unattended) and `save_dive`
 * (always mints a fresh id, so it is safe to run without approval). Restoring
 * confirmation would mean wiring a Slack interactive-button flow (post a
 * "confirm this write?" message, block on the button click) and having callers
 * honor a `true` return here before dispatching.
 */
export function requiresConfirmation(
  toolName: string,
  toolArgs: Record<string, unknown> | undefined,
): boolean {
  if (DESTRUCTIVE_TOOLS.has(toolName)) return true;
  if (!MUTATING_TOOLS.has(toolName)) return false;
  if (toolName === 'update_context_layer' || toolName === 'save_dive') {
    // v1: these allowlisted writes run without a confirmation handshake (no
    // Slack button flow yet). save_dive mints a fresh dive id so it cannot
    // clobber; update_context_layer is deliberately false for every action.
    return false;
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
 * it to a per-thread key (the Slack thread the request belongs to) so repeated
 * questions in one thread land on the same replica.
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
    throw new Error('No MOTHERDUCK_TOKEN configured. Set a read scaling token in .env.');
  }

  const url = new URL(getMotherDuckMcpUrl());
  if (sessionHint) {
    url.searchParams.set('session_name', sessionHint);
  }

  const client = new Client({ name: 'quackbot', version: '1.0.0' });
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
  requestOptions?: RequestOptions,
): Promise<{ text: string; isError: boolean }> {
  // The allowlist is enforced unconditionally. data-chat-mini had an `internal`
  // flag that bypassed this check for trusted server-side schema reads
  // (list_tables/list_columns from a Next.js API route). quackbot has no such
  // caller — every tool call flows through the agentic loop — so the bypass is
  // removed: there is no public parameter that can dispatch a non-allowlisted
  // (e.g. destructive) tool. Any future internal read path must add its tool to
  // ALLOWED_TOOLS rather than reintroduce a bypass.
  if (!ALLOWED_TOOLS.has(name)) {
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
  requestOptions?: RequestOptions,
): Promise<string> {
  const { text } = await executeToolWithStatus(client, name, args, requestOptions);
  return text;
}
