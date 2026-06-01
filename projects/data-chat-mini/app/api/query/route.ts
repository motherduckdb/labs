import { createMCPClient, executeQuery, listQueryTool } from '@/lib/mcp-client';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

export async function GET() {
  let client: Client | null = null;
  try {
    client = await createMCPClient();
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

export async function POST(request: Request) {
  let client: Client | null = null;
  try {
    const body = await request.json();
    const sql = typeof body.query === 'string' ? body.query : '';
    if (!sql.trim()) {
      return Response.json({ error: 'Provide a SQL string as { "query": "select ..." }.' }, { status: 400 });
    }

    client = await createMCPClient();
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
