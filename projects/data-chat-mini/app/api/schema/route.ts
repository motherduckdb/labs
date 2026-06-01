import { NextRequest } from 'next/server';
import { createMCPClient, executeTool } from '@/lib/mcp-client';
import { parseTables, parseColumns } from '@/lib/mcp-parsers';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

function getSessionHint(request: NextRequest): string | undefined {
  return request.headers.get('x-session-id') || request.nextUrl.searchParams.get('session') || undefined;
}

export async function GET(request: NextRequest) {
  let client: Client | null = null;
  try {
    const database = request.nextUrl.searchParams.get('database') || 'nba_box_scores_v2';
    const table = request.nextUrl.searchParams.get('table');
    client = await createMCPClient(getSessionHint(request));

    if (table) {
      const raw = await executeTool(client, 'list_columns', { database, table });
      return Response.json({ columns: parseColumns(raw) });
    }

    const raw = await executeTool(client, 'list_tables', { database });
    return Response.json({ tables: parseTables(raw) });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return Response.json({ error: message }, { status: 500 });
  } finally {
    if (client) {
      try { await client.close(); } catch { /* ignore */ }
    }
  }
}
