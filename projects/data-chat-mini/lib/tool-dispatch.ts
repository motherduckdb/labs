import { executeToolWithStatus } from '@/lib/mcp-client';
import { applyToolArgDefaults, detectPayloadFailure } from '@/lib/tool-invocation';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

/**
 * Dispatch a single MCP tool call and pack the result the LLM expects.
 *
 *   - applyToolArgDefaults  — arg massage
 *   - executeToolWithStatus — MCP transport + status capture
 *   - detectPayloadFailure  — surface payload-level `success: false`
 *
 * Side-effect-free: the caller owns SSE emission + controllog.
 */
export interface DispatchToolOpts {
  client: Client;
  name: string;
  args: Record<string, unknown>;
}

export interface DispatchToolResult {
  content: string;
  isError: boolean;
  errorMessage?: string;
}

export async function dispatchTool(opts: DispatchToolOpts): Promise<DispatchToolResult> {
  const dispatchArgs = applyToolArgDefaults(opts.name, opts.args);
  const { text: result, isError: mcpIsError } = await executeToolWithStatus(
    opts.client,
    opts.name,
    dispatchArgs,
  );
  const failure = detectPayloadFailure(opts.name, result);
  const isError = mcpIsError || failure.failed;
  const content = failure.failed
    ? `Tool reported failure: ${failure.message}\n\n${result}`
    : mcpIsError
      ? `Tool returned an error:\n\n${result}`
      : result;

  if (isError) {
    return {
      content,
      isError: true,
      errorMessage: failure.failed ? failure.message : 'mcp_error',
    };
  }
  return { content, isError: false };
}
