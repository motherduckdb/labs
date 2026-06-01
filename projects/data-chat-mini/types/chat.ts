export type ThinkingLevel = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export interface TurnUsage {
  promptTokens: number;
  completionTokens: number;
  cachedPromptTokens?: number;
  reasoningTokens?: number;
  cost?: number;
  model: string;
  contextWindow: number;
}

export interface StreamEvent {
  type: 'text' | 'tool_start' | 'tool_end' | 'usage' | 'mviz_pending' | 'mviz_html' | 'error' | 'done';
  content?: string;
  toolCall?: {
    id: string;
    name: string;
    args?: Record<string, unknown>;
    result?: string;
    error?: boolean;
  };
  id?: string;
  source?: string;
  usage?: TurnUsage;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  segments?: Array<{ type: 'text'; text: string } | { type: 'mviz_pending'; id: string } | { type: 'mviz'; id?: string; html: string }>;
  steps?: Array<{
    id: string;
    name: string;
    status: 'running' | 'complete' | 'error';
    args?: Record<string, unknown>;
    result?: string;
  }>;
  error?: string;
}

export interface StoredConversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  databases: string[];
  messages: ChatMessage[];
}

export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: number;
  databases: string[];
}
