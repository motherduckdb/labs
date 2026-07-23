import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { executeToolWithStatus } from './mcp-client';

/**
 * Eager fetch of the org query guidance (`get_query_guide`) so it can be
 * injected into the system prompt once, server-side, instead of the model
 * spending a tool round-trip on it every turn.
 *
 * `get_query_guide` takes no args and returns `{text}` (org guidance + the full
 * guide topic map, ~5-10KB). We fetch it here, extract the text, and hand it to
 * `buildSystemPrompt`. Every failure mode returns `null` (never throws): a
 * missing block must never break a turn — the prompt falls back to its
 * "call get_query_guide first, always" mandate, and the tool stays allowlisted
 * so the model can still fetch it itself.
 */

/**
 * Module-level TTL cache. This is primarily for LLM prompt-cache STABILITY, not
 * latency: the guide block sits near the top of the system prompt, so if its
 * text changed on every turn it would bust Anthropic's prompt cache for the
 * whole prefix. A ~15-minute TTL keeps the same string across the many turns of
 * a busy thread, so the cached prefix stays warm; the tradeoff is that a
 * freshly-saved guide can take up to the TTL to appear in the pre-fetched block
 * (the model can always call `get_query_guide` directly for an immediate view).
 *
 * Only SUCCESSFUL results are cached. A failure (tool error, throw, empty body)
 * is never cached, so the next turn retries the fetch.
 */
const TTL_MS = 15 * 60 * 1000;

interface CacheEntry {
  value: string;
  expiresAt: number;
}

let cache: CacheEntry | null = null;

/** Reset the module cache. Test-only seam. */
export function clearQueryGuideCache(): void {
  cache = null;
}

/**
 * Pull the guide text out of whatever `executeToolWithStatus` returns.
 *
 * That path stringifies `structuredContent` when present, so a `{text}`
 * envelope arrives here as the JSON string `{"text":"…"}`; when the server
 * instead returns plain text blocks, it arrives as the raw text. Handle both,
 * plus the guarding cases (empty, object with no usable `text`).
 */
function extractGuideText(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const text = (parsed as { text?: unknown }).text;
      if (typeof text === 'string' && text.trim().length > 0) return text.trim();
      // A JSON object with no usable `text` field — nothing to inject.
      return null;
    }
    if (typeof parsed === 'string' && parsed.trim().length > 0) return parsed.trim();
    return null;
  } catch {
    // Not JSON — treat the raw text as the guide block itself.
    return trimmed;
  }
}

/**
 * Fetch the org query-guidance block for injection into the system prompt.
 * Returns the guide text, or `null` on ANY failure. Successful results are
 * cached for `TTL_MS`; failures are not.
 *
 * `opts.now` injects a clock for tests; production uses `Date.now`.
 */
export async function fetchQueryGuideBlock(
  client: Client,
  opts: { now?: () => number; requestOptions?: RequestOptions } = {},
): Promise<string | null> {
  const now = opts.now ?? Date.now;
  const t = now();

  if (cache && t < cache.expiresAt) {
    return cache.value;
  }

  try {
    const { text, isError } = await executeToolWithStatus(
      client,
      'get_query_guide',
      {},
      opts.requestOptions,
    );
    // Tool-level error (e.g. server rejection) — do not cache, retry next turn.
    if (isError) return null;
    const block = extractGuideText(text);
    if (!block) return null;
    cache = { value: block, expiresAt: t + TTL_MS };
    return block;
  } catch {
    // Transport/throw — never propagate; a missing block must not break a turn.
    return null;
  }
}
