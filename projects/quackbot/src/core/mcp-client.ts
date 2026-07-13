import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { getMotherDuckMcpUrl } from './motherduck-env';

/**
 * Read-only allowlist, plus the guide tools that back durable memory.
 *
 * data-chat-mini shadowed `query_context_layer` / `update_context_layer` with
 * LOCAL IndexedDB handlers — those tool *shapes* were an interception, and the
 * live MotherDuck MCP server exposes no such tools (verified against
 * api.motherduck.com/mcp). What the server DOES expose is **guides**: durable
 * markdown documents with list/get/create/update CRUD. quackbot's memory layer
 * is built on them directly — a saved convention becomes a guide under
 * `users/<bot user>/quackbot/`, durable and visible to every future
 * conversation. The dive-authoring guide is a guide too: `get_guide("dives.md")`
 * (the server retired `get_dive_guide`).
 */
export const ALLOWED_TOOLS = new Set([
  'query',
  'list_tables',
  'list_columns',
  'list_databases',
  'search_catalog',
  // Guides: reads are unrestricted; the two writes are additionally gated by
  // the GUIDE_WRITE_PATH guard below.
  'list_guides',
  'get_guide',
  'create_guide',
  'update_guide',
  // Dive tools. Reads (`list_dives`, `read_dive`) are always safe. Among the
  // Dive WRITES, only `save_dive` is allowlisted — see the classification
  // comment below for why the edit tools are deliberately left out.
  'save_dive',
  'list_dives',
  'read_dive',
]);

/**
 * Guide writes may only target quackbot's own namespace: a personal guide
 * folder named `quackbot/` under the bot's MotherDuck user (the server itself
 * enforces the `users/<username>/` half for non-admin tokens; this guard adds
 * the `quackbot/` segment so the bot can never touch other personal guides,
 * and rejects id-only selection so the path check cannot be bypassed).
 */
export const GUIDE_WRITE_PATH = /^users\/[^/]+\/quackbot\/.+/;
const GUIDE_WRITE_TOOLS = new Set(['create_guide', 'update_guide']);

export function guideWriteViolation(
  toolName: string,
  args: Record<string, unknown> | undefined,
): string | null {
  if (!GUIDE_WRITE_TOOLS.has(toolName)) return null;
  // An `id` alongside a valid path could win server-side selection and land
  // the write on an arbitrary guide — path is the only allowed selector.
  if (args && args.id !== undefined && args.id !== null) {
    return `${toolName} must select the guide by \`path\` only — do not pass \`id\`.`;
  }
  const path = args?.path;
  if (typeof path !== 'string' || !GUIDE_WRITE_PATH.test(path)) {
    return (
      `${toolName} may only write guides under users/<username>/quackbot/ ` +
      `(got ${typeof path === 'string' ? `'${path}'` : 'no path'}). ` +
      `Select the guide by \`path\` (not \`id\`), under that folder.`
    );
  }
  // The prefix regex alone would pass `users/x/quackbot/../../other.md`, and a
  // naive `..`/backslash check misses encoded (`%2e%2e`) or Unicode look-alike
  // (fullwidth `．．`) traversal if the server decodes/normalizes the path. So
  // require every segment to be a plain ASCII slug: this one charset check
  // rejects empty segments, backslashes, percent-encoding, whitespace, and any
  // non-ASCII character in a single pass. Dot-only segments still have to be
  // rejected explicitly (they satisfy the charset), while dots *within* a
  // filename (e.g. `v1.2-notes.md`) stay legal.
  const segments = path.split('/');
  if (segments.some((s) => s === '.' || s === '..')) {
    return `${toolName} path may not contain '.' or '..' segments (got '${path}').`;
  }
  if (segments.some((s) => !/^[A-Za-z0-9._-]+$/.test(s))) {
    return (
      `${toolName} path segments must be plain [A-Za-z0-9._-] slugs — no empty, ` +
      `encoded, Unicode, or backslash segments (got '${path}').`
    );
  }
  return null;
}

/**
 * Optional hard allowlist of databases any tool call may target, read from the
 * `QUACKBOT_DATABASES` env (comma-separated). Empty/unset ⇒ no restriction and
 * the MotherDuck token's own grants remain the only boundary (which is the real
 * security wall — the token can physically only reach databases it was granted,
 * even via `use db` or ATTACH). When set, this is defense-in-depth: a tool call
 * whose `database` argument is outside the list is rejected at dispatch, so even
 * a prompt-injected model — or a user's `use db` on an un-listed name — can't
 * steer a query at a database the operator didn't intend the bot to touch.
 *
 * Limitation, stated honestly: this gates the explicit `database` argument only,
 * not a fully-qualified `db.schema.table` reference buried in SQL text. The
 * token-grant boundary still covers that case; this narrows the common path.
 */
export function configuredDatabaseAllowlist(): string[] {
  return (process.env.QUACKBOT_DATABASES ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function databaseAllowViolation(
  args: Record<string, unknown> | undefined,
): string | null {
  const allow = configuredDatabaseAllowlist();
  if (allow.length === 0) return null;
  const db = args?.database;
  if (typeof db === 'string' && db.length > 0 && !allow.includes(db)) {
    return (
      `Database "${db}" is not in this deployment's allowed set ` +
      `(${allow.join(', ')}). Query one of those instead.`
    );
  }
  return null;
}

/**
 * Tool guardrail classification. This is the named boundary between safe reads
 * and gated writes, kept intact even where the allowlist is permissive.
 * `query_rw`, `share_dive_data`, `edit_dive_content`, `update_dive`,
 * `edit_guide_content`, `update_guide_metadata`, `set_guide_access`,
 * `delete_dive`, and `delete_guide` are classified here but absent from
 * ALLOWED_TOOLS, so `executeToolWithStatus` rejects them before they ever
 * reach MotherDuck.
 *
 * Three MUTATING tools are *deliberately* allowlisted:
 *
 *   - `create_guide` / `update_guide` — writing durable data context (join
 *     keys, grain rules, metric defs) is a core feature. Both are additionally
 *     gated by the GUIDE_WRITE_PATH guard above, so they can only touch
 *     quackbot's own guide folder; create_guide is also collision-safe on the
 *     server (a duplicate path errors rather than overwrites).
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
  'search_catalog', 'list_guides', 'get_guide',
  'list_dives', 'read_dive',
]);

export const MUTATING_TOOLS = new Set([
  'query_rw',
  'create_guide',
  'update_guide',
  'edit_guide_content',
  'update_guide_metadata',
  'set_guide_access',
  'save_dive',
  'edit_dive_content',
  'update_dive',
  'share_dive_data',
]);

export const DESTRUCTIVE_TOOLS = new Set([
  'delete_dive',
  'delete_guide',
]);

/**
 * Whether a tool call must pause for explicit user approval.
 *
 * In quackbot v1 nothing pauses for confirmation: Slack has no confirmation
 * handshake yet, so this never gates an executed tool. The function and its
 * classification are retained as the canonical policy boundary. The non-
 * allowlisted writes (`query_rw`, dive edits, guide metadata/access edits,
 * the deletes) can never reach here in practice — they are rejected at the
 * allowlist. The three allowlisted MUTATING tools return false: `create_guide`
 * and `update_guide` (path-guarded to quackbot's own guide folder, so they run
 * unattended) and `save_dive` (always mints a fresh id, so it is safe to run
 * without approval). Restoring confirmation would mean wiring a Slack
 * interactive-button flow (post a "confirm this write?" message, block on the
 * button click) and having callers honor a `true` return here before
 * dispatching.
 */
export function requiresConfirmation(
  toolName: string,
  toolArgs: Record<string, unknown> | undefined,
): boolean {
  if (DESTRUCTIVE_TOOLS.has(toolName)) return true;
  if (!MUTATING_TOOLS.has(toolName)) return false;
  if (toolName === 'create_guide' || toolName === 'update_guide' || toolName === 'save_dive') {
    // v1: these allowlisted writes run without a confirmation handshake (no
    // Slack button flow yet). save_dive mints a fresh dive id so it cannot
    // clobber; the guide writes are confined by GUIDE_WRITE_PATH.
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
 * Create an MCP client authenticated with the MotherDuck token. Guide and
 * Dive writes require a standard write-capable PAT (a read scaling token is
 * read-only by design and would reject them).
 *
 * If a read scaling token IS used (reads-only deployment): it directs each
 * connection to one of the read-only replicas ("ducklings"), so a fleet of
 * concurrent users fans out across replicas on a single token — that
 * distribution comes from the token itself, regardless of any hint.
 * `session_name` (legacy alias `session_hint`) additionally pins a session to
 * a specific replica for cache affinity; we set it to a per-thread key (the
 * Slack thread the request belongs to) so repeated questions in one thread
 * land on the same replica.
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
    throw new Error('No MOTHERDUCK_TOKEN configured. Set a write-capable PAT in .env.');
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
  // Returned as a tool error (not thrown) so the model sees the message and
  // can retry with a conforming path.
  const violation = guideWriteViolation(name, args);
  if (violation) {
    return { text: violation, isError: true };
  }
  // Defense-in-depth: cap which databases a tool call may target (no-op unless
  // QUACKBOT_DATABASES is set). Returned as a tool error so the model can retry
  // against an allowed database rather than crashing the turn.
  const dbViolation = databaseAllowViolation(args);
  if (dbViolation) {
    return { text: dbViolation, isError: true };
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
