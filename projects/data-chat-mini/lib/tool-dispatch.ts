import { executeToolWithStatus } from '@/lib/mcp-client';
import { applyToolArgDefaults, detectPayloadFailure } from '@/lib/tool-invocation';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

export async function dispatchTool({
  client,
  name,
  args,
}: {
  client: Client;
  name: string;
  args: Record<string, unknown>;
}): Promise<{ content: string; isError: boolean; errorMessage?: string }> {
  const normalizedArgs = applyToolArgDefaults(name, args);
  const { text, isError } = await executeToolWithStatus(client, name, normalizedArgs);
  const payloadFailure = detectPayloadFailure(text);
  return {
    content: text,
    isError: isError || payloadFailure !== null,
    ...(payloadFailure && { errorMessage: payloadFailure }),
  };
}
