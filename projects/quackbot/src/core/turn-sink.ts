// Canonical spec said './usage', but the ported usage.ts consumes TurnUsage
// from './types' without re-exporting it — so import the type at its home.
import type { TurnUsage } from './types';

/**
 * TurnSink — the surface-agnostic event vocabulary of one agentic turn.
 *
 * data-chat-mini streamed these to the browser as SSE frames (lib/sse-encoder.ts);
 * quackbot has no HTTP stream, so the agentic loop calls a sink directly and the
 * Slack layer implements one. Event ORDER is part of the contract and matches the
 * source SSE stream exactly:
 *
 *   - `onText` / `onThinking` fire as deltas arrive, in stream order.
 *   - `onThinkingDone` fires once per LLM call that produced thinking, after the
 *     stream ends.
 *   - `onMvizPending(id)` fires when a fence OPENER is seen; the matching
 *     `onMvizBlock` carries the same id. Pairing is FIFO: openers produce pending
 *     ids in text order, completed blocks consume them in the same order.
 *   - `onToolStart` always precedes its `onToolEnd`.
 *   - `onUsage` fires once per LLM call (per loop iteration).
 *   - `onTurnComplete` is the final event of a turn that produced messages; it
 *     does NOT fire on the auth-expired early-return (only `onAuthExpired` does).
 */

export type AgenticLoopFinishReason = 'done' | 'iteration_limit' | 'auth_expired';

export interface ToolStartCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolEndCall {
  id: string;
  name: string;
  result: string;
  error?: boolean;
}

export interface MvizBlockEvent {
  /** Pairs with a prior onMvizPending id; '' when the fence produced no placeholder. */
  id: string;
  /**
   * Raw fence source including the opener line (```table ... ```). '' for
   * fallback blocks whose fence never completed. Present even when the fence
   * completed but failed to render, so the consumer can still try a native
   * rendering of the spec.
   */
  source: string;
  /** Built embed HTML (mviz-processor output, or fallback HTML). */
  html: string;
  /** True when the fence never completed / failed to render. */
  fallback?: boolean;
}

export interface TurnSink {
  onText(content: string): void;
  onThinking(content: string): void;
  onThinkingDone(): void;
  onToolStart(call: ToolStartCall): void;
  onToolEnd(call: ToolEndCall): void;
  onMvizPending(id: string): void;
  onMvizBlock(block: MvizBlockEvent): void;
  onUsage(usage: TurnUsage): void;
  onError(message: string): void;
  onAuthExpired(message: string): void;
  onTurnComplete(finishReason: AgenticLoopFinishReason): void;
}
