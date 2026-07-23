import { Pool, type PoolConfig } from 'pg';
import { readFileSync } from 'node:fs';

let pool: Pool | null = null;

/**
 * Derive a strict `PoolConfig` from a DATABASE_URL. TLS verification is ALWAYS
 * on unless `sslmode=disable` is explicitly present AND the host is loopback
 * (localhost / 127.0.0.1 / ::1) — no code path connects with an unverified
 * certificate, which would be MITM-able. `sslmode=disable` against a
 * non-loopback host, or in a connection string whose host can't be
 * determined (not URL-shaped), throws at startup rather than silently
 * transmitting credentials in plaintext.
 *
 * pg parses ssl* query params itself and treats `sslrootcert=system` (as in
 * PlanetScale connection strings) as a literal cert-file path — ENOENT. TLS is
 * configured explicitly here instead, so those params are stripped from the URL
 * (Node's default trust store already covers `sslrootcert=system`). `ssl` /
 * `sslmode` are stripped too: pg applies connection-string params AFTER the
 * explicit options, so a stray `?ssl=0` / `?sslmode=no-verify` would otherwise
 * silently weaken the config set here.
 */
// Bound every connection and query so a slow/hung Postgres can't wedge a turn
// (which holds the per-thread mutex + MCP client open) indefinitely. Applied to
// every config branch below.
//
// All CLIENT-side (pool/JS timers): connectionTimeoutMillis + idleTimeoutMillis
// are pool timers, and query_timeout is node-postgres's own per-query JS timer.
// NOTE: `statement_timeout` is deliberately NOT set — pg sends it as a server
// STARTUP parameter, which PlanetScale's connection pooler rejects outright
// ("unsupported startup parameter: statement_timeout"). query_timeout reaps a
// hung query client-side and needs no server cooperation.
const POOL_TIMEOUTS = {
  max: 5,
  connectionTimeoutMillis: 10_000,
  idleTimeoutMillis: 30_000,
  query_timeout: 30_000,
} as const;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function resolvePoolConfig(raw: string): PoolConfig {
  // Matches both query-string (`?`/`&`-delimited) and libpq key=value
  // (space-delimited) connection-string forms.
  const sslDisabled = /(?:^|[?&\s])sslmode=disable(?:[&\s]|$)/i.test(raw);
  const TLS_PARAMS = ['ssl', 'sslmode', 'sslrootcert', 'sslcert', 'sslkey'];

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // Not URL-shaped (e.g. libpq key=value form) — the host can't be
    // determined, so `sslmode=disable` can't be verified as loopback-only.
    // Refuse to guess: fail fast rather than risking a plaintext connection
    // to a production host.
    if (sslDisabled) {
      throw new Error('sslmode=disable is only permitted for localhost — remove it or use TLS');
    }
    return {
      connectionString: raw,
      ...POOL_TIMEOUTS,
      ssl: { rejectUnauthorized: true },
    };
  }

  if (sslDisabled && !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error('sslmode=disable is only permitted for localhost — remove it or use TLS');
  }

  const rootcert = url.searchParams.get('sslrootcert');
  const sslcert = url.searchParams.get('sslcert');
  const sslkey = url.searchParams.get('sslkey');

  if ((rootcert && rootcert !== 'system') || sslcert || sslkey) {
    // Custom CA / mutual TLS. Build the ssl config explicitly and read the
    // referenced files ourselves — crucially with rejectUnauthorized: true, so
    // the server certificate is ALWAYS verified. We must NOT hand the raw URL
    // to pg here: pg's own `sslmode=require` performs TLS *without* verifying
    // the cert, so `sslrootcert=/custom/ca&sslmode=require` would otherwise
    // connect unverified (the latent hole this fixes). The readFileSync calls
    // are intentionally outside the URL-parse guard above so a missing cert
    // fails loudly rather than silently degrading to an unverified connection.
    const ssl: { rejectUnauthorized: boolean; ca?: string; cert?: string; key?: string } = {
      rejectUnauthorized: true,
    };
    if (rootcert && rootcert !== 'system') ssl.ca = readFileSync(rootcert, 'utf8');
    if (sslcert) ssl.cert = readFileSync(sslcert, 'utf8');
    if (sslkey) ssl.key = readFileSync(sslkey, 'utf8');
    for (const key of TLS_PARAMS) url.searchParams.delete(key);
    return { connectionString: url.toString(), ...POOL_TIMEOUTS, ssl };
  }

  for (const key of TLS_PARAMS) url.searchParams.delete(key);
  return {
    connectionString: url.toString(),
    ...POOL_TIMEOUTS,
    ssl: sslDisabled ? false : { rejectUnauthorized: true },
  };
}

function buildPool(): Pool {
  const raw = process.env.DATABASE_URL;
  if (!raw) {
    throw new Error('DATABASE_URL is not set');
  }
  return new Pool(resolvePoolConfig(raw));
}

/** Lazily-created singleton pool, built from `process.env.DATABASE_URL`. */
export function getPool(): Pool {
  if (!pool) {
    pool = buildPool();
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (!pool) return;
  const current = pool;
  pool = null;
  await current.end();
}
