import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { getMotherDuckMcpUrl } from './motherduck-env';

/**
 * Allowlist of MCP tools the app exposes. Reads are unconditional; the guide
 * subsystem is the real "context engine" (it replaced the local IndexedDB
 * context layer — see docs/mcp-tools-integration-plan.md). Guide WRITES are
 * allowed but constrained to private personal guides by `assertGuideWriteAllowed`.
 *
 * getFilteredTools intersects this set with what the server advertises, so
 * against prod (no guides yet) these staging-only names simply never appear —
 * safe to allowlist unconditionally.
 */
export const ALLOWED_TOOLS = new Set([
  'query',
  'list_tables',
  'list_columns',
  'list_databases',
  'search_catalog',
  'ask_docs_question',
  // Guides — read side (curated org/personal context).
  'get_guide',
  'list_guides',
  'list_views',
  'list_macros',
  // Guides — write side (the agent persists durable learnings here instead of
  // the old local context layer). Constrained to personal guides below.
  'create_guide',
  'update_guide',
  'edit_guide_content',
])

/**
 * Guide write tools. The agent may only create/edit PERSONAL guides
 * (`users/<you>/…`, private) — never org-wide truth. `create_guide` is guarded
 * on path + access here; `update_guide`/`edit_guide_content` rely on the
 * server enforcing per-owner access (a non-admin token cannot own org guides).
 */
export const GUIDE_WRITE_TOOLS = new Set([
  'create_guide',
  'update_guide',
  'edit_guide_content',
])

/** Personal-guide namespace: the only paths guide writes may target. */
export function isPersonalGuidePath(path: unknown): path is string {
  return typeof path === 'string' && /^users\//i.test(path.trim());
}

/**
 * Reject guide writes that would escape the personal-guide sandbox. Applies to
 * EVERY guide-write tool (create/update/edit), not just create — an
 * `update_guide`/`edit_guide_content` targeting an org path (e.g.
 * `revenue-billing/foo.md`) or an opaque `id` must not slip through, since these
 * tools are model-visible and the app token can edit existing guides. Throws
 * with a message the agentic loop surfaces to the model as a tool error.
 */
export function assertGuideWriteAllowed(name: string, args: Record<string, unknown>): void {
  if (!GUIDE_WRITE_TOOLS.has(name)) return;
  const access = typeof args.access === 'string' ? args.access.toLowerCase() : undefined;
  if (access === 'organization') {
    throw new Error(
      `${name}: this app may only write personal guides — set access:"user" (org-wide guides are admin-only).`,
    );
  }
  // id-based targeting can't be namespace-checked before dispatch — require a path.
  if ('id' in args && args.id) {
    throw new Error(
      `${name}: target the guide by its "users/<username>/…" path, not id — guide writes are limited to personal guides.`,
    );
  }
  if (!isPersonalGuidePath(args.path)) {
    throw new Error(
      `${name}: writes are limited to personal guides under "users/<username>/…" (got "${typeof args.path === 'string' ? args.path : '(no path)'}"). Org-wide guides are read-only here.`,
    );
  }
}

/**
 * Tool guardrail classification — the named boundary between safe reads and
 * gated writes. Data stays read-only (`query_rw` classified but NOT allowlisted,
 * so it never reaches MotherDuck). The only writes the app permits are personal
 * guide edits (the context engine), guarded by `assertGuideWriteAllowed`.
 */
export const READONLY_TOOLS = new Set([
  'query', 'list_tables', 'list_columns', 'list_databases',
  'search_catalog', 'ask_docs_question',
  'get_guide', 'list_guides', 'list_views', 'list_macros',
]);

export const MUTATING_TOOLS = new Set([
  'query_rw',
  'create_guide',
  'update_guide',
  'edit_guide_content',
]);

export const DESTRUCTIVE_TOOLS = new Set([
  'delete_dive',
  'delete_guide',
]);

/**
 * Whether a tool call must pause for explicit user approval. Personal guide
 * writes are auto-allowed (private, versioned, reversible — matching the old
 * local context-layer create UX); destructive tools and data writes would
 * require confirmation, but neither is in ALLOWED_TOOLS.
 */
export function requiresConfirmation(
  toolName: string,
  _toolArgs: Record<string, unknown> | undefined,
): boolean {
  if (DESTRUCTIVE_TOOLS.has(toolName)) return true;
  if (!MUTATING_TOOLS.has(toolName)) return false;
  // Guide writes are personal-only (see assertGuideWriteAllowed) and reversible.
  if (GUIDE_WRITE_TOOLS.has(toolName)) return false;
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
    throw new Error(`Tool "${name}" is not in the allowed tool set`);
  }
  // Personal-guide sandbox: block org-wide / non-users writes before dispatch.
  assertGuideWriteAllowed(name, args);
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
