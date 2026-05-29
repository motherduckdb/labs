import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { getMotherDuckMcpUrl } from './motherduck-env';

/**
 * Create an MCP client authenticated as a specific user.
 *
 * Pass the user's OAuth access token (from `getStoredTokens`) so the MCP
 * call runs as that user — they see their own databases, dives, and
 * `CURRENT_USER`. Falls back to a `MOTHERDUCK_TOKEN` env var for local
 * dev / service-account use.
 */
export async function createMCPClient(
  userToken?: string,
  mcpUrlOverride?: string,
  requestOptions?: RequestOptions,
): Promise<Client> {
  const url = mcpUrlOverride || getMotherDuckMcpUrl();
  const token = userToken || process.env.MOTHERDUCK_TOKEN;

  if (!token) {
    throw new Error('No MotherDuck token available.');
  }

  const client = new Client({
    name: 'motherduck-oauth-nextjs',
    version: '1.0.0',
  });

  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  });

  try {
    await client.connect(transport, requestOptions);
    return client;
  } catch (error) {
    try { await client.close(); } catch { /* ignore */ }
    throw error;
  }
}

/**
 * Execute an MCP tool and return both the text content and the `isError`
 * flag from the MCP response.
 *
 * Prefers `structuredContent` (MCP 2025-03-26+): always plain JSON objects,
 * unaffected by any text-channel encoding (e.g. TOON). Falls back to the
 * text content channel for older tools.
 */
export async function executeToolWithStatus(
  client: Client,
  name: string,
  args: Record<string, unknown>,
  requestOptions?: RequestOptions,
): Promise<{ text: string; isError: boolean }> {
  const result = await client.callTool({ name, arguments: args }, undefined, requestOptions);
  if (result.structuredContent != null) {
    return { text: JSON.stringify(result.structuredContent), isError: result.isError === true };
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
  requestOptions?: RequestOptions,
): Promise<string> {
  const { text } = await executeToolWithStatus(client, name, args, requestOptions);
  return text;
}
