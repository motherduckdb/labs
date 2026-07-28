import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { executeToolWithStatus } from './mcp-client';
import { kvDelete, kvGet, kvSet } from '../store/kv';

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
 * TTL cache, backed by `kv_cache` in Postgres (src/store/kv.ts). This is
 * primarily for LLM prompt-cache STABILITY, not latency: the guide block sits
 * near the top of the system prompt, so if its text changed on every turn it
 * would bust Anthropic's prompt cache for the whole prefix. A ~15-minute TTL
 * keeps the same string across the many turns of a busy thread, so the cached
 * prefix stays warm; the tradeoff is that a freshly-saved guide can take up to
 * the TTL to appear in the pre-fetched block (the model can always call
 * `get_query_guide` directly for an immediate view).
 *
 * This used to be a module-level `{value, expiresAt}` — correct only because
 * one Fly process outlived the TTL. On Modal a container is per-turn, so an
 * in-memory cache would miss every single time. Moving it to `kv_cache` makes
 * it genuinely shared: one container's fetch warms every other container's
 * turn for the next 15 minutes, rather than every turn paying the round-trip.
 *
 * Only SUCCESSFUL results are cached — never write a failure to the shared
 * key. That mattered for a single process; it matters *more* now, because a
 * cached failure would go blind for every container reading the shared key,
 * not just the one that saw it.
 */
const TTL_MS = 15 * 60 * 1000;
const CACHE_KEY = 'query-guide';

/** Drop the cached guide. Test-only seam; also the invalidation hook for "a guide was just saved, don't serve the stale one for 15 more minutes." */
export async function clearQueryGuideCache(): Promise<void> {
  await kvDelete(CACHE_KEY);
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
 * Expiry is enforced by `kvGet` against the *database's* clock (see kv.ts),
 * not a clock passed in here — there is no longer a `now` injection seam,
 * because the thing being timed out is a Postgres row, not a JS variable.
 * Tests fake the TTL behaviour by mocking `kvGet`/`kvSet` directly.
 */
export async function fetchQueryGuideBlock(
  client: Client,
  opts: { requestOptions?: RequestOptions } = {},
): Promise<string | null> {
  const cached = await kvGet<string>(CACHE_KEY);
  if (cached !== null) return cached;

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
    await kvSet(CACHE_KEY, block, TTL_MS);
    return block;
  } catch {
    // Transport/throw — never propagate; a missing block must not break a turn.
    return null;
  }
}
