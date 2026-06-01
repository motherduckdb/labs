import type { TurnUsage } from '@/types/chat';

const encoder = new TextEncoder();

function event(data: Record<string, unknown>): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(data)}\n\n`);
}

export const sseText = (content: string) => event({ type: 'text', content });
export const sseDone = () => event({ type: 'done' });
export const sseError = (content: string) => event({ type: 'error', content });
export const sseToolStart = (toolCall: { id: string; name: string; args?: Record<string, unknown> }) =>
  event({ type: 'tool_start', toolCall });
export const sseToolEnd = (toolCall: { id: string; name: string; result?: string; error?: boolean }) =>
  event({ type: 'tool_end', toolCall });
export const sseUsage = (usage: TurnUsage) => event({ type: 'usage', usage });
export const sseMvizPending = (id: string) => event({ type: 'mviz_pending', id });
export const sseMvizHtml = (content: string, meta: { id?: string; source?: string } = {}) =>
  event({ type: 'mviz_html', content, ...meta });
export const sseContextTool = (contextCall: { callId: string; name: string; args: Record<string, unknown> }) =>
  event({ type: 'context_tool', contextCall });
export const sseTurnComplete = (turnHistory: Array<{ role: string; content: unknown }>) =>
  event({ type: 'turn_complete', turnHistory });
