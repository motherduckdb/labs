import { createMCPClient, executeTool } from '@/lib/mcp-client';
import { isAuthError, authExpiredResponse, getSessionHint } from '@/lib/api-helpers';
import { parseDatabaseNames, parseRawDatabases } from '@/lib/mcp-parsers';
import type { NextRequest } from 'next/server';

export async function GET(request: NextRequest) {
  try {
    const client = await createMCPClient(getSessionHint(request));
    try {
      const result = await executeTool(client, 'list_databases', {});
      return Response.json({
        databases: parseDatabaseNames(result),
        raw: parseRawDatabases(result),
      });
    } finally {
      try { await client.close(); } catch { /* ignore */ }
    }
  } catch (error) {
    console.error('[Databases] Error:', error);
    if (isAuthError(error)) return authExpiredResponse();
    return Response.json({ error: 'Failed to list databases' }, { status: 500 });
  }
}
