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
 * markdown documents addressed by **uuid**, organized under a slash-separated
 * `topic` label, with an `access` scope (`user` = private, `organization` =
 * org-wide). quackbot's memory layer is built on them directly — a saved
 * convention becomes a private (`access:'user'`) guide under a `quackbot/<area>`
 * topic, durable and visible to every future conversation of the bot.
 *
 * The old path-selected API (`get_guide("dives.md")`, `create_guide` namespaced
 * by a `users/<user>/quackbot/` path that collided server-side on duplicates) is
 * gone. Selection is now by uuid; `create_guide` ALWAYS mints a fresh uuid, so a
 * duplicate title+topic silently forks a second guide rather than erroring — the
 * only defense against dupes is prompt discipline (`list_guides({topic})` before
 * a create, update-by-uuid instead of re-creating). The dive-authoring guide is
 * back as its own tool, `get_dive_guide({client})` (no longer a `dives.md` guide).
 */
export const ALLOWED_TOOLS = new Set([
  'query',
  'list_tables',
  'list_columns',
  'list_databases',
  'search_catalog',
  // Read-only discovery/docs added with the new server surface.
  'list_views',
  'list_macros',
  'list_shares',
  'ask_docs_question',
  // Org query guidance + topic map (server's own `query` description now tells
  // the model to call this first, so it must be reachable) and the dive guide.
  'get_query_guide',
  'get_dive_guide',
  // Guides: reads are unrestricted; the writes are additionally gated by the
  // topic/access/uuid guard below (defense-in-depth — server ACL is the real
  // wall). `edit_guide_content` is now allowlisted for surgical memory fixes.
  'list_guides',
  'get_guide',
  'create_guide',
  'update_guide',
  'edit_guide_content',
  // Dive tools. Reads (`list_dives`, `read_dive`) are always safe. Among the
  // Dive WRITES, only `save_dive` is allowlisted — see the classification
  // comment below for why the edit tools are deliberately left out.
  'save_dive',
  'list_dives',
  'read_dive',
]);

/**
 * Guide-write guard for the uuid+topic API. This is defense-in-depth, NOT the
 * security wall: Phase-0 probes confirmed the server ACL rejects cross-user
 * uuid writes and gates org-visible creates for the bot's non-admin PAT. What
 * this guard buys is (a) keeping the bot's memories inside a `quackbot/` topic
 * convention, (b) forcing private (`access:'user'`) scope so a memory can never
 * be published org-wide, (c) restricting attached `references` to catalog
 * (table/column) targets we can trust, and (d) catching the model's malformed
 * arg shapes (flat edit fields, empty uuid) as a self-correctable tool error
 * instead of burning a turn on a server rejection.
 *
 * Violations are returned as strings (tool errors), never thrown, so the model
 * sees the message and can retry with conforming args.
 */
const GUIDE_WRITE_TOOLS = new Set(['create_guide', 'update_guide', 'edit_guide_content']);

// Topic label: `quackbot` itself, or `quackbot/<area>[/<area>…]` where each
// segment is a lowercase kebab-case slug. NOTE the charset admits dot-only
// segments (`quackbot/../x`) — those are rejected explicitly below so a topic
// can never mimic path traversal, while dots *within* a segment (`v1.2`) stay
// legal.
const GUIDE_TOPIC = /^quackbot(\/[a-z0-9._-]+)*$/;

function topicViolation(topic: unknown): string | null {
  if (typeof topic !== 'string' || !GUIDE_TOPIC.test(topic)) {
    return (
      `create_guide must set \`topic\` to 'quackbot' or a 'quackbot/<area>' slug ` +
      `(lowercase [a-z0-9._-] segments, slash-separated) so the memory stays in ` +
      `quackbot's own namespace (got ${typeof topic === 'string' ? `'${topic}'` : 'no topic'}).`
    );
  }
  if ((topic as string).split('/').some((s) => s === '.' || s === '..')) {
    return `create_guide \`topic\` may not contain '.' or '..' segments (got '${topic}').`;
  }
  return null;
}

// Force private scope: the bot never publishes org-wide (that's also server-
// gated for its PAT). `access` may be omitted (server defaults to 'user') or
// explicitly 'user'; anything else is a violation.
function accessViolation(toolName: string, args: Record<string, unknown> | undefined): string | null {
  const access = args?.access;
  if (access !== undefined && access !== 'user') {
    return (
      `${toolName} may only write private guides (\`access: 'user'\`, the default). ` +
      `quackbot never publishes org-wide — omit \`access\` or set it to 'user' ` +
      `(got ${typeof access === 'string' ? `'${access}'` : String(access)}).`
    );
  }
  return null;
}

// v1 allows only `catalog` references (a table/column the memory describes, so
// the guide auto-surfaces in future list_tables/search_catalog). guide/dive/
// flight references point at objects we can't verify here, so they're rejected.
function referencesViolation(toolName: string, args: Record<string, unknown> | undefined): string | null {
  const refs = args?.references;
  if (refs === undefined || refs === null) return null;
  if (!Array.isArray(refs)) {
    return `${toolName} \`references\` must be an array of {type:'catalog', …} entries.`;
  }
  for (const ref of refs) {
    const type = (ref as { type?: unknown } | null)?.type;
    if (type !== 'catalog') {
      return (
        `${toolName} may only attach \`references\` of type 'catalog' (the table/column ` +
        `a memory describes); got ${typeof type === 'string' ? `'${type}'` : String(type)}. ` +
        `Drop guide/dive/flight references.`
      );
    }
  }
  return null;
}

function uuidViolation(toolName: string, args: Record<string, unknown> | undefined): string | null {
  const uuid = args?.uuid;
  if (typeof uuid !== 'string' || uuid.length === 0) {
    return (
      `${toolName} must select the guide by a non-empty \`uuid\` ` +
      `(use list_guides({topic}) to find it) — got ${typeof uuid === 'string' ? 'an empty string' : 'no uuid'}.`
    );
  }
  return null;
}

export function guideWriteViolation(
  toolName: string,
  args: Record<string, unknown> | undefined,
): string | null {
  if (!GUIDE_WRITE_TOOLS.has(toolName)) return null;

  if (toolName === 'create_guide') {
    // topic-selected; always mints a fresh uuid — no ownership question.
    return topicViolation(args?.topic)
      ?? accessViolation(toolName, args)
      ?? referencesViolation(toolName, args);
  }

  if (toolName === 'update_guide') {
    // uuid-selected. No ownership pre-check: the server ACL rejects writes to
    // guides this PAT doesn't own, and get_guide returns unstructured {text}
    // anyway, so a client-side resolve would buy nothing.
    return uuidViolation(toolName, args)
      ?? accessViolation(toolName, args)
      ?? referencesViolation(toolName, args);
  }

  // edit_guide_content — uuid-selected surgical edits. The server takes an
  // `edits` ARRAY ([{old_string, new_string, replace_all?}], minItems 1), NOT
  // flat old_string/new_string fields; catch the flat shape here so the model
  // rebuilds it as an array rather than getting a server schema error.
  const uuidErr = uuidViolation(toolName, args);
  if (uuidErr) return uuidErr;
  const edits = args?.edits;
  if (!Array.isArray(edits) || edits.length === 0) {
    return (
      `edit_guide_content requires an \`edits\` array of at least one ` +
      `{old_string, new_string, replace_all?} entry — not flat old_string/new_string fields.`
    );
  }
  for (const edit of edits) {
    const e = edit as { old_string?: unknown; new_string?: unknown } | null;
    if (typeof e !== 'object' || e === null || typeof e.old_string !== 'string' || typeof e.new_string !== 'string') {
      return (
        `edit_guide_content \`edits\` entries must be objects with string \`old_string\` ` +
        `and \`new_string\` (plus optional boolean \`replace_all\`).`
      );
    }
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
 * `update_guide_metadata`, `set_guide_access`, `delete_dive`, and
 * `delete_guide` are classified here but absent from ALLOWED_TOOLS, so
 * `executeToolWithStatus` rejects them before they ever reach MotherDuck.
 *
 * `set_guide_access` in particular stays blocked: it is the org-wide publish
 * switch (flips a private bot memory to organization-visible), and would
 * bypass the `access:'user'` forcing on the write guard. `update_guide_metadata`
 * stays blocked too — re-topicing is how a guide would escape the `quackbot/`
 * namespace convention. (Both are also server-gated for the bot's PAT.)
 *
 * Four MUTATING tools are *deliberately* allowlisted:
 *
 *   - `create_guide` / `update_guide` / `edit_guide_content` — writing and
 *     refining durable data context (join keys, grain rules, metric defs) is a
 *     core feature. All three are gated by the topic/access/uuid guard above
 *     (defense-in-depth) and by the confirmation handshake below. Note there is
 *     no longer any server-side collision safety: `create_guide` always mints a
 *     fresh uuid, so a duplicate silently forks — dedup is prompt-enforced
 *     (`list_guides({topic})` before create, update-by-uuid to revise).
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
  'search_catalog', 'list_views', 'list_macros', 'list_shares',
  'ask_docs_question',
  'list_guides', 'get_guide', 'get_query_guide', 'get_dive_guide',
  'get_flight_guide',
  'list_dives', 'read_dive', 'view_dive', 'dive_query',
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
 * Whether a tool call must pause for explicit user approval before it runs.
 *
 * Every mutating or destructive tool requires confirmation. In practice only
 * the four allowlisted writes (`create_guide` / `update_guide` /
 * `edit_guide_content` / `save_dive`) can actually reach here — the rest are
 * rejected at the allowlist first — so this gates exactly those. The agentic
 * loop honors a `true` return by calling its `confirmTool` (the Slack
 * Approve/Deny handshake in `src/slack/confirm.ts`) and only dispatching on
 * approval. This is what stops prompt-injected content from committing an
 * unattended durable write; the guide-write guard and save_dive's fresh-id
 * behavior remain as the confinement backstop.
 *
 * `toolArgs` is unused today but kept in the signature so a future policy can
 * confirm selectively (e.g. only `update_guide` overwrites, not first creates).
 */
export function requiresConfirmation(
  toolName: string,
  toolArgs: Record<string, unknown> | undefined,
): boolean {
  void toolArgs;
  return DESTRUCTIVE_TOOLS.has(toolName) || MUTATING_TOOLS.has(toolName);
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
  // can retry with conforming args.
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
