// LLM transport: Modal's Kimi K3 endpoint — an OpenAI-compatible
// /chat/completions endpoint hit via direct `fetch` (see streamChatCompletion).
// The host is the workspace's own dedicated Auto Endpoint, supplied by
// MODAL_INFERENCE_BASE_URL; NOT Modal's multi-tenant Shared API, which this
// workspace is not entitled to (see getChatCompletionsUrl).
// We hand-convert our Anthropic-style message blocks to OpenAI format on the
// way out, including the `reasoning_content` echo-back K3 requires (see
// `toOpenAIMessages`).
//
// This file was a hard swap from OpenRouter: no fallback provider, no
// multi-provider abstraction. Everything OpenRouter-specific (X-Title /
// HTTP-Referer headers, `provider: {order}`, `usage: {include}`, dollar cost on
// the usage chunk) is gone; the pieces OpenRouter used to give us for free —
// most notably cost — are computed locally below.

import { redact } from './redact';

// ---------------------------------------------------------------------------
// Endpoint + auth
// ---------------------------------------------------------------------------

/**
 * Full chat-completions URL, tolerant of a trailing slash on the base.
 *
 * There is deliberately NO default, and the history here matters because the
 * obvious "improvement" is to put one back. This function originally threw;
 * a default of `https://api.us-west-2.modal.direct/v1` — Modal's multi-tenant
 * Shared API — was added on the reasoning that it is one fixed host for every
 * workspace, so requiring the variable would refuse to start a container that
 * was already correctly configured. That reasoning has since been falsified:
 * the Shared API needs a separate entitlement this workspace does not have, and
 * it rejects our credentials with a 401. So the default was not a safe fallback,
 * it was a known-broken endpoint selected silently — turning "you forgot to set
 * a variable" into an auth error that sends the reader hunting for a credential
 * problem that doesn't exist.
 *
 * Production runs a DEDICATED Auto Endpoint, whose host is per-workspace and
 * therefore cannot be hardcoded at all. Name the variable and its value instead.
 */
export function getChatCompletionsUrl(): string {
  const raw = (process.env.MODAL_INFERENCE_BASE_URL || '').trim();
  if (!raw) {
    throw new Error(
      'MODAL_INFERENCE_BASE_URL is not set. There is no default: the inference ' +
        'endpoint is a per-workspace dedicated Auto Endpoint, and the one host ' +
        'that could be hardcoded (Modal\'s Shared API) needs an entitlement this ' +
        'workspace does not have, so it 401s. Set it to ' +
        'https://motherduck--ep-kimi-k3-server.us-west.modal.direct/v1 ' +
        '(confirm with `modal endpoint list`).',
    );
  }
  return `${raw.replace(/\/+$/, '')}/chat/completions`;
}

/**
 * One header, one scheme: an OpenAI-style bearer.
 *
 * A dedicated Auto Endpoint documents `Modal-Key`/`Modal-Secret` as a header
 * PAIR, which looks like it needs its own code path — it does not. The same
 * endpoint accepts `Authorization: Bearer <key>.<secret>` (dot-joined, not
 * colon), verified 200 against both forms on the live endpoint. So the pair
 * goes in `MODAL_INFERENCE_KEY` already joined and this function stays one
 * line, which also keeps the Shared API working unchanged if we ever move.
 *
 * What does NOT work, so nobody re-tests it at 3am: a proxy pair against the
 * *Shared API* host, in any arrangement, and a CLI `ak-`/`as-` token against
 * it likewise. Note the two distinct 401 bodies — `missing or invalid
 * Authorization header` means the header shape wasn't understood, while
 * `invalid token` means a bearer parsed fine and the credential was refused.
 */
export function buildAuthHeaders(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return { Authorization: `Bearer ${(env.MODAL_INFERENCE_KEY || '').trim()}` };
}

// ---------------------------------------------------------------------------
// The model. A constant, not a knob.
// ---------------------------------------------------------------------------

export interface ModelProfile {
  id: string;
  maxTokens: number;
  supportsReasoning: boolean;
  /**
   * Approximate prompt-token capacity. Used by the client to render a
   * "% context full" indicator. Deliberately rough — what we really want is
   * "is the user getting close", not exact accounting.
   */
  contextWindow: number;
}

/**
 * The one model this bot talks to.
 *
 * This was `process.env.MODAL_INFERENCE_MODEL || 'moonshotai/Kimi-K3'`, which
 * read as a model switch and was not one. Every fact downstream of the id is a
 * K3 constant that the id did not select:
 *
 *   - ENDPOINT. `getChatCompletionsUrl` resolves `MODAL_INFERENCE_BASE_URL`, one
 *     dedicated Modal Auto Endpoint serving exactly this model. Nothing routes
 *     on the id; it is just a string in the request body. Setting the variable
 *     to `anthropic/claude-sonnet-5` never reached Anthropic.
 *   - COST. `computeCostUSD` takes no model argument and bills
 *     `KIMI_K3_RATES_PER_MTOK` unconditionally. That figure is the dollar number
 *     in the usage pill and the `costMoney` on every controllog
 *     `modelCompletion` row — rows that also carry `model: profile.id`. A
 *     changed id therefore relabelled Kimi prices as another vendor's.
 *   - REQUEST SHAPE. `reasoning_effort` is sent with the literal set this
 *     endpoint 400s outside of, `max_completion_tokens` replaces `max_tokens`
 *     because K3 deprecated it, and sampling params are withheld because K3
 *     fixes them (see `streamChatCompletion`).
 *   - CAPABILITIES. `toOpenAIMessages` always echoes `reasoning_content` back
 *     because Moonshot requires it; `supportsReasoning` is hardcoded true.
 *
 * A context-window lookup table keyed on the id used to live here too, and was
 * the only thing the id genuinely selected — for a cosmetic percentage. It is
 * gone with the variable.
 *
 * If a second model ever becomes reachable it arrives with its own base URL,
 * rate table and dialect. Change them together, here, in a commit that says so.
 */
export const MODEL_ID = 'moonshotai/Kimi-K3';

/** Kimi K3's prompt-token capacity — 1M. Feeds the "% context full" pill only. */
export const CONTEXT_WINDOW = 1_000_000;

export function getModelProfile(): ModelProfile {
  return {
    id: MODEL_ID,
    maxTokens: 16384,
    supportsReasoning: true,
    contextWindow: CONTEXT_WINDOW,
  };
}

/**
 * Rough allowlist of vision-capable model families.
 *
 * NOTE: `modelSupportsVision` is exported but never called anywhere in this
 * repo, and the bot has no Slack file-upload path — the vision branch is dead
 * code inherited from data-chat-mini. Kimi is added here as correctness
 * hygiene (K3 is natively multimodal), not as a feature.
 */
const VISION_MODEL_PATTERNS = [
  // Kimi K3 is natively vision-capable.
  /kimi/i,
  /moonshot/i,
  /claude-(3|4|opus|sonnet|haiku)/i,
  /gpt-4o/i,
  /gpt-4-vision/i,
  /gpt-5/i,
  // Match any modern Gemini (1.5 and later, including 3.x and -flash/-pro variants).
  /gemini-(\d|flash|pro)/i,
  /grok-(2-)?vision/i,
  /llama-(3\.2|4)-.*vision/i,
  /pixtral/i,
  /qwen.*(vl|vision)/i,
];

export function modelSupportsVision(modelId: string): boolean {
  return VISION_MODEL_PATTERNS.some(re => re.test(modelId));
}

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------

/**
 * Kimi K3 list rates, dollars per million tokens.
 *
 * OpenRouter used to hand back `usage.cost` per request; Modal does not, so the
 * dollar figure in the usage pill is now computed here. Rates drift — check
 * https://modal.com/library/moonshot/kimi-k3 before trusting an old number.
 */
export const KIMI_K3_RATES_PER_MTOK = {
  prompt: 3.0,
  cachedPrompt: 0.3,
  completion: 15.0,
  /**
   * Reasoning bills at the full completion rate — K3 always reasons and there
   * is no discount for it, which is why `reasoning_effort` defaults to `low`
   * (see `toReasoningEffort`).
   */
  reasoning: 15.0,
} as const;

export interface CostInputs {
  promptTokens: number;
  completionTokens: number;
  /** Subset of `promptTokens` served from the prompt cache. */
  cachedPromptTokens?: number;
  /** Subset of `completionTokens` spent on reasoning. */
  reasoningTokens?: number;
}

/**
 * Dollar cost for one model call.
 *
 * Both token-detail fields are SUBSETS of their parent count in the
 * OpenAI-compatible usage shape, so each is subtracted out before its parent is
 * billed — cached prompt tokens are not also charged at the full prompt rate,
 * and reasoning tokens are not charged twice. Reasoning currently costs exactly
 * the same as ordinary completion, so splitting it out changes nothing today;
 * it is written explicitly so the arithmetic stays right if the rates diverge.
 */
export function computeCostUSD(u: CostInputs): number {
  const M = 1_000_000;
  const cached = Math.min(Math.max(u.cachedPromptTokens ?? 0, 0), Math.max(u.promptTokens, 0));
  const uncached = Math.max(u.promptTokens - cached, 0);
  const reasoning = Math.min(Math.max(u.reasoningTokens ?? 0, 0), Math.max(u.completionTokens, 0));
  const plainCompletion = Math.max(u.completionTokens - reasoning, 0);
  return (
    (uncached * KIMI_K3_RATES_PER_MTOK.prompt) / M +
    (cached * KIMI_K3_RATES_PER_MTOK.cachedPrompt) / M +
    (plainCompletion * KIMI_K3_RATES_PER_MTOK.completion) / M +
    (reasoning * KIMI_K3_RATES_PER_MTOK.reasoning) / M
  );
}

// ---------------------------------------------------------------------------
// Reasoning effort
// ---------------------------------------------------------------------------

/**
 * The values the endpoint accepts for `reasoning_effort`.
 *
 * Not guessed: posting an invalid value returns a 400 that names the literal
 * set outright — `literal['none','minimal','low','medium','high','xhigh','max']`.
 */
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

const ACCEPTED_EFFORTS: ReadonlySet<string> = new Set<ReasoningEffort>([
  'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
]);

/**
 * Map `QUACKBOT_THINKING_LEVEL` onto `reasoning_effort` — which is a
 * pass-through, because the accepted set above is quackbot's own six-rung
 * ladder verbatim, plus `max`.
 *
 * This used to collapse the ladder onto `low|high|max`, folding `none` and
 * `minimal` up into `low` and `xhigh` into `max`, on the belief that K3 always
 * reasons and has no off switch. It does have one: `reasoning_effort: 'none'`
 * returns 8 completion tokens and an empty `reasoning_content`, against 38
 * tokens and 104 characters of reasoning at `low`. Since reasoning bills at the
 * full $15/MTok, that fold silently charged for thinking on every turn of a
 * setting whose entire purpose was to switch it off.
 *
 * The default stays `low` — unset should keep reasoning on, and an unrecognised
 * value is a typo rather than a request for silence.
 */
export function toReasoningEffort(thinkingLevel?: string): ReasoningEffort {
  const level = (thinkingLevel || '').trim().toLowerCase();
  return ACCEPTED_EFFORTS.has(level) ? (level as ReasoningEffort) : 'low';
}

// ---------------------------------------------------------------------------
// Message conversion
// ---------------------------------------------------------------------------

/**
 * `JSON.stringify` with object keys emitted in sorted order at every depth.
 *
 * This exists for PROMPT-CACHE STABILITY, not tidiness. Tool-call arguments are
 * echoed back on every subsequent request as `tool_calls[].function.arguments`,
 * a string — so its exact bytes are part of the prompt prefix, and any change
 * to them invalidates the cached prefix from that point on.
 *
 * The bytes were changing. A turn's messages are persisted by
 * `src/store/conversations.ts` into `conversations.messages`, which is
 * `jsonb` (migrations/001_init.sql) — and jsonb does not preserve object key
 * order; it canonicalises to key-length-then-bytewise. So a `tool_use` block
 * whose `input` the model emitted as `{database, sql}` comes back out of
 * Postgres as `{sql, database}`, and `JSON.stringify` faithfully reproduced the
 * difference. Every turn after the first therefore re-sent its own history with
 * the tool arguments reshuffled, busting the cache at the position of the
 * previous turn's first tool call and forcing a re-prefill of everything after
 * it — which, in a bot whose tool results are query output, is most of the
 * context.
 *
 * Sorting fixes it from either direction: in-memory blocks and
 * jsonb-round-tripped blocks now serialize identically. The cost is that within
 * a single turn we no longer echo the model's own key order back verbatim, so
 * the freshly-generated tool call diverges from its generation-time cache — but
 * that divergence sits at the very end of the prefix (only the arguments
 * themselves get re-prefilled, and the tool result after them is new anyway),
 * where the cross-turn divergence sat near the beginning.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return v;
    const obj = v as Record<string, unknown>;
    return Object.fromEntries(Object.keys(obj).sort().map(k => [k, obj[k]]));
  });
}

/**
 * Convert our Anthropic-style message blocks into OpenAI chat messages.
 *
 * The load-bearing part is the assistant branch's `reasoning_content`.
 * Moonshot's docs are explicit that the ENTIRE untouched assistant message —
 * reasoning included — has to be echoed back on subsequent turns of a tool
 * loop ("do not keep only `content`"). The OpenRouter-era code had a
 * `thinking` branch that claimed to preserve blocks and was in fact a no-op,
 * which would have quietly degraded every multi-tool turn on K3.
 *
 * The loop stores reasoning as `{type:'thinking', thinking}` blocks built by
 * concatenating the raw `delta.reasoning_content` chunks, so joining them back
 * together reproduces the model's own text verbatim.
 */
export function toOpenAIMessages(
  systemPrompt: string,
  messages: Array<{ role: string; content: unknown }>,
): Array<Record<string, unknown>> {
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
        // Multimodal user content (text + image_url parts). OpenAI-compatible
        // servers accept this array shape unchanged — pass through.
        openaiMessages.push({ role: 'user', content: blocks });
      } else if (msg.role === 'assistant') {
        // Convert assistant content blocks to OpenAI format
        const textParts: string[] = [];
        const reasoningParts: string[] = [];
        const toolCalls: Array<Record<string, unknown>> = [];

        for (const block of blocks) {
          if (block.type === 'text') {
            textParts.push(block.text as string);
          } else if (block.type === 'thinking') {
            // The echo-back that K3 requires — see the doc comment above.
            if (typeof block.thinking === 'string') reasoningParts.push(block.thinking);
          } else if (block.type === 'tool_use') {
            toolCalls.push({
              id: block.id,
              type: 'function',
              function: {
                name: block.name,
                // A tool call whose arguments failed to parse was stored with
                // `input: {}` and never dispatched (see agentic-loop.ts); we
                // echo the valid-JSON `{}` rather than the malformed original
                // so the retry prompt isn't itself unparseable.
                //
                // `stableStringify`, not `JSON.stringify`: these bytes are part
                // of the cached prompt prefix and a jsonb round-trip through
                // conversation storage reorders the keys. See its doc comment.
                arguments: stableStringify(block.input),
              },
            });
          }
        }

        const assistantMsg: Record<string, unknown> = { role: 'assistant' };
        if (textParts.length > 0) assistantMsg.content = textParts.join('\n');
        if (reasoningParts.length > 0) assistantMsg.reasoning_content = reasoningParts.join('');
        if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls;
        openaiMessages.push(assistantMsg);
      }
    }
  }

  return openaiMessages;
}

// ---------------------------------------------------------------------------
// Streaming call
// ---------------------------------------------------------------------------

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
  maxTokens?: number;
  thinkingLevel?: string;
  /**
   * Called when the initial fetch threw a TypeError and we're about to retry
   * once. Lets the route emit a `stream_error` controllog event with
   * `errorKind: 'fetch_retry'` so we can count how often the retry path
   * fires and whether it resolves. The retry itself is fire-and-forget — if
   * it also fails, the second TypeError propagates as today.
   */
  onFetchRetry?: (originalErrorMessage: string) => void;
}): Promise<ReadableStream<Uint8Array>> {
  const { model, messages, tools, systemPrompt, maxTokens = 16384, thinkingLevel, onFetchRetry } = params;

  const openaiMessages = toOpenAIMessages(systemPrompt, messages);

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
    // `max_tokens` is deprecated on K3 in favour of `max_completion_tokens`
    // (whose own default is 131072, max 1048576). We keep quackbot's 16384 cap:
    // Slack messages are the output surface, and the loop already treats
    // `finish_reason: 'length'` as a user-visible error.
    max_completion_tokens: maxTokens,
    stream: true,
    // Standard OpenAI opt-in for a final usage-only chunk. Replaces
    // OpenRouter's non-standard `usage: {include: true}`.
    stream_options: { include_usage: true },
    // No sampling parameters. Not because the server refuses them — it takes
    // `temperature` and `top_p` with a 200, unlike an unknown `reasoning_effort`
    // which 400s — but because Moonshot documents K3's sampling as fixed, so
    // they are accepted-and-ignored. Sending values that look effective and
    // aren't is worse than sending none, so do not "restore" temperature: 0.3.
    reasoning_effort: toReasoningEffort(thinkingLevel),
  };

  if (openaiTools && openaiTools.length > 0) {
    body.tools = openaiTools;
  }

  const response = await fetchWithOneRetry(
    getChatCompletionsUrl(),
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...buildAuthHeaders(),
      },
      body: JSON.stringify(body),
    },
    onFetchRetry,
  );

  if (!response.ok) {
    const text = await response.text();
    // Redact: the response body is echoed into a thrown error that is logged
    // (and could surface upstream request detail); scrub token-shaped content.
    throw new Error(`Modal inference error ${response.status}: ${redact(text)}`);
  }

  return response.body!;
}
