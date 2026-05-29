import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import { createMCPClient, executeToolWithStatus } from './mcp-client';
import { getMotherDuckApiUrl } from './motherduck-env';

/**
 * Run actual SQL against MotherDuck server-side via a DuckDB connection —
 * no MCP `query` tool, so no ~50KB response cap.
 *
 * Auth: the OAuth access token is NOT a MotherDuck connection token (the
 * MD REST API rejects it), so we mint a short-lived MotherDuck token via the
 * MCP `get_short_lived_token` tool and connect DuckDB with it (`md:` +
 * `motherduck_token`). The SLT lasts ~24h; we cache the live connection per
 * OAuth token for a short window so repeated page loads don't reconnect.
 */

interface CachedConnection {
  instance: DuckDBInstance;
  conn: DuckDBConnection;
  createdAt: number;
}

const CONNECTION_TTL_MS = 20 * 60 * 1000;
const connections = new Map<string, CachedConnection>();

/** Mint a short-lived MotherDuck token from the user's OAuth session. */
async function mintShortLivedToken(accessToken: string): Promise<string> {
  const client = await createMCPClient(accessToken);
  try {
    const { text, isError } = await executeToolWithStatus(client, 'get_short_lived_token', {});
    if (isError) {
      throw new Error(`get_short_lived_token failed: ${text.slice(0, 200)}`);
    }
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const slt = parsed.shortLivedToken ?? parsed.short_lived_token ?? parsed.token ?? parsed.slt;
    if (typeof slt !== 'string' || !slt) {
      throw new Error('No short-lived token in get_short_lived_token response');
    }
    return slt;
  } finally {
    try { await client.close(); } catch { /* ignore */ }
  }
}

/** Non-prod hosts (staging) need the MD extension pointed at the right API. */
function mdConnectOptions(token: string): Record<string, string> {
  const options: Record<string, string> = { motherduck_token: token };
  try {
    const host = new URL(getMotherDuckApiUrl()).host;
    if (host && host !== 'api.motherduck.com') {
      options.motherduck_host = host;
    }
  } catch { /* default prod */ }
  return options;
}

async function getConnection(accessToken: string): Promise<DuckDBConnection> {
  const cached = connections.get(accessToken);
  if (cached && Date.now() - cached.createdAt < CONNECTION_TTL_MS) {
    return cached.conn;
  }
  if (cached) {
    try { cached.instance.closeSync(); } catch { /* ignore */ }
    connections.delete(accessToken);
  }

  const slt = await mintShortLivedToken(accessToken);
  const instance = await DuckDBInstance.create('md:', mdConnectOptions(slt));
  const conn = await instance.connect();
  connections.set(accessToken, { instance, conn, createdAt: Date.now() });
  return conn;
}

/**
 * Run a read-only SQL query as the signed-in user and return JS-native row
 * objects. `params` binds values safely (e.g. a search term) — never
 * string-concatenate user input into `sql`.
 */
export async function runUserQuery(
  accessToken: string,
  sql: string,
  params?: Record<string, string | number | boolean | null>,
): Promise<Record<string, unknown>[]> {
  const conn = await getConnection(accessToken);
  const reader = params
    ? await conn.runAndReadAll(sql, params)
    : await conn.runAndReadAll(sql);
  return reader.getRowObjectsJS() as Record<string, unknown>[];
}
