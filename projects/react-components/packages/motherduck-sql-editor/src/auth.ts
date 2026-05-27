import { Auth0ContextInterface } from '@auth0/auth0-react';

const canUseDOM = typeof window !== 'undefined' && typeof document !== 'undefined';

export interface AuthConfig {
  /** URL that exchanges an Auth0 ID token for a MotherDuck token. */
  mdTokenLookupUrl: string;
  /**
   * Cookie domain for the cross-page ID-token bridge. Defaults to the current
   * host (no `domain` attribute), which keeps the bridge scoped to a single
   * subdomain. Set to e.g. `.example.com` to share across subdomains.
   */
  cookieDomain?: string;
  /**
   * Path used when setting bridge cookies. Default: `/`.
   */
  cookiePath?: string;
}

let config: AuthConfig = {
  mdTokenLookupUrl: 'https://surfacecontroller.motherduck.com/mom/lookup-user',
  cookiePath: '/',
};

export const configureAuth = (overrides: Partial<AuthConfig>): void => {
  config = { ...config, ...overrides };
};

const AUTH0_BRIDGE_COOKIE = 'auth0_id_token_bridge';

let auth0ReactContext: Auth0ContextInterface | null = null;

export const setAuth0ReactContext = (context: Auth0ContextInterface): void => {
  auth0ReactContext = context;
  if (canUseDOM) {
    try {
      window.dispatchEvent(new Event('md_token_update'));
    } catch {
      /* noop */
    }
  }
};

export const getAuth0ReactContext = (): Auth0ContextInterface | null => auth0ReactContext;

const cookieAttrs = (maxAgeSeconds: number): string => {
  const isSecure = canUseDOM && window.location.protocol === 'https:';
  return [
    `max-age=${maxAgeSeconds}`,
    `path=${config.cookiePath ?? '/'}`,
    config.cookieDomain ? `domain=${config.cookieDomain}` : '',
    isSecure ? 'secure' : '',
    'samesite=strict',
  ]
    .filter(Boolean)
    .join('; ');
};

export const storeAuth0TokenBridge = (idToken: string): void => {
  if (!canUseDOM) return;
  try {
    const encoded = btoa(idToken);
    document.cookie = `${AUTH0_BRIDGE_COOKIE}=${encoded}; ${cookieAttrs(3600)}`;
  } catch (err) {
    console.error('Failed to store Auth0 token bridge:', err);
  }
};

export const getAuth0TokenBridge = (): string | null => {
  if (!canUseDOM) return null;
  try {
    const cookie = document.cookie.split(';').find((c) => c.trim().startsWith(`${AUTH0_BRIDGE_COOKIE}=`));
    if (!cookie) return null;
    const idToken = atob(cookie.split('=')[1]);
    // Basic expiry check
    try {
      const payload = JSON.parse(atob(idToken.split('.')[1]));
      if (payload.exp && payload.exp < Date.now() / 1000) {
        clearAuth0TokenBridge();
        return null;
      }
    } catch {
      /* noop */
    }
    return idToken;
  } catch (err) {
    console.error('Error retrieving Auth0 token bridge:', err);
    return null;
  }
};

export const clearAuth0TokenBridge = (): void => {
  if (!canUseDOM) return;
  document.cookie = `${AUTH0_BRIDGE_COOKIE}=; ${cookieAttrs(0)}`;
};

export const fetchMotherDuckToken = async (idToken: string): Promise<string | null> => {
  if (!canUseDOM || !idToken) return null;
  try {
    const response = await fetch(config.mdTokenLookupUrl, {
      method: 'GET',
      headers: { Authorization: `Bearer ${idToken}` },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }
    const data = await response.json();
    return data.token ?? null;
  } catch (err) {
    console.error('Failed to fetch MotherDuck token:', err);
    return null;
  }
};

export const redirectToAuth0Login = async (): Promise<void> => {
  if (!auth0ReactContext) {
    throw new Error('Auth0 React context not set. Call setAuth0ReactContext() from inside an Auth0Provider.');
  }
  auth0ReactContext.loginWithRedirect({
    appState: { returnTo: window.location.href },
  });
};

export const logout = async (): Promise<void> => {
  clearAuth0TokenBridge();
  if (!auth0ReactContext) return;
  auth0ReactContext.logout({
    logoutParams: { returnTo: window.location.origin },
  });
};
