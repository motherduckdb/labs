/**
 * Ported from data-chat-mini types/chat.ts.
 * Only the types referenced by the ported core lib files are included here.
 */

/**
 * Per-iteration usage payload emitted by the chat route. `promptTokens`
 * reflects the prompt sent to the model on *this* iteration, so the client
 * aggregates `promptTokens`/`completionTokens` for billing totals and uses
 * the latest value as the "context fill" indicator.
 */
export interface TurnUsage {
  promptTokens: number;
  completionTokens: number;
  cachedPromptTokens?: number;
  reasoningTokens?: number;
  cost?: number;
  model: string;
  contextWindow: number;
}

/** Conversation-wide running totals, updated client-side as `usage` SSE events arrive. */
export interface ConversationUsageTotals {
  inputTokens: number;
  outputTokens: number;
  cost?: number;
}
