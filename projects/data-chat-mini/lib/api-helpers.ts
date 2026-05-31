import type { NextRequest } from 'next/server';

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
