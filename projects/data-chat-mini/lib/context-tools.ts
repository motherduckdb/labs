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
      'STEP 0 of every data question — call this FIRST, before any other data tool ' +
      '(list_tables, list_columns, search_catalog, ask_docs_question, or query). It returns ' +
      'saved context fragments: durable rules about this data (table grain, required filters, ' +
      'join keys, metric definitions, casting rules, data-quality caveats, column meanings) that ' +
      'are NOT visible from raw schema and that change what correct SQL looks like. Reading it ' +
      'first shapes which tables you inspect and how you query. Re-run it whenever you move to a ' +
      'new table, metric, or error. ' +
      'SEARCH IS SIMPLE KEYWORD MATCHING, NOT SEMANTIC: `query` is split into words, each matched ' +
      'as a case-insensitive substring of a fragment\'s title (weighted highest), content, and ' +
      'references. camelCase is split and plurals are stemmed, so "season year" finds `seasonYear` ' +
      'and "games" finds "game". Fragments matching ALL words rank first, falling back to ANY-word ' +
      'matches, with ties broken by recency. So pass a few literal keywords likely to appear in the ' +
      'saved rule (data terms, column/table names, the metric concept) — NOT a long natural-language ' +
      'sentence, which over-constrains the match. With NO `query` at all it returns every fragment ' +
      '(most recent first) — the best move when you are unsure what exists. `reference` substring-' +
      'matches a fragment\'s references (e.g. "database:db.main.table") and AND-combines with `query`; ' +
      '`fragment_ids` fetches exact ids. Provide at least one of `query`, `reference`, or `fragment_ids`.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Space-separated keywords (substring + camelCase/plural-aware) matched against fragment ' +
            'titles, content, and references. A few literal terms beat a full sentence. Omit entirely ' +
            'to list all fragments by recency.',
        },
        reference: { type: 'string', description: 'A schema reference (e.g. "database:db.main.table") substring-matched against each fragment\'s references; AND-combines with `query`.' },
        fragment_ids: { type: 'array', items: { type: 'string' }, description: 'Specific fragment ids to fetch exactly.' },
      },
    },
  },
  {
    name: 'update_context_layer',
    description:
      'Create, update, or delete a saved context fragment. Be conservative — save ' +
      'only durable, reusable insights (NOT one-off query answers or point-in-time ' +
      'facts). Save rules that prevent future wrong answers: join keys, required ' +
      'filters, row-grain caveats, metric definitions, and known data limitations. ' +
      'Keep each fragment SMALL and ATOMIC: one rule per fragment (a single ' +
      'join key, metric definition, grain rule, or caveat) with a focused title and a 1–3 sentence ' +
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
