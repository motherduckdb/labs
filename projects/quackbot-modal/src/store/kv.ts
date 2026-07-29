import { getPool } from './pg';

/**
 * TTL key/value cache in Postgres.
 *
 * Backs what query-guide.ts currently keeps in a module-level `{value,
 * expiresAt}` — a cache that only worked because the process outlived the TTL.
 * A per-turn container never does, so in-memory caching on Modal is a cache
 * with a 100% miss rate.
 *
 * Moving it here changes its character for the better: the guide fetch is now
 * shared across every container rather than repeated per process. The TTL
 * itself is unchanged in spirit — it exists to keep the system-prompt prefix
 * byte-identical across a thread's turns so the provider's prompt cache stays
 * warm, and that argument is if anything stronger when the alternative is
 * refetching on literally every turn.
 *
 * Expiry is enforced on read, not by a reaper: `kvGet` filters on `expires_at`,
 * so a stale row is a miss whether or not anything has pruned it. `pruneExpired`
 * reclaims space and is never required for correctness.
 */

interface ValueRow {
  value: unknown;
}

/**
 * Fetch `key`, or null if absent or expired.
 *
 * The `expires_at > now()` predicate uses the *database's* clock for both
 * sides of the comparison. That is deliberate: container clocks are not
 * guaranteed to agree, and a cache whose expiry depends on which machine read
 * it is a cache that expires unpredictably.
 *
 * The caller names the type; nothing here validates it. Values written by
 * `kvSet` round-trip through jsonb, so anything JSON can't represent (Date,
 * undefined, Map) does not come back the way it went in.
 */
export async function kvGet<T>(key: string): Promise<T | null> {
  const pool = getPool();
  const result = await pool.query<ValueRow>(
    'select value from kv_cache where key = $1 and expires_at > now()',
    [key],
  );
  const row = result.rows[0];
  if (!row) return null;
  return row.value as T;
}

/**
 * Write `key` with a TTL of `ttlMs`, replacing any existing entry.
 *
 * `JSON.stringify` is explicit rather than relying on node-postgres's own
 * object serialization, because the values we cache are frequently plain
 * strings (the query-guide text) — and a bare string handed to a jsonb
 * parameter is sent as text for Postgres to parse as JSON, which fails on any
 * guide that isn't coincidentally valid JSON. Stringifying makes strings,
 * objects and arrays all take the same path. Matches conversations.ts.
 *
 * The expiry is computed by Postgres from `now()` for the same
 * clock-consistency reason as the read side.
 */
export async function kvSet(key: string, value: unknown, ttlMs: number): Promise<void> {
  const pool = getPool();
  await pool.query(
    `insert into kv_cache (key, value, expires_at)
     values ($1, $2, now() + make_interval(secs => $3))
     on conflict (key)
     do update set value = excluded.value, expires_at = excluded.expires_at`,
    [key, JSON.stringify(value), ttlMs / 1000],
  );
}

/**
 * Drop `key` immediately. The invalidation seam for "a write just happened,
 * don't serve the pre-write guide for another 15 minutes" — the analogue of
 * query-guide.ts's `clearQueryGuideCache()`, which was also the test seam.
 */
export async function kvDelete(key: string): Promise<void> {
  const pool = getPool();
  await pool.query('delete from kv_cache where key = $1', [key]);
}

/** Delete every expired row. Housekeeping; returns the number removed. */
export async function pruneExpiredKv(): Promise<number> {
  const pool = getPool();
  const result = await pool.query('delete from kv_cache where expires_at <= now()');
  return result.rowCount ?? 0;
}
