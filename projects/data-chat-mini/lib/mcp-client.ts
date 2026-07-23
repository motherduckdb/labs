import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { getMotherDuckMcpUrl } from './motherduck-env';

/**
 * Allowlist of MCP tools the app exposes. Reads are unconditional; the guide
 * subsystem is the real "context engine" (it replaced the local IndexedDB
 * context layer — see docs/mcp-tools-integration-plan.md). Guide WRITES are
 * allowed but constrained to private (`access:"user"`) guides by
 * `assertGuideWriteAllowed` / `assertGuideWriteTargetAllowed`.
 *
 * getFilteredTools intersects this set with what the server advertises, so
 * feature-gated or older servers can omit names without breaking the app.
 */
export const ALLOWED_TOOLS = new Set([
  'query',
  'list_tables',
  'list_columns',
  'list_databases',
  'search_catalog',
  'ask_docs_question',
  // Guides — read side (curated org/personal context). Guides are selected by
  // topic (`list_guides({topic})`) and read by uuid (`get_guide({uuid})`);
  // `get_query_guide` is the org-wide bootstrap (query guidance + topic map).
  'get_query_guide',
  'get_guide',
  'list_guides',
  'list_views',
  'list_macros',
  // Guides — write side (the agent persists durable learnings here instead of
  // the old local context layer). Constrained to private guides below.
  'create_guide',
  'update_guide',
  'edit_guide_content',
])

/**
 * Guide write tools. The agent may only create/edit PRIVATE guides
 * (`access: "user"`) — never org-wide truth. On the new topic/uuid surface,
 * privacy is the `access` field (forced to "user" at dispatch), grouping is
 * the `topic` label, and update/edit target guides by uuid. The server rejects
 * uuid writes to guides the token doesn't own and gates org-visible creates;
 * `assertGuideWriteTargetAllowed` additionally refuses to touch any guide that
 * isn't `access: "user"`, so an over-privileged token can't edit org guides
 * through this unauthenticated app.
 */
export const GUIDE_WRITE_TOOLS = new Set([
  'create_guide',
  'update_guide',
  'edit_guide_content',
])

/** Topic namespace for guides the MODEL creates (human UI may use any topic). */
export const MODEL_GUIDE_TOPIC = /^data-chat-mini(\/[a-z0-9._-]+)*$/;

/**
 * Synchronous pre-dispatch checks for guide writes. Applies to every
 * guide-write tool. `internal` marks trusted app routes (the guide manager
 * UI), which may pick any topic; model-driven writes are confined to the
 * `data-chat-mini/…` topic namespace and catalog-only references. Throws with
 * a message the agentic loop surfaces to the model as a tool error.
 */
export function assertGuideWriteAllowed(
  name: string,
  args: Record<string, unknown>,
  internal?: boolean,
): void {
  if (!GUIDE_WRITE_TOOLS.has(name)) return;
  const access = typeof args.access === 'string' ? args.access.toLowerCase() : undefined;
  if (access === 'organization') {
    throw new Error(
      `${name}: this app may only write private guides — set access:"user" (org-wide guides are admin-only).`,
    );
  }
  // The old surface selected guides by path; reject it loudly so the model
  // re-reads the tool schema instead of retrying a dead arg shape.
  if ('path' in args && args.path) {
    throw new Error(
      `${name}: guides are no longer selected by path — create with title+topic, or target an existing guide by the "uuid" returned from list_guides.`,
    );
  }
  if (name === 'create_guide' && !internal) {
    const topic = typeof args.topic === 'string' ? args.topic.trim() : '';
    if (!MODEL_GUIDE_TOPIC.test(topic)) {
      throw new Error(
        `create_guide: saved learnings must use a topic under "data-chat-mini/…" (e.g. "data-chat-mini/joins"); got "${topic || '(no topic)'}".`,
      );
    }
  }
  if (!internal && Array.isArray(args.references)) {
    for (const ref of args.references) {
      const type = ref && typeof ref === 'object' ? (ref as Record<string, unknown>).type : undefined;
      if (type !== 'catalog') {
        throw new Error(
          `${name}: only references of type "catalog" (tables/views the guide explains) are allowed here.`,
        );
      }
    }
  }
}

/** Tools that mutate or destroy an existing guide selected by uuid. */
const UUID_GUIDE_WRITE_TOOLS = new Set([
  'update_guide',
  'edit_guide_content',
  'update_guide_metadata',
  'set_guide_access',
  'delete_guide',
]);

/**
 * get_guide returns rendered text whose second line is
 * "uuid: <uuid> · vN · <access>" — the only place the API exposes a guide's
 * access level for a by-uuid lookup.
 */
export function parseGuideHeader(text: string): { version: number | null; access: string | null } {
  const m = text.match(/^uuid:\s*\S+\s*·\s*v(\d+)\s*·\s*(\w+)\s*$/im);
  return m ? { version: Number(m[1]), access: m[2].toLowerCase() } : { version: null, access: null };
}

/**
 * Async guard for uuid-targeted guide mutations: resolve the target via
 * get_guide and refuse anything that isn't a private (`access: "user"`)
 * guide. The server already rejects writes to guides the token doesn't own —
 * this additionally keeps org-wide guides read-only even if the configured
 * token happens to own them (this app has no per-user auth in front of it).
 * Fails closed when the target can't be resolved.
 */
export async function assertGuideWriteTargetAllowed(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<void> {
  if (!UUID_GUIDE_WRITE_TOOLS.has(name)) return;
  const uuid = typeof args.uuid === 'string' ? args.uuid.trim() : '';
  if (!uuid) {
    throw new Error(`${name}: target the guide by the "uuid" returned from list_guides.`);
  }
  const result = await client.callTool({ name: 'get_guide', arguments: { uuid } });
  const text = Array.isArray(result.content)
    ? result.content
        .map((block) => {
          const b = block as { type: string; text?: string };
          return b.type === 'text' ? (b.text ?? '') : '';
        })
        .join('\n')
    : '';
  if (result.isError === true) {
    throw new Error(`${name}: could not resolve guide ${uuid} to verify access (${text || 'get_guide failed'}).`);
  }
  const { access } = parseGuideHeader(text);
  if (access !== 'user') {
    throw new Error(
      `${name}: guide ${uuid} is ${access ?? 'of unknown access'} — this app may only modify private (access:"user") guides.`,
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
  'get_query_guide', 'get_guide', 'list_guides', 'list_views', 'list_macros',
]);

export const MUTATING_TOOLS = new Set([
  'query_rw',
  'create_guide',
  'update_guide',
  'edit_guide_content',
  'update_guide_metadata',
  'set_guide_access',
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
 * Create an MCP client authenticated with the configured MotherDuck token.
 *
 * A user-scoped PAT is required for the complete guide experience because the
 * guide service needs an authenticated username to create personal guides. A
 * read scaling token can still be used for read-only deployments, but personal
 * guide creation may be unavailable.
 *
 * Read scaling: when such a token is configured, each connection is directed
 * to one of the read-only replicas ("ducklings"), so a fleet of concurrent
 * users fans out across replicas on a single token — that distribution comes
 * from the token itself, regardless of any hint. `session_name` (legacy alias
 * `session_hint`) additionally pins a session to a specific replica for cache
 * affinity; we set it to the per-browser session id.
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
    throw new Error('No MOTHERDUCK_TOKEN configured. Set a production user-scoped PAT in .env.local.');
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
  // Private-guide sandbox: block org-wide writes before dispatch. The sync
  // guard checks args; the async guard resolves uuid targets and refuses any
  // guide that isn't access:"user".
  assertGuideWriteAllowed(name, args, internal);
  await assertGuideWriteTargetAllowed(client, name, args);
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
