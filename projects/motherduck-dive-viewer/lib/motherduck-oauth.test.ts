import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./motherduck-env', () => ({
  getMotherDuckMcpUrl: () => 'https://api.example.com',
}));

vi.mock('@modelcontextprotocol/sdk/client/auth.js', () => ({
  discoverOAuthServerInfo: vi.fn(),
  registerClient: vi.fn(),
  startAuthorization: vi.fn(),
  exchangeAuthorization: vi.fn(),
  refreshAuthorization: vi.fn(),
}));

type CookieValue = { value: string };
type CookieStore = {
  get: (name: string) => CookieValue | undefined;
  set: (name: string, value: string, opts?: unknown) => void;
  delete: (name: string) => void;
};

let cookieJar: Map<string, string>;

vi.mock('next/headers', () => ({
  cookies: async (): Promise<CookieStore> => ({
    get: (name: string) => {
      const v = cookieJar.get(name);
      return v === undefined ? undefined : { value: v };
    },
    set: (name: string, value: string) => {
      cookieJar.set(name, value);
    },
    delete: (name: string) => {
      cookieJar.delete(name);
    },
  }),
}));

import {
  startOAuthFlow,
  handleOAuthCallback,
  clearOAuthState,
  OAuthStateError,
} from './motherduck-oauth';
import {
  discoverOAuthServerInfo,
  registerClient,
  startAuthorization,
  exchangeAuthorization,
} from '@modelcontextprotocol/sdk/client/auth.js';

const mockedDiscover = vi.mocked(discoverOAuthServerInfo);
const mockedRegister = vi.mocked(registerClient);
const mockedStartAuth = vi.mocked(startAuthorization);
const mockedExchange = vi.mocked(exchangeAuthorization);

const FAKE_SERVER_INFO = {
  authorizationServerUrl: 'https://auth.example.com',
  authorizationServerMetadata: {
    issuer: 'https://auth.example.com',
    authorization_endpoint: 'https://auth.example.com/authorize',
    token_endpoint: 'https://auth.example.com/token',
    response_types_supported: ['code'],
  },
  resourceMetadata: undefined,
} as unknown as Awaited<ReturnType<typeof discoverOAuthServerInfo>>;

const FAKE_CLIENT = {
  client_id: 'fake-client-id',
  redirect_uris: ['http://localhost:3000/api/auth/motherduck/callback'],
};

beforeEach(() => {
  cookieJar = new Map();
  vi.clearAllMocks();
  mockedDiscover.mockResolvedValue(FAKE_SERVER_INFO);
  mockedRegister.mockResolvedValue(FAKE_CLIENT as unknown as Awaited<ReturnType<typeof registerClient>>);
  mockedStartAuth.mockImplementation(async (_url, opts: { state?: string }) => ({
    authorizationUrl: new URL(`https://auth.example.com/authorize?state=${opts.state ?? ''}`),
    codeVerifier: 'fake-verifier',
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('startOAuthFlow', () => {
  it('passes a state value to startAuthorization and stores it in a cookie', async () => {
    await startOAuthFlow();
    const args = mockedStartAuth.mock.calls[0][1];
    expect(args.state).toBeDefined();
    expect(typeof args.state).toBe('string');
    expect((args.state as string).length).toBeGreaterThan(20);
    expect(cookieJar.get('md-oauth-state')).toBe(args.state);
  });

  it('generates a fresh state on each call', async () => {
    await startOAuthFlow();
    const first = cookieJar.get('md-oauth-state');
    cookieJar.delete('md-oauth-state'); // simulate expiry / cookie clear
    await startOAuthFlow();
    const second = cookieJar.get('md-oauth-state');
    expect(first).not.toBe(second);
    expect(first && second).toBeTruthy();
  });

  it('also stores the verifier cookie', async () => {
    await startOAuthFlow();
    expect(cookieJar.get('md-oauth-verifier')).toBe('fake-verifier');
  });
});

describe('handleOAuthCallback state validation', () => {
  beforeEach(() => {
    mockedExchange.mockResolvedValue({
      access_token: 'fake-access',
      refresh_token: 'fake-refresh',
      expires_in: 3600,
    } as unknown as Awaited<ReturnType<typeof exchangeAuthorization>>);
  });

  async function seedSession(state = 'cookie-state'): Promise<void> {
    cookieJar.set('md-oauth-state', state);
    cookieJar.set('md-oauth-verifier', 'fake-verifier');
    cookieJar.set('md-oauth-client', JSON.stringify(FAKE_CLIENT));
  }

  it('rejects with OAuthStateError when no state cookie is present', async () => {
    cookieJar.set('md-oauth-verifier', 'fake-verifier');
    cookieJar.set('md-oauth-client', JSON.stringify(FAKE_CLIENT));

    await expect(handleOAuthCallback('the-code', 'returned-state'))
      .rejects.toBeInstanceOf(OAuthStateError);
    expect(mockedExchange).not.toHaveBeenCalled();
  });

  it('rejects with OAuthStateError when state query param is missing', async () => {
    await seedSession('cookie-state');
    await expect(handleOAuthCallback('the-code', null))
      .rejects.toBeInstanceOf(OAuthStateError);
    expect(mockedExchange).not.toHaveBeenCalled();
  });

  it('rejects with OAuthStateError when state values do not match', async () => {
    await seedSession('cookie-state');
    await expect(handleOAuthCallback('the-code', 'different-state'))
      .rejects.toBeInstanceOf(OAuthStateError);
    expect(mockedExchange).not.toHaveBeenCalled();
  });

  it('clears the state cookie on mismatch so it cannot be replayed', async () => {
    await seedSession('cookie-state');
    await expect(handleOAuthCallback('the-code', 'wrong'))
      .rejects.toBeInstanceOf(OAuthStateError);
    expect(cookieJar.get('md-oauth-state')).toBeUndefined();
  });

  it('exchanges the code and stores tokens when state matches', async () => {
    await seedSession('matching-state');
    await handleOAuthCallback('the-code', 'matching-state');
    expect(mockedExchange).toHaveBeenCalledOnce();
    expect(cookieJar.get('md-oauth-tokens')).toBeDefined();
    const stored = JSON.parse(cookieJar.get('md-oauth-tokens')!);
    expect(stored.access_token).toBe('fake-access');
  });

  it('clears state and verifier cookies after a successful exchange', async () => {
    await seedSession('matching-state');
    await handleOAuthCallback('the-code', 'matching-state');
    expect(cookieJar.get('md-oauth-state')).toBeUndefined();
    expect(cookieJar.get('md-oauth-verifier')).toBeUndefined();
  });
});

describe('clearOAuthState', () => {
  it('removes all OAuth cookies including state', async () => {
    cookieJar.set('md-oauth-tokens', 'x');
    cookieJar.set('md-oauth-verifier', 'y');
    cookieJar.set('md-oauth-client', 'z');
    cookieJar.set('md-oauth-state', 's');
    await clearOAuthState();
    expect(cookieJar.size).toBe(0);
  });
});
