// LLM transport: OpenRouter's OpenAI-compatible endpoint via direct `fetch`
// (see streamChatCompletion). The `reasoning` (thinking) param only works on
// that endpoint, and we hand-convert Anthropic-style messages to OpenAI format.

// ---------------------------------------------------------------------------
// Single-model profile (default: Gemini 3 Flash; swap via OPENROUTER_MODEL).
// ---------------------------------------------------------------------------

export interface ModelProfile {
  id: string;
  maxTokens: number;
  supportsReasoning: boolean;
  /**
   * Preferred OpenRouter upstream provider (e.g. `"Google AI Studio"`,
   * `"Anthropic"`). When set, passed as `provider.order` so OpenRouter
   * prefers this provider — pins prompt-cache state to one backend instead
   * of silently rotating between providers and cold-starting the cache.
   * Fallbacks remain enabled by default so a provider outage still routes.
   */
  provider?: string;
  /**
   * Approximate prompt-token capacity. Used by the client to render a
   * "% context full" indicator. Resolved by `getContextWindow` from the
   * model id; the values are deliberately rough — OpenRouter routes the
   * same id to upstreams with subtly different real limits, so what we
   * really want is "is the user getting close" not exact accounting.
   */
  contextWindow: number;
}

/**
 * Best-effort context-window lookup keyed off the OpenRouter model id.
 * Add specific cases for families you know about and fall through to a
 * conservative default. Only used for the UI pill — consequence of being
 * off is a slightly wrong percentage, not a routing decision.
 */
export function getContextWindow(modelId: string): number {
  const id = modelId.toLowerCase();
  // Anthropic 1M-context variants (explicit suffix in the id).
  if (/(opus|sonnet)[-_]?4[-_.]?7[-_.]?(1m|extended)/i.test(id) || /(:1m|@1m|-1m)/.test(id)) {
    return 1_000_000;
  }
  // Anthropic Claude 3+ standard context.
  if (/claude-(3|opus|sonnet|haiku|4|opus-4|sonnet-4|haiku-4)/.test(id)) return 200_000;
  // Gemini 2.x and 3.x — 1M token windows are the norm.
  if (/gemini-(2|2\.5|3|flash|pro)/.test(id)) return 1_000_000;
  // GPT-4o family.
  if (/gpt-4o/.test(id)) return 128_000;
  // GPT-5: 400k as of late 2025.
  if (/gpt-5/.test(id)) return 400_000;
  // Sensible default.
  return 200_000;
}

const DEFAULT_MODEL = 'google/gemini-3-flash-preview';

export function getModelProfile(): ModelProfile {
  const id = (process.env.OPENROUTER_MODEL || DEFAULT_MODEL).trim();
  return {
    id,
    maxTokens: 16384,
    supportsReasoning: true,
    provider: (process.env.OPENROUTER_PROVIDER || '').trim() || undefined,
    contextWindow: getContextWindow(id),
  };
}

/** Convenience: just the active model id. */
export function getModel(): string {
  return getModelProfile().id;
}

/**
 * Rough allowlist of vision-capable model families. Used to refuse image
 * uploads early when the active model can't read them. Keep permissive —
 * the consequence of a false positive is the upstream API returning an
 * error, which we'd prefer over rejecting legitimately vision-capable models.
 * Keep this in sync with actual OpenRouter routing: every modern Claude /
 * GPT-4o / Gemini-2+ / Grok-Vision variant is vision-capable.
 */
const VISION_MODEL_PATTERNS = [
  /claude-(3|4|opus|sonnet|haiku)/i,
  /gpt-4o/i,
  /gpt-4-vision/i,
  /gpt-5/i,
  // Match any modern Gemini (1.5 and later, including 3.x and -flash/-pro variants).
  // Don't anchor on the major version — OpenRouter ids like `google/gemini-3-flash-preview`
  // and `google/gemini-3.1-pro-preview` should both pass.
  /gemini-(\d|flash|pro)/i,
  /grok-(2-)?vision/i,
  /llama-(3\.2|4)-.*vision/i,
  /pixtral/i,
  /qwen.*(vl|vision)/i,
];

export function modelSupportsVision(modelId: string): boolean {
  return VISION_MODEL_PATTERNS.some(re => re.test(modelId));
}

/**
 * Call OpenRouter's OpenAI-compatible endpoint directly.
 * This is needed because the reasoning/thinking parameter only works
 * on the /v1/chat/completions endpoint, not the Anthropic-compatible one.
 */
/**
 * Delay before the 1-shot retry on a failed initial fetch (#124). Short — the
 * retry is for fetch-level transients (DNS hiccup, ECONNRESET); a real outage
 * won't recover in 250ms anyway, and a slower retry would just stall the user.
 */
const FETCH_RETRY_DELAY_MS = 250;

/**
 * Wrap a single `fetch` call with one retry on `TypeError` — Node's
 * representation of connection-class failures (DNS, ECONNRESET, ENOTFOUND,
 * abort). The body reader is NOT covered: once the response opens, partial
 * chunks may have already streamed to the client and a retry would duplicate
 * visible output. See #124 for the controllog signature this addresses.
 */
async function fetchWithOneRetry(
  url: string,
  init: RequestInit,
  onRetry?: (originalMessage: string) => void,
): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    if (!(err instanceof TypeError)) throw err;
    // Telemetry callbacks must never cancel the retry path — a controllog
    // write failure would otherwise turn a recoverable network blip into the
    // user-facing error this PR exists to prevent.
    try {
      onRetry?.(err.message);
    } catch { /* swallow */ }
    await new Promise(r => setTimeout(r, FETCH_RETRY_DELAY_MS));
    return await fetch(url, init);
  }
}

export async function streamChatCompletion(params: {
  model: string;
  messages: Array<{ role: string; content: unknown }>;
  tools?: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>;
  systemPrompt: string;
  temperature?: number;
  maxTokens?: number;
  thinkingLevel?: string;
  /** Preferred OpenRouter upstream provider to pin caching to a single backend. */
  provider?: string;
  /**
   * Called when the initial fetch threw a TypeError and we're about to retry
   * once. Lets the route emit a `stream_error` controllog event with
   * `errorKind: 'fetch_retry'` so we can count how often the retry path
   * fires and whether it resolves. The retry itself is fire-and-forget — if
   * it also fails, the second TypeError propagates as today.
   */
  onFetchRetry?: (originalErrorMessage: string) => void;
}): Promise<ReadableStream<Uint8Array>> {
  const { model, messages, tools, systemPrompt, temperature = 0.3, maxTokens = 16384, thinkingLevel, provider, onFetchRetry } = params;

  // Convert Anthropic-style messages to OpenAI format
  const openaiMessages: Array<Record<string, unknown>> = [
    { role: 'system', content: systemPrompt },
  ];

  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      openaiMessages.push({ role: msg.role, content: msg.content });
    } else if (Array.isArray(msg.content)) {
      // Handle tool_result blocks (user role) and multi-block assistant messages
      const blocks = msg.content as Array<Record<string, unknown>>;

      if (msg.role === 'user' && blocks.some(b => b.type === 'tool_result')) {
        // Convert tool results to OpenAI format
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
        // Multimodal user content (text + image_url parts). OpenAI/OpenRouter
        // accept this array shape unchanged — pass through.
        openaiMessages.push({ role: 'user', content: blocks });
      } else if (msg.role === 'assistant') {
        // Convert assistant content blocks to OpenAI format
        const textParts: string[] = [];
        const toolCalls: Array<Record<string, unknown>> = [];

        for (const block of blocks) {
          if (block.type === 'text') {
            textParts.push(block.text as string);
          } else if (block.type === 'thinking') {
            // Preserve thinking blocks for echo-back
          } else if (block.type === 'tool_use') {
            toolCalls.push({
              id: block.id,
              type: 'function',
              function: {
                name: block.name,
                arguments: JSON.stringify(block.input),
              },
            });
          }
        }

        const assistantMsg: Record<string, unknown> = { role: 'assistant' };
        if (textParts.length > 0) assistantMsg.content = textParts.join('\n');
        if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls;
        openaiMessages.push(assistantMsg);
      }
    }
  }

  // Convert Anthropic tools to OpenAI format
  const openaiTools = tools?.map(t => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));

  const body: Record<string, unknown> = {
    model,
    messages: openaiMessages,
    max_tokens: maxTokens,
    temperature,
    stream: true,
    // Ask OpenRouter to include `usage` on the final chunk (token counts +
    // dollar cost when the upstream reports it). The server-side reader was
    // already parsing this when present; this just makes it guaranteed.
    usage: { include: true },
  };

  if (openaiTools && openaiTools.length > 0) {
    body.tools = openaiTools;
  }

  if (thinkingLevel && thinkingLevel !== 'none') {
    body.reasoning = { effort: thinkingLevel };
  }

  // Pin provider preference when configured. OpenRouter defaults
  // `allow_fallbacks: true`, so if the preferred provider is down we still
  // route — just with a cold cache on that request. Caching stays hot in
  // steady state when the preferred provider is healthy.
  if (provider) {
    body.provider = { order: [provider] };
  }

  const response = await fetchWithOneRetry(
    'https://openrouter.ai/api/v1/chat/completions',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'X-Title': 'quackbot',
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
