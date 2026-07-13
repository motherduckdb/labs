import { Pool, type PoolConfig } from 'pg';
import { readFileSync } from 'node:fs';

let pool: Pool | null = null;

/**
 * Derive a strict `PoolConfig` from a DATABASE_URL. TLS verification is ALWAYS
 * on unless `sslmode=disable` is explicitly present — no code path connects
 * with an unverified certificate, which would be MITM-able.
 *
 * pg parses ssl* query params itself and treats `sslrootcert=system` (as in
 * PlanetScale connection strings) as a literal cert-file path — ENOENT. TLS is
 * configured explicitly here instead, so those params are stripped from the URL
 * (Node's default trust store already covers `sslrootcert=system`). `ssl` /
 * `sslmode` are stripped too: pg applies connection-string params AFTER the
 * explicit options, so a stray `?ssl=0` / `?sslmode=no-verify` would otherwise
 * silently weaken the config set here.
 */
export function resolvePoolConfig(raw: string): PoolConfig {
  const sslDisabled = /(?:^|[?&])sslmode=disable(?:&|$)/i.test(raw);
  const TLS_PARAMS = ['ssl', 'sslmode', 'sslrootcert', 'sslcert', 'sslkey'];

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // Not URL-shaped (e.g. libpq key=value form) — can't safely strip params,
    // so pass through with explicit strict TLS still applied.
    return {
      connectionString: raw,
      max: 5,
      ssl: sslDisabled ? false : { rejectUnauthorized: true },
    };
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
    return { connectionString: url.toString(), max: 5, ssl };
  }

  for (const key of TLS_PARAMS) url.searchParams.delete(key);
  return {
    connectionString: url.toString(),
    max: 5,
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
