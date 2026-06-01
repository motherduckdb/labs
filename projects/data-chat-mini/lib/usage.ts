/**
 * Shared usage-accumulation + formatters for the UsagePill across surfaces.
 *
 * Both /chat and /prism consume the chat route's per-iteration `usage` SSE
 * events and need to:
 *   - fold token / cost deltas into a running session total
 *   - hold the latest iteration's snapshot for the ctx % indicator
 *   - render the same number formats so the pill reads identically
 *
 * Extracted from app/chat/ChatPanel.tsx with no behavioral change; previously
 * private to that file.
 */
import type { ConversationUsageTotals, TurnUsage } from '@/types/chat';

export interface UsageState {
  totals: ConversationUsageTotals;
  /**
   * Last iteration's snapshot. `promptTokens` is the size of the prompt
   * sent on that call (so it equals the ctx % numerator). `completionTokens`
   * is the assistant response on that call.
   */
  latest?: {
    promptTokens: number;
    completionTokens: number;
    cachedPromptTokens?: number;
    contextWindow: number;
    model: string;
  };
}

export const EMPTY_USAGE_STATE: UsageState = {
  totals: { inputTokens: 0, outputTokens: 0 },
};

/**
 * Fold a single `usage` SSE event into the running totals + latest snapshot.
 * Cost is summed only when reported; if any iteration is missing cost the
 * running sum stays as the partial total we know about — better than
 * dropping data.
 */
export function applyUsageEvent(prev: UsageState, evt: TurnUsage): UsageState {
  const totals: ConversationUsageTotals = {
    inputTokens: prev.totals.inputTokens + (evt.promptTokens || 0),
    outputTokens: prev.totals.outputTokens + (evt.completionTokens || 0),
  };
  if (evt.cost !== undefined || prev.totals.cost !== undefined) {
    totals.cost = (prev.totals.cost ?? 0) + (evt.cost ?? 0);
  }
  return {
    totals,
    latest: {
      promptTokens: evt.promptTokens || 0,
      completionTokens: evt.completionTokens || 0,
      cachedPromptTokens: evt.cachedPromptTokens,
      contextWindow: evt.contextWindow,
      model: evt.model,
    },
  };
}

/** Compact integer formatter (1234 → "1,234"). Tolerates undefined. */
export function formatTokenCount(n: number | undefined | null): string {
  return (n ?? 0).toLocaleString('en-US');
}

/** Up to 4 decimals when small, 2 when ≥ $1 — keeps the pill tidy. */
export function formatCost(cost: number): string {
  if (cost >= 1) return `$${cost.toFixed(2)}`;
  if (cost > 0) return `$${cost.toFixed(4)}`;
  return '$0.00';
}

/**
 * Compact "256K", "1.2M", "12K" formatter for the context-window denominator.
 * Falls through to plain digits under 1k so the absolute number stays
 * readable for tiny prompts.
 */
export function formatTokenShort(n: number | undefined | null): string {
  const v = n ?? 0;
  if (v >= 1_000_000) {
    const m = v / 1_000_000;
    return `${m % 1 === 0 ? m.toFixed(0) : m.toFixed(1)}M`;
  }
  if (v >= 1_000) {
    const k = v / 1_000;
    return `${k % 1 === 0 ? k.toFixed(0) : k.toFixed(1)}K`;
  }
  return String(v);
}
