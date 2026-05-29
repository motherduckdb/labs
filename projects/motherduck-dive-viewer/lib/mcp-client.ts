import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { getMotherDuckMcpUrl } from './motherduck-env';

/**
 * Create an MCP client authenticated as a specific user.
 *
 * The user's OAuth access token is REQUIRED — every MCP call in this app
 * runs as the signed-in user. There is intentionally no service-account /
 * env-var fallback: a request without a valid user token must fail rather
 * than silently run under broader credentials.
 */
export async function createMCPClient(
  userToken: string,
  requestOptions?: RequestOptions,
): Promise<Client> {
  if (!userToken) {
    throw new Error('createMCPClient requires a user access token');
  }

  const url = getMotherDuckMcpUrl();

  const client = new Client({
    name: 'motherduck-dive-viewer',
    version: '1.0.0',
  });

  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${userToken}`,
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
