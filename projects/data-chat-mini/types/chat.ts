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
