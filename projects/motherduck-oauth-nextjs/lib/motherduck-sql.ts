import { Pool } from 'pg';
import { createMCPClient, executeToolWithStatus } from './mcp-client';

/**
 * Run actual SQL against MotherDuck server-side via its Postgres wire-protocol
 * endpoint, using the pure-JS `pg` client — no native module, so it runs fine
 * in serverless (unlike the DuckDB native addon, whose `libduckdb.so` can't
 * load in a Vercel function).
 *
 * Auth: the OAuth access token is NOT a MotherDuck connection token, so we
 * mint a short-lived MotherDuck token via the MCP `get_short_lived_token`
 * tool — whose response also tells us the regional `pgEndpoint` host. We
 * connect `postgres@<pgEndpoint>:5432/md:` with the SLT as the password (TLS
 * required) and write DuckDB SQL. The connection pool is cached per OAuth
 * token for a short window so repeated page loads don't re-mint/reconnect.
 */

interface PgCreds {
  token: string;
  host: string;
}

async function mintPgCreds(accessToken: string): Promise<PgCreds> {
  const client = await createMCPClient(accessToken);
  try {
    const { text, isError } = await executeToolWithStatus(client, 'get_short_lived_token', {});
    if (isError) {
      throw new Error(`get_short_lived_token failed: ${text.slice(0, 200)}`);
    }
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const token = parsed.shortLivedToken ?? parsed.short_lived_token ?? parsed.token ?? parsed.slt;
    const host = parsed.pgEndpoint ?? parsed.pg_endpoint;
    if (typeof token !== 'string' || !token) {
      throw new Error('No short-lived token in get_short_lived_token response');
    }
    if (typeof host !== 'string' || !host) {
      throw new Error('No pgEndpoint in get_short_lived_token response');
    }
    return { token, host };
  } finally {
    try { await client.close(); } catch { /* ignore */ }
  }
}

interface CachedPool {
  pool: Pool;
  createdAt: number;
}

const POOL_TTL_MS = 20 * 60 * 1000;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const pools = new Map<string, CachedPool>();

/**
 * Close and remove every cached pool whose age has reached the TTL.
 *
 * Because the OAuth access token rotates on refresh, an expired token's key is
 * never looked up again — so without a proactive sweep its `pg.Pool` would
 * linger in the Map for the process lifetime, leaking one pool per refresh.
 * This is invoked both at the start of every `getPool` call and from a periodic
 * background timer.
 */
function sweepExpiredPools(): void {
  const now = Date.now();
  for (const [key, cached] of pools) {
    if (now - cached.createdAt >= POOL_TTL_MS) {
      cached.pool.end().catch(() => { /* ignore */ });
      pools.delete(key);
    }
  }
}

// Create the periodic sweep exactly once at module level. `.unref()` keeps the
// timer from holding the Node process alive.
let sweepTimer: ReturnType<typeof setInterval> | undefined;
if (!sweepTimer) {
  sweepTimer = setInterval(sweepExpiredPools, SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();
}

async function getPool(accessToken: string): Promise<Pool> {
  // Proactively evict expired pools (including ones whose rotated token will
  // never be requested again) before serving this lookup.
  sweepExpiredPools();

  const cached = pools.get(accessToken);
  if (cached && Date.now() - cached.createdAt < POOL_TTL_MS) {
    return cached.pool;
  }
  if (cached) {
    cached.pool.end().catch(() => { /* ignore */ });
    pools.delete(accessToken);
  }

  const { token, host } = await mintPgCreds(accessToken);
  const pool = new Pool({
    host,
    port: 5432,
    user: 'postgres',
    password: token,
    database: 'md:',
    // MotherDuck's pg endpoint requires TLS; verify against the system/Node
    // CA bundle (equivalent to sslmode=verify-full).
    ssl: { rejectUnauthorized: true },
    max: 3,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,
  });
  // A pooled client erroring while idle must not crash the process.
  pool.on('error', (err) => {
    console.error('[motherduck-sql] idle pg client error:', err.message);
  });

  pools.set(accessToken, { pool, createdAt: Date.now() });
  return pool;
}

/**
 * Run a read-only SQL query (DuckDB syntax) as the signed-in user and return
 * row objects.
 *
 * When `params` is omitted this uses the **simple query protocol** (no
 * Parse/Bind): DuckDB's Postgres endpoint can't describe a prepared statement
 * whose result comes from a table function (e.g. MD_LIST_DIVES), so callers
 * that hit those inline their values instead. `params` (positional $1, $2…)
 * remains available for plain queries.
 */
export async function runUserQuery(
  accessToken: string,
  sql: string,
  params?: unknown[],
): Promise<Record<string, unknown>[]> {
  const pool = await getPool(accessToken);
  const result = params && params.length
    ? await pool.query(sql, params)
    : await pool.query(sql);
  return result.rows as Record<string, unknown>[];
}
