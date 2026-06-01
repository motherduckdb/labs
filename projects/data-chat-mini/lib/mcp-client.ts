import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { getMotherDuckMcpUrl } from './motherduck-env';

export interface MCPTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export async function createMCPClient(): Promise<Client> {
  const token = process.env.MOTHERDUCK_TOKEN;
  if (!token) {
    throw new Error('No MOTHERDUCK_TOKEN configured. Set it in .env.local.');
  }

  const client = new Client({ name: 'data-chat-mini', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(getMotherDuckMcpUrl()), {
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
