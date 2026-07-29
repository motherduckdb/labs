import { executeToolWithStatus } from './mcp-client';
import { applyToolArgDefaults, detectPayloadFailure } from './tool-invocation';
import { extractDiveSourceForLint, lintDiveSource, formatLintAdvisory } from './dive-linter';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

/**
 * Dispatch a single MCP tool call and pack the result the LLM expects.
 *
 *   - applyToolArgDefaults  — arg massage
 *   - executeToolWithStatus — MCP transport + status capture
 *   - detectPayloadFailure  — surface payload-level `success: false`
 *
 * Plus an advisory react-hooks lint pass on a successful `save_dive`. Unlike
 * mdw-turbo, which returned the advisory in a separate `lintAdvisory` field for
 * the caller to append, quackbot FOLDS it straight into `content` (after a
 * blank line). That keeps DispatchToolResult's shape unchanged and means the
 * agentic loop needs no lint-specific handling — the model just sees the
 * advisory inline in the tool result. Advisory only: a lint finding never turns
 * a successful save into an error.
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

  const diveSource = extractDiveSourceForLint(opts.name, dispatchArgs);
  if (diveSource) {
    const advisory = formatLintAdvisory(lintDiveSource(diveSource));
    if (advisory) {
      return { content: `${content}\n${advisory}`, isError: false };
    }
  }
  return { content, isError: false };
}
