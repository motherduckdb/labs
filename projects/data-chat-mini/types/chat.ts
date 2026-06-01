export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  /** Raw text from the LLM, including any mviz chart markdown. Used for history sent back to the LLM. */
  content: string;
  timestamp: number;
  isStreaming?: boolean;
  steps?: Step[];
  /** Ordered content segments for rendering — interleaves text with inline mviz charts. */
  segments?: ContentSegment[];
  error?: string;
  /** Structured conversation entries from this turn (tool_use + tool_result blocks) for cross-turn replay. */
  turnHistory?: Array<{ role: string; content: unknown }>;
  /** Context-layer tool calls awaiting a client-side IndexedDB round-trip before the loop resumes. */
  pendingContext?: PendingContextTool[];
}

/**
 * A segment of an assistant message, in stream order. The renderer walks
 * these in sequence; the server determines the ordering by emitting
 * `text` / `mviz_html` events at the right point in the stream.
 */
export type ContentSegment =
  | { type: 'text'; text: string }
  | { type: 'mviz_pending'; id: string }
  | { type: 'mviz'; html: string };

export type Step =
  | { type: 'thinking'; content: string }
  | { type: 'text_block'; content: string }
  | { type: 'tool'; id: string; name: string; status: 'running' | 'complete' | 'error'; args?: Record<string, unknown>; result?: string };

/**
 * The two SSE event shapes emitted by client-side plan tools were removed —
 * this app keeps the surface deliberately small. See PLAN.md "Out of scope".
 */

export type StreamEventType =
  | 'text'
  | 'thinking'
  | 'thinking_done'
  | 'tool_start'
  | 'tool_end'
  | 'context_tool'
  | 'mviz_pending'
  | 'mviz_html'
  | 'turn_complete'
  | 'usage'
  | 'error'
  | 'auth_expired'
  | 'done';

export interface StreamEvent {
  type: StreamEventType;
  content?: string;
  toolCall?: {
    id: string;
    name: string;
    args?: Record<string, unknown>;
    result?: string;
    /** Set on tool_end when the tool returned an error. */
    error?: boolean;
  };
  /** context_tool — the call the client must service against IndexedDB, then re-POST. */
  contextCall?: { callId: string; name: string; args: Record<string, unknown> };
  // mviz_html: `content` holds the rendered HTML, `source` holds the raw markdown block
  // so the client can strip it from the accumulated text segment before inserting the mviz segment.
  source?: string;
  // mviz_pending / mviz_html: stable id pairing a placeholder with its rendered HTML.
  id?: string;
  // usage payload carries the active model id
  model?: string;
  // turn_complete — structured messages from this turn for cross-turn replay
  turnHistory?: Array<{ role: string; content: unknown }>;
  // usage — emitted at the end of each agentic-loop iteration
  usage?: TurnUsage;
}

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

/** A context-layer tool call paused for the client to service against IndexedDB. */
export interface PendingContextTool {
  callId: string;
  name: string;
  args: Record<string, unknown>;
}

/** A context-tool result the client computed locally; sent back to resume the loop. */
export interface ResolvedContextTool {
  callId: string;
  resultText: string;
  isError?: boolean;
}

export interface ChatRequest {
  message: string;
  history: Array<{ role: string; content: unknown }>;
  databases: string[];
  thinkingLevel: ThinkingLevel;
  /** Random per-browser-session id, used as the MotherDuck read-scaling session hint. */
  sessionId?: string;
  /** Results of context-layer tool calls the client serviced locally (resume path). */
  resolvedContext?: ResolvedContextTool[];
}

export type ThinkingLevel = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

/** Full conversation record persisted to IndexedDB. */
export interface StoredConversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  databases: string[];
  thinkingLevel: ThinkingLevel;
  usageTotals?: ConversationUsageTotals;
  messages: ChatMessage[];
}

/** Conversation-wide running totals, updated client-side as `usage` SSE events arrive. */
export interface ConversationUsageTotals {
  inputTokens: number;
  outputTokens: number;
  cost?: number;
}

/** Lightweight row used by the history sidebar. */
export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: number;
  databases: string[];
}
