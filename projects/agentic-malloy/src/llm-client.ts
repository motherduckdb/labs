/**
 * LLM transport — OpenRouter's OpenAI-compatible streaming endpoint. Ported from
 * data-chat-mini/lib/llm-client.ts (message/tool conversion + reasoning), trimmed
 * of the web-only bits. Messages use Anthropic-style content blocks
 * (text/thinking/tool_use/tool_result); we convert to OpenAI format here.
 */

export const MODEL_ALIASES: Record<string, string> = {
  opus: 'anthropic/claude-opus-4.7',
  sonnet: 'anthropic/claude-sonnet-4.6',
  haiku: 'anthropic/claude-haiku-4.5',
  gemini: 'google/gemini-3-flash-preview',
  gpt: 'openai/gpt-5.5',
};

export function resolveModel(idOrAlias: string): string {
  return MODEL_ALIASES[idOrAlias] ?? idOrAlias;
}

export type ContentBlock = Record<string, unknown>;
export interface ChatMessage {
  role: string;
  content: string | ContentBlock[];
}
export interface ToolSchema {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

const FETCH_RETRY_DELAY_MS = 250;

async function fetchWithOneRetry(url: string, init: RequestInit, onRetry?: (m: string) => void): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    if (!(err instanceof TypeError)) throw err;
    try {
      onRetry?.(err.message);
    } catch {
      /* ignore */
    }
    await new Promise((r) => setTimeout(r, FETCH_RETRY_DELAY_MS));
    return await fetch(url, init);
  }
}

export async function streamChatCompletion(params: {
  model: string;
  messages: ChatMessage[];
  tools?: ToolSchema[];
  systemPrompt: string;
  temperature?: number;
  maxTokens?: number;
  reasoningEffort?: string; // low|medium|high|off
  provider?: string;
  onFetchRetry?: (m: string) => void;
}): Promise<ReadableStream<Uint8Array>> {
  const { model, messages, tools, systemPrompt, temperature = 0, maxTokens = 16384, reasoningEffort, provider, onFetchRetry } = params;

  const openaiMessages: Array<Record<string, unknown>> = [{ role: 'system', content: systemPrompt }];
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      openaiMessages.push({ role: msg.role, content: msg.content });
      continue;
    }
    const blocks = msg.content;
    if (msg.role === 'user' && blocks.some((b) => b.type === 'tool_result')) {
      for (const block of blocks) {
        if (block.type === 'tool_result') {
          openaiMessages.push({
            role: 'tool',
            tool_call_id: block.tool_use_id,
            content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
          });
        }
      }
    } else if (msg.role === 'user') {
      openaiMessages.push({ role: 'user', content: blocks });
    } else if (msg.role === 'assistant') {
      const textParts: string[] = [];
      const toolCalls: Array<Record<string, unknown>> = [];
      for (const block of blocks) {
        if (block.type === 'text') textParts.push(block.text as string);
        else if (block.type === 'tool_use') {
          toolCalls.push({ id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(block.input) } });
        }
      }
      const m: Record<string, unknown> = { role: 'assistant' };
      if (textParts.length) m.content = textParts.join('\n');
      if (toolCalls.length) m.tool_calls = toolCalls;
      openaiMessages.push(m);
    }
  }

  const openaiTools = tools?.map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));

  const body: Record<string, unknown> = {
    model,
    messages: openaiMessages,
    max_tokens: maxTokens,
    temperature,
    stream: true,
    usage: { include: true },
  };
  if (openaiTools && openaiTools.length) body.tools = openaiTools;
  if (reasoningEffort && reasoningEffort !== 'off') body.reasoning = { effort: reasoningEffort };
  if (provider) body.provider = { order: [provider] };

  const response = await fetchWithOneRetry(
    'https://openrouter.ai/api/v1/chat/completions',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'X-Title': 'agentic-malloy',
        'HTTP-Referer': 'https://github.com/motherduckdb/labs',
      },
      body: JSON.stringify(body),
    },
    onFetchRetry,
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenRouter error ${response.status}: ${text}`);
  }
  return response.body!;
}
