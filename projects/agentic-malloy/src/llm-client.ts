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

// --- Anthropic prompt caching (OpenRouter) -----------------------------------
// Anthropic models via OpenRouter need EXPLICIT cache_control breakpoints or
// prompt caching never kicks in (OpenAI/Gemini cache automatically). We mark the
// system prompt (the static SKILL/primer preamble) and the latest message so the
// preamble AND the growing tool-call history both hit cache on the next turn.

/** True for Anthropic/Claude model ids (the only ones needing explicit cache_control). */
export function isAnthropicModel(model: string): boolean {
  const m = model.toLowerCase();
  return m.includes('anthropic') || m.includes('claude');
}

/** Put `cache_control: { type: 'ephemeral' }` on a message's LAST content block.
 *  String content becomes a single text block; an existing block array gets the
 *  flag on its final block. Returns a NEW message; the input is not mutated. */
function withCacheControl(msg: Record<string, unknown>): Record<string, unknown> {
  const content = msg.content;
  if (typeof content === 'string') {
    return { ...msg, content: [{ type: 'text', text: content, cache_control: { type: 'ephemeral' } }] };
  }
  if (Array.isArray(content) && content.length) {
    const blocks = content.slice();
    blocks[blocks.length - 1] = { ...(blocks[blocks.length - 1] as Record<string, unknown>), cache_control: { type: 'ephemeral' } };
    return { ...msg, content: blocks };
  }
  return msg;
}

/** Mark cache breakpoints on the system message and the latest message. Returns a
 *  NEW array (inputs untouched). Caller should only apply this for Anthropic models. */
export function addAnthropicCacheBreakpoints(messages: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  if (!messages.length) return messages;
  const sysIdx = messages.findIndex((m) => m.role === 'system');
  const lastIdx = messages.length - 1;
  return messages.map((m, i) => (i === sysIdx || i === lastIdx ? withCacheControl(m) : m));
}

export interface CacheTokens {
  cachedTokens: number; // prompt tokens served from cache (a cache HIT)
  cacheWriteTokens: number; // prompt tokens written to cache (a cache WRITE)
}

/** Pull cache token counts out of an OpenRouter `usage` object (both streamed and
 *  non-streamed share the shape). Missing fields → 0. */
export function parseCacheTokens(usage: unknown): CacheTokens {
  const d = (usage as { prompt_tokens_details?: { cached_tokens?: unknown; cache_write_tokens?: unknown } } | undefined)?.prompt_tokens_details;
  return {
    cachedTokens: Number(d?.cached_tokens ?? 0) || 0,
    cacheWriteTokens: Number(d?.cache_write_tokens ?? 0) || 0,
  };
}

function pinnedProvider(provider: string): Record<string, unknown> {
  return { order: [provider], allow_fallbacks: false };
}

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_HEADERS = () => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
  'X-Title': 'agentic-malloy',
  'HTTP-Referer': 'https://github.com/motherduckdb/labs',
});

// --- OpenRouter retry/backoff policy -----------------------------------------
// One reusable policy for BOTH streaming and non-streaming calls: retry 429,
// 408, 5xx, network errors (TypeError from fetch), and retryable stream-setup
// failures, with exponential backoff + jitter, Retry-After support, and a
// per-request timeout. Replaces the old single-shot fetchWithOneRetry.

const RETRY_STATUSES = new Set([408, 409, 429, 500, 502, 503, 504, 522, 524]);
const DEFAULT_MAX_ATTEMPTS = 8;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 120_000;

export interface RetryReport {
  /** Number of retries performed (0 == succeeded on the first attempt). */
  retryCount: number;
}

/** Network errors from fetch surface as TypeError; treat those as retryable. */
function isNetworkError(err: unknown): boolean {
  return err instanceof TypeError || (err instanceof Error && err.name === 'AbortError' && (err as { _timeout?: boolean })._timeout === true);
}

/** Parse a Retry-After header (delta-seconds or HTTP-date) into ms, if present. */
function retryAfterMs(res: Response): number | undefined {
  const h = res.headers.get('retry-after');
  if (!h) return undefined;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(h);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

/** Exponential backoff with full jitter, capped, honouring an explicit hint. */
function backoffMs(attempt: number, hintMs?: number): number {
  if (hintMs !== undefined) return Math.min(hintMs, MAX_DELAY_MS);
  const exp = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
  return Math.floor(Math.random() * exp); // full jitter
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch with the OpenRouter retry policy. Retries retryable HTTP statuses and
 * network errors; on a retryable response it drains the body before retrying.
 * Throws the last error / a status Error once attempts are exhausted. The
 * optional `report` is mutated with the retry count for telemetry.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: { maxAttempts?: number; timeoutMs?: number; onRetry?: (m: string) => void; report?: RetryReport } = {},
): Promise<Response> {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (opts.report) opts.report.retryCount = attempt;
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      // Tag the abort so isNetworkError treats a timeout as retryable.
      (ctrl as { _timeout?: boolean })._timeout = true;
      ctrl.abort();
    }, timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: ctrl.signal });
      clearTimeout(timer);
      if (res.ok || !RETRY_STATUSES.has(res.status) || attempt === maxAttempts - 1) return res;
      // Retryable status: surface a message, drain the body, back off, retry.
      const hint = retryAfterMs(res);
      try { opts.onRetry?.(`HTTP ${res.status}${hint !== undefined ? ` (retry-after ${hint}ms)` : ''}`); } catch { /* ignore */ }
      try { await res.body?.cancel(); } catch { /* ignore */ }
      await sleep(backoffMs(attempt, hint));
      continue;
    } catch (err) {
      clearTimeout(timer);
      // A timeout abort sets _timeout on the controller, not the error; map it.
      const timedOut = (ctrl as { _timeout?: boolean })._timeout === true;
      const retryable = timedOut || isNetworkError(err);
      if (!retryable || attempt === maxAttempts - 1) throw err;
      lastErr = err;
      const msg = timedOut ? `timeout after ${timeoutMs}ms` : err instanceof Error ? err.message : String(err);
      try { opts.onRetry?.(msg); } catch { /* ignore */ }
      await sleep(backoffMs(attempt));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('fetchWithRetry exhausted');
}

/** Single non-streaming completion (text only). Used by layer-build. */
export async function complete(params: {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  maxTokens?: number;
  reasoningEffort?: string;
  provider?: string; // pin OpenRouter to a single upstream provider
  onRetry?: (m: string) => void; // visibility hook for retries (defaults to a console.warn)
}): Promise<{ text: string; promptTokens: number; completionTokens: number; cost?: number } & CacheTokens> {
  let messages: Array<Record<string, unknown>> = [
    { role: 'system', content: params.systemPrompt },
    { role: 'user', content: params.userPrompt },
  ];
  // Anthropic models need explicit cache_control breakpoints via OpenRouter.
  if (isAnthropicModel(params.model)) messages = addAnthropicCacheBreakpoints(messages);
  const body: Record<string, unknown> = {
    model: params.model,
    messages,
    max_tokens: params.maxTokens ?? 36000,
    temperature: 0,
    usage: { include: true },
  };
  if (params.reasoningEffort && params.reasoningEffort !== 'off') body.reasoning = { effort: params.reasoningEffort };
  if (params.provider) body.provider = pinnedProvider(params.provider);

  // A big non-streamed generation (e.g. a 36k-token layer file) can legitimately
  // run past the default 120s — too-short a timeout ABORTS it mid-generation and
  // retries forever. Scale the per-attempt timeout with max_tokens (≈8ms/token,
  // floor 120s, cap 360s). onRetry surfaces any retry so a stall is VISIBLE.
  const timeoutMs = Math.min(360_000, Math.max(120_000, (params.maxTokens ?? 36000) * 8));
  const res = await fetchWithRetry(
    OPENROUTER_URL,
    { method: 'POST', headers: OPENROUTER_HEADERS(), body: JSON.stringify(body) },
    {
      timeoutMs,
      maxAttempts: 4,
      onRetry: params.onRetry ?? ((m) => console.warn(`  ⟳ openrouter retry (${params.model}): ${m}`)),
    },
  );
  if (!res.ok) throw new Error(`OpenRouter error ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
  };
  return {
    text: json.choices?.[0]?.message?.content ?? '',
    promptTokens: json.usage?.prompt_tokens ?? 0,
    completionTokens: json.usage?.completion_tokens ?? 0,
    cost: json.usage?.cost,
    ...parseCacheTokens(json.usage),
  };
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
  /** Mutated with the retry count of the (stream-setup) request, for telemetry. */
  retryReport?: RetryReport;
}): Promise<ReadableStream<Uint8Array>> {
  const { model, messages, tools, systemPrompt, temperature = 0, maxTokens = 36000, reasoningEffort, provider, onFetchRetry, retryReport } = params;

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

  // Anthropic models need explicit cache_control breakpoints via OpenRouter.
  const finalMessages = isAnthropicModel(model) ? addAnthropicCacheBreakpoints(openaiMessages) : openaiMessages;

  const body: Record<string, unknown> = {
    model,
    messages: finalMessages,
    max_tokens: maxTokens,
    temperature,
    stream: true,
    usage: { include: true },
  };
  if (openaiTools && openaiTools.length) body.tools = openaiTools;
  if (reasoningEffort && reasoningEffort !== 'off') body.reasoning = { effort: reasoningEffort };
  if (provider) body.provider = pinnedProvider(provider);

  const response = await fetchWithRetry(
    OPENROUTER_URL,
    { method: 'POST', headers: OPENROUTER_HEADERS(), body: JSON.stringify(body) },
    { onRetry: onFetchRetry, report: retryReport },
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenRouter error ${response.status}: ${text}`);
  }
  return response.body!;
}
