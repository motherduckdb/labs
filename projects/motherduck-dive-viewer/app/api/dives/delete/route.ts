import { NextRequest } from 'next/server';
import { getStoredTokens } from '@/lib/motherduck-oauth';
import { isAuthError, authExpiredResponse } from '@/lib/api-helpers';
import { deleteDive } from '@/lib/dives';

/**
 * POST /api/dives/delete  { id }  — permanently delete one of the user's Dives.
 *
 * Destructive, so it's same-origin-gated (browsers can't forge
 * `Sec-Fetch-Site`, so a cross-origin page can't drive this with the user's
 * cookie) and runs MD_DELETE_DIVE as the signed-in user — MotherDuck rejects
 * deletes of dives they don't own.
 */
export async function POST(req: NextRequest) {
  const tokens = await getStoredTokens();
  if (!tokens) {
    return authExpiredResponse();
  }

  // Defense-in-depth CSRF check: reject cross-origin browser requests.
  const site = req.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin') {
    return Response.json({ error: 'cross_origin' }, { status: 403 });
  }

  let body: { id?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const id = typeof body.id === 'string' ? body.id : '';
  if (!id) {
    return Response.json({ error: 'id is required' }, { status: 400 });
  }

  try {
    await deleteDive(tokens.access_token, id);
    return Response.json({ ok: true });
  } catch (error) {
    console.error('[Dives] Delete error:', error);
    if (isAuthError(error)) {
      return authExpiredResponse();
    }
    return Response.json({ error: 'Failed to delete dive' }, { status: 500 });
  }
}
