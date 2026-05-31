/**
 * Context-layer tools, declared with the SAME names + arg shapes as the
 * MotherDuck MCP context-layer tools (`query_context_layer`,
 * `update_context_layer`) — so this is swappable to the real MCP later.
 *
 * They are advertised to the model alongside the read-only MCP tools, but the
 * agentic loop intercepts them: instead of dispatching to MotherDuck, it emits
 * a `context_tool` SSE event and pauses. The browser services the call against
 * IndexedDB (lib/context-store.ts) and re-POSTs with the result.
 */

export const CONTEXT_TOOL_NAMES = new Set(['query_context_layer', 'update_context_layer']);

/** Placeholder a context tool_result holds until the client patches it on resume. */
export const CONTEXT_PLACEHOLDER = '[context-layer call pending client round-trip]';

export function isContextTool(name: string): boolean {
  return CONTEXT_TOOL_NAMES.has(name);
}

export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export const CONTEXT_TOOLS: AnthropicTool[] = [
  {
    name: 'query_context_layer',
    description:
      'Read saved context fragments — durable, reusable knowledge about this data ' +
      '(join keys, metric definitions, data-quality caveats, column meanings). ' +
      'Call this before writing SQL to reuse what is already known. Provide at least ' +
      'one of `query` (keyword search), `reference` (a database/table ref like ' +
      '"database:db.main.table"), or `fragment_ids`.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keyword search across fragment titles/content.' },
        reference: { type: 'string', description: 'A schema reference to match fragments against.' },
        fragment_ids: { type: 'array', items: { type: 'string' }, description: 'Specific fragment ids to fetch.' },
      },
    },
  },
  {
    name: 'update_context_layer',
    description:
      'Create, update, or delete a saved context fragment. Be conservative — save ' +
      'only durable, reusable insights (NOT one-off query answers or point-in-time ' +
      'facts). Keep each fragment SMALL and ATOMIC: one rule per fragment (a single ' +
      'join key, metric definition, or caveat) with a focused title and a 1–3 sentence ' +
      'body — never a multi-point "summary" blob. For several distinct insights, make ' +
      'several small create calls, one per insight. But save each insight exactly once: ' +
      'always `query_context_layer` first to avoid near-duplicates, prefer ' +
      'action="update" over a parallel create, and never re-save a refined version of ' +
      'something you just saved this turn.',
    input_schema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['create', 'update', 'delete'] },
        id: { type: 'string', description: 'Fragment id (required for update/delete).' },
        title: { type: 'string' },
        content: { type: 'string', description: 'The insight + how to use it. Generalizable, not a snapshot.' },
        references: {
          type: 'array',
          items: { type: 'string' },
          description: 'Schema references this fragment applies to, e.g. "database:db.main.table".',
        },
      },
    },
  },
];
