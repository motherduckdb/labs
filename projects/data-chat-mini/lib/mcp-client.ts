import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { getMotherDuckMcpUrl } from './motherduck-env';

export interface MCPTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Create an MCP client authenticated with the MotherDuck read scaling token.
 *
 * The token fans read-only connections across replicas. The browser session id
 * is passed as `session_name` so a user's repeat requests can stay warm when
 * the MCP transport forwards the hint.
 */
export async function createMCPClient(sessionHint?: string): Promise<Client> {
  const token = process.env.MOTHERDUCK_TOKEN;
  if (!token) {
    throw new Error('No MOTHERDUCK_TOKEN configured. Set it in .env.local.');
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
    await client.connect(transport);
    return client;
  } catch (error) {
    try { await client.close(); } catch { /* ignore */ }
    throw error;
  }
}

export async function listQueryTool(client: Client): Promise<MCPTool | null> {
  const result = await client.listTools();
  const query = (result.tools || []).find(tool => tool.name === 'query');
  if (!query) return null;
  return {
    name: query.name,
    description: query.description || '',
    inputSchema: query.inputSchema as Record<string, unknown>,
  };
}

export async function executeQuery(client: Client, sql: string): Promise<string> {
  const result = await client.callTool({
    name: 'query',
    arguments: { query: sql },
  });

  if (result.structuredContent != null) {
    return JSON.stringify(result.structuredContent, null, 2);
  }
  return Array.isArray(result.content)
    ? result.content
        .map((block: { type: string; text?: string }) =>
          block.type === 'text' ? block.text : JSON.stringify(block)
        )
        .join('\n')
    : JSON.stringify(result.content);
}
