import type { NextRequest } from 'next/server';
import type { ChatRequest } from '@/types/chat';

/** Caps on untrusted /api/chat input — bounds prompt-injection surface and per-request cost/memory. */
const LIMITS = {
  bodyBytes: 1_000_000, // 1 MB raw request body
  message: 100_000, // chars
  historyEntries: 500,
  databases: 50,
} as const;

const THINKING_LEVELS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);

/**
 * Parse and validate the /api/chat request body. Returns the typed request or
 * an error message describing the first violation. Rejects oversized bodies and
 * malformed shapes before any of it reaches the LLM or MCP.
 */
export async function parseChatRequest(
  request: NextRequest,
): Promise<{ ok: true; body: ChatRequest } | { ok: false; error: string }> {
  const raw = await request.text();
  if (raw.length > LIMITS.bodyBytes) {
    return { ok: false, error: 'Request body too large' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'Invalid JSON body' };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, error: 'Body must be an object' };
  }
  const b = parsed as Record<string, unknown>;

  if (b.message !== undefined && typeof b.message !== 'string') {
    return { ok: false, error: 'message must be a string' };
  }
  if (typeof b.message === 'string' && b.message.length > LIMITS.message) {
    return { ok: false, error: 'message too long' };
  }

  if (!Array.isArray(b.history)) {
    return { ok: false, error: 'history must be an array' };
  }
  if (b.history.length > LIMITS.historyEntries) {
    return { ok: false, error: 'history too long' };
  }
  for (const m of b.history) {
    if (typeof m !== 'object' || m === null || typeof (m as Record<string, unknown>).role !== 'string') {
      return { ok: false, error: 'history entries must have a string role' };
    }
  }

  if (!Array.isArray(b.databases) || b.databases.some(d => typeof d !== 'string')) {
    return { ok: false, error: 'databases must be an array of strings' };
  }
  if (b.databases.length > LIMITS.databases) {
    return { ok: false, error: 'too many databases' };
  }

  if (typeof b.thinkingLevel !== 'string' || !THINKING_LEVELS.has(b.thinkingLevel)) {
    return { ok: false, error: 'invalid thinkingLevel' };
  }

  if (b.sessionId !== undefined && typeof b.sessionId !== 'string') {
    return { ok: false, error: 'sessionId must be a string' };
  }
  if (b.resolvedContext !== undefined && !Array.isArray(b.resolvedContext)) {
    return { ok: false, error: 'resolvedContext must be an array' };
  }

  return { ok: true, body: parsed as ChatRequest };
}

/** Heuristic: does this error look like a MotherDuck auth/token failure? */
export function isAuthError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /401|403|unauthorized|forbidden|expired|invalid.?token|no motherduck_token/i.test(msg);
}

export function authExpiredResponse(): Response {
  return Response.json({ error: 'auth_expired' }, { status: 401 });
}

/**
 * The per-browser-session id, used as the MotherDuck read-scaling session
 * hint. GET routes read it from the `x-session-id` header; the chat POST
 * reads it from the request body.
 */
export function getSessionHint(request: NextRequest): string | undefined {
  return request.headers.get('x-session-id') || undefined;
}
