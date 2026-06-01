import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { getMotherDuckMcpUrl } from './motherduck-env';

export interface MCPTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export const ALLOWED_TOOLS = new Set([
  'query',
]);

export const READONLY_TOOLS = new Set([
  'query',
]);

export const MUTATING_TOOLS = new Set([
  'query_rw',
  'update_context_layer',
]);

export const DESTRUCTIVE_TOOLS = new Set([
  'delete_dive',
]);

export function requiresConfirmation(
  toolName: string,
  toolArgs: Record<string, unknown> | undefined,
): boolean {
  if (DESTRUCTIVE_TOOLS.has(toolName)) return true;
  if (!MUTATING_TOOLS.has(toolName)) return false;
  if (toolName === 'update_context_layer') {
    const action = toolArgs && typeof toolArgs.action === 'string' ? toolArgs.action : undefined;
    return action !== 'create';
  }
  return true;
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

export async function executeToolWithStatus(
  client: Client,
  name: string,
  args: Record<string, unknown>,
  internal?: boolean,
): Promise<{ text: string; isError: boolean }> {
  if (!internal && !ALLOWED_TOOLS.has(name)) {
    throw new Error(`Tool "${name}" is not in the allowed (read-only) tool set`);
  }
  const result = await client.callTool({
    name,
    arguments: args,
  });

  if (result.structuredContent != null) {
    return { text: JSON.stringify(result.structuredContent, null, 2), isError: result.isError === true };
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
  internal?: boolean,
): Promise<string> {
  const { text } = await executeToolWithStatus(client, name, args, internal);
  return text;
}

export async function executeQuery(client: Client, sql: string): Promise<string> {
  return executeTool(client, 'query', { query: sql });
}
