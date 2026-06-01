import { CONTEXT_PLACEHOLDER } from '@/lib/context-tools';
import type { ChatMessage, ResolvedContextTool } from '@/types/chat';

export type LlmTurn = { role: string; content: unknown };

/** Rebuild LLM-format history from stored display messages. */
export function rebuildHistoryFromMessages(messages: ChatMessage[]): LlmTurn[] {
  const out: LlmTurn[] = [];
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content });
    } else if (m.role === 'assistant') {
      if (m.turnHistory && m.turnHistory.length > 0) {
        out.push(...m.turnHistory);
      } else if (m.content) {
        out.push({ role: 'assistant', content: m.content });
      }
    }
  }
  return out;
}

/** Replace placeholder context tool_results in history with resolved text. */
export function patchHistoryPlaceholders(
  history: LlmTurn[],
  resolved: ResolvedContextTool[],
): void {
  const byId = new Map(resolved.map((r) => [r.callId, r]));
  for (const turn of history) {
    if (turn.role !== 'user' || !Array.isArray(turn.content)) continue;
    for (const block of turn.content as Array<Record<string, unknown>>) {
      if (block.type === 'tool_result' && block.content === CONTEXT_PLACEHOLDER) {
        const r = byId.get(block.tool_use_id as string);
        if (r) {
          block.content = r.resultText;
          if (r.isError) block.is_error = true;
        }
      }
    }
  }
}
