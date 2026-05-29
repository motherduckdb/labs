import { refreshTokens } from '@/lib/motherduck-oauth';
import { NextRequest, NextResponse } from 'next/server';

/**
 * GET /api/auth/motherduck/refresh?next=/path
 *
 * Cookie-writable boundary for token refresh. Server Components can't write
 * the refreshed cookie, so when they find an expired-but-refreshable token
 * they redirect here; this refreshes (writing the new cookie) and bounces
 * back to `next` — or to /login if refresh fails.
 */
function safeNext(next: string | null): string {
  // Only allow same-origin absolute paths; reject protocol-relative (`//`)
  // and backslash tricks to avoid an open redirect.
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) {
    return '/';
  }
  return next;
}

export async function GET(request: NextRequest) {
  const next = safeNext(request.nextUrl.searchParams.get('next'));
  let ok = false;
  try {
    ok = await refreshTokens();
  } catch {
    ok = false;
  }
  return NextResponse.redirect(`${request.nextUrl.origin}${ok ? next : '/login'}`);
}
