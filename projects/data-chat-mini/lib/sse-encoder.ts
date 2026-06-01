import type { TurnUsage } from '@/types/chat';

const encoder = new TextEncoder();

function encode(event: Record<string, unknown>): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
}

export function sseText(content: string): Uint8Array {
  return encode({ type: 'text', content });
}

export function sseThinking(content: string): Uint8Array {
  return encode({ type: 'thinking', content });
}

export function sseThinkingDone(): Uint8Array {
  return encode({ type: 'thinking_done' });
}

export interface ToolStartCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export function sseToolStart(toolCall: ToolStartCall): Uint8Array {
  return encode({
    type: 'tool_start',
    toolCall: { id: toolCall.id, name: toolCall.name, args: toolCall.args },
  });
}

export interface ToolEndCall {
  id: string;
  name: string;
  result: string;
  error?: boolean;
}

export function sseToolEnd(toolCall: ToolEndCall): Uint8Array {
  const tc: Record<string, unknown> = {
    id: toolCall.id,
    name: toolCall.name,
    result: toolCall.result,
  };
  if (toolCall.error) tc.error = true;
  return encode({ type: 'tool_end', toolCall: tc });
}

/**
 * Context-layer tool call the client must service against IndexedDB. Pauses
 * the agentic loop; the client re-POSTs with `resolvedContext` to resume.
 */
export function sseContextTool(call: { callId: string; name: string; args: Record<string, unknown> }): Uint8Array {
  return encode({ type: 'context_tool', contextCall: call });
}

export function sseMvizPending(id: string): Uint8Array {
  return encode({ type: 'mviz_pending', id });
}

export function sseMvizHtml(
  content: string,
  opts?: { source?: string; id?: string },
): Uint8Array {
  const event: Record<string, unknown> = { type: 'mviz_html', content };
  if (opts?.source !== undefined) event.source = opts.source;
  if (opts?.id !== undefined) event.id = opts.id;
  return encode(event);
}

export function sseTurnComplete(
  turnHistory: Array<{ role: string; content: unknown }>,
): Uint8Array {
  return encode({ type: 'turn_complete', turnHistory });
}

export function sseUsage(usage: TurnUsage): Uint8Array {
  const u: Record<string, unknown> = {
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
  };
  if (usage.cachedPromptTokens !== undefined) u.cachedPromptTokens = usage.cachedPromptTokens;
  if (usage.reasoningTokens !== undefined) u.reasoningTokens = usage.reasoningTokens;
  if (usage.cost !== undefined) u.cost = usage.cost;
  u.model = usage.model;
  u.contextWindow = usage.contextWindow;
  return encode({ type: 'usage', usage: u });
}

export function sseAuthExpired(content: string): Uint8Array {
  return encode({ type: 'auth_expired', content });
}

export function sseError(content: string): Uint8Array {
  return encode({ type: 'error', content });
}

export function sseDone(): Uint8Array {
  return encode({ type: 'done' });
}
