/**
 * MotherDuck OAuth 2.1 flow using MCP SDK's discovery and token exchange.
 *
 * Flow:
 * 1. /api/auth/motherduck — discover, register client (if needed), redirect to authorize
 * 2. /api/auth/motherduck/callback — exchange code for tokens, store in cookie
 * 3. App code uses access_token from cookie as Bearer token for the MCP client
 */

import {
  discoverOAuthServerInfo,
  registerClient,
  startAuthorization,
  exchangeAuthorization,
  refreshAuthorization,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { cookies } from 'next/headers';
import { getMotherDuckMcpUrl } from './motherduck-env';

const MCP_SERVER_URL = getMotherDuckMcpUrl();
// MotherDuck enforces read vs. write by TOKEN TYPE, not by OAuth scope: the
// short-lived token minted for the signed-in user is read/write, so the
// destructive delete flow (MD_DELETE_DIVE) works even though the requested
// scope reads "read:databases". `read:databases` here gates MCP-resource
// access, not SQL mutation. (MD has no documented granular write scope; a
// truly read-only deployment would mint a Read-Scaling token instead.)
const SCOPES = 'openid profile email read:databases offline_access';

// Cookie names
const TOKEN_COOKIE = 'md-oauth-tokens';
const VERIFIER_COOKIE = 'md-oauth-verifier';
const CLIENT_COOKIE = 'md-oauth-client';
const STATE_COOKIE = 'md-oauth-state';

function generateState(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString('base64url');
}

export class OAuthStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OAuthStateError';
  }
}

function getCallbackUrl(): string {
  const base = process.env.NEXTAUTH_URL
    || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null)
    || 'http://localhost:3000';
  return `${base}/api/auth/motherduck/callback`;
}

function getClientMetadata() {
  return {
    redirect_uris: [getCallbackUrl()],
    client_name: 'motherduck-oauth-nextjs',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none' as const,
    scope: SCOPES,
  };
}

interface StoredTokens {
  access_token: string;
  refresh_token?: string;
  expires_at?: number; // Unix timestamp (seconds) when access_token expires
}

/**
 * Get stored tokens, automatically refreshing if expired.
 * Returns null if no tokens exist or refresh fails (user must re-login).
 */
export async function getStoredTokens(): Promise<StoredTokens | null> {
  const cookieStore = await cookies();
  const raw = cookieStore.get(TOKEN_COOKIE)?.value;
  if (!raw) return null;

  let tokens: StoredTokens;
  try {
    tokens = JSON.parse(raw);
  } catch {
    return null;
  }

  // Reject a cookie that doesn't carry a usable access token, so callers can
  // never end up treating a malformed cookie as an authenticated session.
  if (typeof tokens.access_token !== 'string' || tokens.access_token.length === 0) {
    return null;
  }

  // Check if token is expired (with 60s buffer).
  // If expires_at is missing (legacy cookie), attempt a refresh if we have a refresh_token,
  // since we can't know if the access token is still valid.
  const isExpired = tokens.expires_at
    ? Date.now() / 1000 > tokens.expires_at - 60
    : false; // No expires_at = legacy token, let it through (auth failures caught downstream)

  if (isExpired) {
    // Attempt refresh. In Server Component contexts, cookie writes throw —
    // swallow the error and return null so the user gets redirected to login.
    // The route handler path will successfully refresh on the next request.
    let refreshed = false;
    try {
      refreshed = await refreshTokens();
    } catch {
      return null;
    }
    if (!refreshed) {
      // Refresh failed — try to clear stale cookies (also may fail in Server Component)
      try { await clearOAuthState(); } catch { /* ignore in Server Component */ }
      return null;
    }
    // Re-read the freshly stored tokens
    const freshRaw = (await cookies()).get(TOKEN_COOKIE)?.value;
    if (!freshRaw) return null;
    try {
      return JSON.parse(freshRaw);
    } catch {
      return null;
    }
  }

  return tokens;
}

export type TokenStatus =
  | { status: 'valid'; accessToken: string }
  | { status: 'refreshable' }
  | { status: 'none' };

/**
 * Inspect the stored tokens WITHOUT attempting a refresh or writing cookies.
 * Safe to call from Server Components (where cookie writes throw).
 *
 * - `valid`       — a non-expired access token is present; use it.
 * - `refreshable` — the access token is expired but a refresh token exists;
 *                   the caller should route through the refresh Route Handler
 *                   (which CAN write the refreshed cookie) before proceeding.
 * - `none`        — no usable session; the caller should send the user to login.
 */
export async function readTokenStatus(): Promise<TokenStatus> {
  const cookieStore = await cookies();
  const raw = cookieStore.get(TOKEN_COOKIE)?.value;
  if (!raw) return { status: 'none' };

  let tokens: StoredTokens;
  try {
    tokens = JSON.parse(raw);
  } catch {
    return { status: 'none' };
  }
  if (typeof tokens.access_token !== 'string' || tokens.access_token.length === 0) {
    return { status: 'none' };
  }

  const isExpired = tokens.expires_at
    ? Date.now() / 1000 > tokens.expires_at - 60
    : false;

  if (!isExpired) {
    return { status: 'valid', accessToken: tokens.access_token };
  }
  return tokens.refresh_token ? { status: 'refreshable' } : { status: 'none' };
}

async function getStoredClient(): Promise<OAuthClientInformationFull | null> {
  const cookieStore = await cookies();
  const raw = cookieStore.get(CLIENT_COOKIE)?.value;
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Start the OAuth flow: discover server, register client, redirect to authorize.
 * Returns the authorization URL to redirect the user to.
 */
export async function startOAuthFlow(): Promise<string> {
  // Discover MotherDuck's OAuth server
  const serverInfo = await discoverOAuthServerInfo(MCP_SERVER_URL);

  if (!serverInfo.authorizationServerMetadata) {
    throw new Error('Could not discover MotherDuck authorization server');
  }

  // Check if we have a registered client with the correct callback URL, or register a new one
  const callbackUrl = getCallbackUrl();
  let clientInfo = await getStoredClient();
  if (clientInfo) {
    // Re-register if the stored client was for a different callback URL
    const storedRedirects = (clientInfo as unknown as { redirect_uris?: string[] }).redirect_uris;
    if (storedRedirects && !storedRedirects.includes(callbackUrl)) {
      clientInfo = null;
    }
  }
  if (!clientInfo) {
    clientInfo = await registerClient(serverInfo.authorizationServerUrl, {
      metadata: serverInfo.authorizationServerMetadata,
      clientMetadata: getClientMetadata(),
      scope: SCOPES,
    });

    // Store client registration
    const cookieStore = await cookies();
    cookieStore.set(CLIENT_COOKIE, JSON.stringify(clientInfo), {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 365, // 1 year
    });
  }

  // Generate state for CSRF/mix-up protection — bound to this browser session
  // by the state cookie below, verified against the callback's state query param
  // before code exchange.
  const state = generateState();

  // Generate PKCE and authorization URL
  const { authorizationUrl, codeVerifier } = await startAuthorization(
    serverInfo.authorizationServerUrl,
    {
      metadata: serverInfo.authorizationServerMetadata,
      clientInformation: clientInfo,
      redirectUrl: getCallbackUrl(),
      scope: SCOPES,
      state,
      resource: serverInfo.resourceMetadata?.resource
        ? new URL(serverInfo.resourceMetadata.resource)
        : undefined,
    }
  );

  // Store code verifier and state for the callback. Same 10-minute lifetime —
  // both are short-lived per-flow secrets.
  const cookieStore = await cookies();
  const cookieOptions = {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    maxAge: 60 * 10,
  };
  cookieStore.set(VERIFIER_COOKIE, codeVerifier, cookieOptions);
  cookieStore.set(STATE_COOKIE, state, cookieOptions);

  return authorizationUrl.toString();
}

/**
 * Constant-time string comparison to avoid leaking length/prefix information
 * when comparing the stored OAuth state with the value returned by the
 * authorization server.
 */
function timingSafeEqual(a: string, b: string): boolean {
  const aBytes = Buffer.from(a, 'utf8');
  const bBytes = Buffer.from(b, 'utf8');
  if (aBytes.length !== bBytes.length) return false;
  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) {
    diff |= aBytes[i]! ^ bBytes[i]!;
  }
  return diff === 0;
}

/**
 * Handle the OAuth callback: exchange code for tokens, store them.
 *
 * Verifies the returned state value against the cookie-bound state set when
 * the flow began. Throws OAuthStateError on mismatch — the caller should
 * surface this to the user without attempting token exchange.
 */
export async function handleOAuthCallback(code: string, returnedState: string | null): Promise<void> {
  const cookieStore = await cookies();

  // Verify state before doing anything else. We always clear the cookie after
  // reading so a leaked/replayed code can't be paired with the same state again.
  const storedState = cookieStore.get(STATE_COOKIE)?.value;
  cookieStore.delete(STATE_COOKIE);
  if (!storedState) {
    throw new OAuthStateError('Missing OAuth state cookie. Please restart the authorization flow.');
  }
  if (!returnedState || !timingSafeEqual(storedState, returnedState)) {
    throw new OAuthStateError('OAuth state mismatch. Please restart the authorization flow.');
  }

  // Get stored verifier and client info
  const codeVerifier = cookieStore.get(VERIFIER_COOKIE)?.value;
  if (!codeVerifier) {
    throw new Error('Missing PKCE code verifier. Please restart the authorization flow.');
  }

  const clientInfo = await getStoredClient();
  if (!clientInfo) {
    throw new Error('Missing client registration. Please restart the authorization flow.');
  }

  // Discover server info again for metadata
  const serverInfo = await discoverOAuthServerInfo(MCP_SERVER_URL);

  if (!serverInfo.authorizationServerMetadata) {
    throw new Error('Could not discover MotherDuck authorization server');
  }

  // Exchange code for tokens
  const tokens = await exchangeAuthorization(serverInfo.authorizationServerUrl, {
    metadata: serverInfo.authorizationServerMetadata,
    clientInformation: clientInfo,
    authorizationCode: code,
    codeVerifier,
    redirectUri: getCallbackUrl(),
    resource: serverInfo.resourceMetadata?.resource
      ? new URL(serverInfo.resourceMetadata.resource)
      : undefined,
  });

  // Compute expires_at from expires_in (standard OAuth2 response field)
  const tokenData: StoredTokens = {
    access_token: (tokens as Record<string, unknown>).access_token as string,
    refresh_token: (tokens as Record<string, unknown>).refresh_token as string | undefined,
  };
  const expiresIn = (tokens as Record<string, unknown>).expires_in;
  if (typeof expiresIn === 'number' && expiresIn > 0) {
    tokenData.expires_at = Math.floor(Date.now() / 1000) + expiresIn;
  }

  // Store tokens
  cookieStore.set(TOKEN_COOKIE, JSON.stringify(tokenData), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 30, // 30 days
  });

  // Clean up verifier
  cookieStore.delete(VERIFIER_COOKIE);
}

/**
 * Refresh the access token using the stored refresh token.
 * Reads raw cookie directly to avoid circular call with getStoredTokens().
 */
export async function refreshTokens(): Promise<boolean> {
  const cookieStore = await cookies();
  const raw = cookieStore.get(TOKEN_COOKIE)?.value;
  if (!raw) return false;

  let tokens: StoredTokens;
  try { tokens = JSON.parse(raw); } catch { return false; }
  if (!tokens.refresh_token) return false;

  const clientInfo = await getStoredClient();
  if (!clientInfo) return false;

  try {
    const serverInfo = await discoverOAuthServerInfo(MCP_SERVER_URL);
    if (!serverInfo.authorizationServerMetadata) return false;

    const newTokens = await refreshAuthorization(serverInfo.authorizationServerUrl, {
      metadata: serverInfo.authorizationServerMetadata,
      clientInformation: clientInfo,
      refreshToken: tokens.refresh_token,
      resource: serverInfo.resourceMetadata?.resource
        ? new URL(serverInfo.resourceMetadata.resource)
        : undefined,
    });

    // Compute expires_at from the refreshed token response
    const tokenData: StoredTokens = {
      access_token: (newTokens as Record<string, unknown>).access_token as string,
      refresh_token: (newTokens as Record<string, unknown>).refresh_token as string | undefined ?? tokens.refresh_token,
    };
    const expiresIn = (newTokens as Record<string, unknown>).expires_in;
    if (typeof expiresIn === 'number' && expiresIn > 0) {
      tokenData.expires_at = Math.floor(Date.now() / 1000) + expiresIn;
    }

    const cookieStore = await cookies();
    cookieStore.set(TOKEN_COOKIE, JSON.stringify(tokenData), {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 30,
    });

    return true;
  } catch {
    return false;
  }
}

/**
 * Clear all MotherDuck OAuth state.
 */
export async function clearOAuthState(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(TOKEN_COOKIE);
  cookieStore.delete(VERIFIER_COOKIE);
  cookieStore.delete(CLIENT_COOKIE);
  cookieStore.delete(STATE_COOKIE);
}
