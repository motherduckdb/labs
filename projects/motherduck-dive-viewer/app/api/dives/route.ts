import { NextRequest } from 'next/server';
import { getStoredTokens } from '@/lib/motherduck-oauth';
import { isAuthError, authExpiredResponse } from '@/lib/api-helpers';
import { listDives, type DiveSort, type SortDir } from '@/lib/dives';

/**
 * GET /api/dives?sort=&dir=&q=&scope= — list Dives.
 * scope=all includes org-shared dives; default is the user's own.
 * Read-only, per-user via the OAuth access token.
 */
export async function GET(req: NextRequest) {
  const tokens = await getStoredTokens();
  if (!tokens) {
    return authExpiredResponse();
  }

  const sp = req.nextUrl.searchParams;
  const sort = (sp.get('sort') ?? undefined) as DiveSort | undefined;
  const dir = (sp.get('dir') ?? undefined) as SortDir | undefined;
  const search = sp.get('q') ?? undefined;
  const includeOrgShares = sp.get('scope') === 'all';

  try {
    const dives = await listDives(tokens.access_token, { sort, dir, search, includeOrgShares });
    return Response.json({ dives });
  } catch (error) {
    console.error('[Dives] Error:', error);
    if (isAuthError(error)) {
      return authExpiredResponse();
    }
    return Response.json({ error: 'Failed to list dives' }, { status: 500 });
  }
}
