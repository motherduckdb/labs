/**
 * Schema browser endpoint. Lazy-loads catalog metadata for the schema
 * explorer sidebar — one request per database/table the user expands.
 *
 *  - `?database=foo` (optional `&schema=bar`) → list_tables, plus any
 *    `relatedGuides` the server attests are about this database
 *  - `?database=foo&table=baz` (optional `&schema=bar`) → list_columns
 *
 * Read scaling: the per-session id arrives in the `x-session-id` header and is
 * threaded into the MCP connection as a session hint.
 */
import { createMCPClient, executeTool } from '@/lib/mcp-client';
import { isAuthError, authExpiredResponse, getSessionHint } from '@/lib/api-helpers';
import { parseTables, parseColumns, parseRelatedGuides } from '@/lib/mcp-parsers';
import { NextRequest } from 'next/server';

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const database = params.get('database');
  const schema = params.get('schema') || undefined;
  const table = params.get('table') || undefined;

  if (!database) {
    return Response.json({ error: 'database query param is required' }, { status: 400 });
  }

  try {
    const client = await createMCPClient(getSessionHint(request));
    try {
      if (table) {
        const args: Record<string, unknown> = { database, table };
        if (schema) args.schema = schema;
        const raw = await executeTool(client, 'list_columns', args, true);
        return Response.json({ columns: parseColumns(raw) });
      }
      const args: Record<string, unknown> = { database };
      if (schema) args.schema = schema;
      const raw = await executeTool(client, 'list_tables', args, true);
      return Response.json({ tables: parseTables(raw), relatedGuides: parseRelatedGuides(raw) });
    } finally {
      try { await client.close(); } catch { /* ignore */ }
    }
  } catch (error) {
    console.error('[Schema] Error:', error);
    if (isAuthError(error)) return authExpiredResponse();
    return Response.json({ error: 'Failed to fetch schema' }, { status: 500 });
  }
}
