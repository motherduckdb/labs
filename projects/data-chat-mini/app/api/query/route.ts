import { NextRequest } from 'next/server';
import { createMCPClient, executeQuery, executeTool, listQueryTool } from '@/lib/mcp-client';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

function getSessionHint(request: NextRequest): string | undefined {
  return request.headers.get('x-session-id') || request.nextUrl.searchParams.get('session') || undefined;
}

export async function GET(request: NextRequest) {
  let client: Client | null = null;
  try {
    client = await createMCPClient(getSessionHint(request));
    const tool = await listQueryTool(client);
    if (!tool) {
      return Response.json({ error: 'The MotherDuck MCP server did not expose query.' }, { status: 500 });
    }
    return Response.json({ tool });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return Response.json({ error: message }, { status: 500 });
  } finally {
    if (client) {
      try { await client.close(); } catch { /* ignore */ }
    }
  }
}

export async function POST(request: NextRequest) {
  let client: Client | null = null;
  try {
    const body = await request.json();
    const sql = typeof body.query === 'string' ? body.query : '';
    if (!sql.trim()) {
      return Response.json({ error: 'Provide a SQL string as { "query": "select ..." }.' }, { status: 400 });
    }

    client = await createMCPClient(getSessionHint(request));
    const result = await executeQuery(client, sql);
    return Response.json({ result });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return Response.json({ error: message }, { status: 500 });
  } finally {
    if (client) {
      try { await client.close(); } catch { /* ignore */ }
    }
  }
}

export async function PUT(request: NextRequest) {
  let client: Client | null = null;
  try {
    const body = await request.json();
    const tool = typeof body.tool === 'string' ? body.tool : 'query_rw';
    const args = body.args && typeof body.args === 'object' ? body.args as Record<string, unknown> : {};
    client = await createMCPClient(getSessionHint(request));
    const result = await executeTool(client, tool, args);
    return Response.json({ result });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return Response.json({ error: message }, { status: 400 });
  } finally {
    if (client) {
      try { await client.close(); } catch { /* ignore */ }
    }
  }
}
