import { redirect } from 'next/navigation';
import { readTokenStatus } from './motherduck-oauth';

/**
 * Resolve the signed-in user's access token for a Server Component, or
 * redirect. If the token is expired but refreshable, bounce through the
 * refresh Route Handler (which can write the refreshed cookie) and back to
 * `nextPath` — so a valid refresh token keeps the user signed in across
 * page loads instead of dumping them at /login.
 */
export async function requireUserAccessToken(nextPath: string): Promise<string> {
  const status = await readTokenStatus();
  if (status.status === 'valid') {
    return status.accessToken;
  }
  if (status.status === 'refreshable') {
    redirect(`/api/auth/motherduck/refresh?next=${encodeURIComponent(nextPath)}`);
  }
  redirect('/login');
}
