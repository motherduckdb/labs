import { Pool, types } from 'pg';
import { createMCPClient, executeToolWithStatus } from './mcp-client';
import { getMotherDuckApiUrl } from './motherduck-env';

// Return BIGINT (oid 20) and NUMERIC (oid 1700) as JS numbers rather than
// strings, so dive chart libraries can do arithmetic on aggregate columns
// (COUNT/SUM/AVG). Loses precision above 2^53 — fine for visualization; a dive
// needing exact big integers can CAST to VARCHAR.
types.setTypeParser(20, (v) => (v === null ? null : Number(v)));
types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));

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
  // The in-flight (or settled) pool creation. Caching the PROMISE — not just a
  // resolved Pool — dedupes concurrent first-time lookups (a dive fires many
  // queries at once) so we mint exactly one token per pool, not one per query.
  promise: Promise<Pool>;
  createdAt: number;
}

const POOL_TTL_MS = 20 * 60 * 1000;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
// Keyed by `${mode}:${accessToken}` — separate read/write (list, delete) and
// read-scaling (dive query proxy) pools per user.
const pools = new Map<string, CachedPool>();

/**
 * Mint a delegated, engine-enforced READ-ONLY token for the signed-in user via
 * `POST /v1/users/{username}/tokens` (token_type=read_scaling). Read-scaling
 * tokens route to read-only replicas that reject all writes, so the query
 * proxy can't be coerced into a mutation regardless of the SQL. Authenticated
 * with the user's own (read/write) short-lived token, for their own username —
 * stays delegated and per-user.
 */
async function mintReadScalingCreds(accessToken: string): Promise<PgCreds> {
  const { token: rwToken, host } = await mintPgCreds(accessToken);
  const rows = await runUserQuery(accessToken, 'SELECT CURRENT_USER AS username');
  const username = rows[0]?.username;
  if (typeof username !== 'string' || !username) {
    throw new Error('Could not resolve current MotherDuck user for read-scaling token');
  }
  // Unique name per mint: MotherDuck rejects duplicate token names (409), and
  // we mint a fresh one each time a pool is (re)created. ttl makes them
  // self-expire so they don't accumulate. (A production app would DELETE the
  // token on pool eviction.)
  const name = `md-dive-viewer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const res = await fetch(`${getMotherDuckApiUrl()}/v1/users/${encodeURIComponent(username)}/tokens`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${rwToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, token_type: 'read_scaling', ttl: 1800 }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`read_scaling token mint failed (${res.status}): ${detail.slice(0, 200)}`);
  }
  const data = (await res.json()) as Record<string, unknown>;
  const token = data.token ?? data.value ?? data.access_token;
  if (typeof token !== 'string' || !token) {
    throw new Error('read_scaling token response missing `token`');
  }
  return { token, host };
}

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
      cached.promise.then((p) => p.end()).catch(() => { /* ignore */ });
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

/** Get-or-create a cached pg pool for `key`, building creds via `mintCreds`. */
function getPoolFor(key: string, mintCreds: () => Promise<PgCreds>): Promise<Pool> {
  // Proactively evict expired pools (including ones whose rotated token will
  // never be requested again) before serving this lookup.
  sweepExpiredPools();

  const cached = pools.get(key);
  if (cached && Date.now() - cached.createdAt < POOL_TTL_MS) {
    return cached.promise;
  }
  if (cached) {
    cached.promise.then((p) => p.end()).catch(() => { /* ignore */ });
    pools.delete(key);
  }

  // Build synchronously into the cache BEFORE any await, so concurrent callers
  // in this tick share this one promise (one token mint, not N).
  const promise = (async () => {
    const { token, host } = await mintCreds();
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
    return pool;
  })();

  pools.set(key, { promise, createdAt: Date.now() });
  // Don't cache a failed creation — evict so the next request retries.
  promise.catch(() => {
    if (pools.get(key)?.promise === promise) pools.delete(key);
  });
  return promise;
}

/** Read/write pool (list, delete, resolving CURRENT_USER). */
function getPool(accessToken: string): Promise<Pool> {
  return getPoolFor(`rw:${accessToken}`, () => mintPgCreds(accessToken));
}

/** Read-scaling (engine-enforced read-only) pool for the dive query proxy. */
function getReadScalingPool(accessToken: string): Promise<Pool> {
  return getPoolFor(`ro:${accessToken}`, () => mintReadScalingCreds(accessToken));
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

/**
 * Run a Dive's query as the signed-in user over a **read-scaling (read-only)**
 * connection — the engine rejects any write the SQL guard might miss. ATTACH
 * the dive's required shares (idempotent, failures tolerated) then run the
 * (already read-only-validated) SQL on ONE checked-out connection so the
 * ATTACHes are visible to the query.
 */
export async function runDiveQuery(
  accessToken: string,
  sql: string,
  requiredDatabases: Array<{ path?: unknown; alias?: unknown }> = [],
): Promise<Record<string, unknown>[]> {
  const pool = await getReadScalingPool(accessToken);
  const client = await pool.connect();
  try {
    for (const db of requiredDatabases) {
      if (!db || typeof db.path !== 'string' || typeof db.alias !== 'string') continue;
      const path = db.path.replace(/'/g, "''");
      const alias = db.alias.replace(/"/g, '""');
      try {
        await client.query(`ATTACH IF NOT EXISTS '${path}' AS "${alias}"`);
      } catch {
        // A share the user can't attach shouldn't abort the query — the dive's
        // SELECT may not even reference it.
      }
    }
    const result = await client.query(sql);
    return result.rows as Record<string, unknown>[];
  } finally {
    client.release();
  }
}
