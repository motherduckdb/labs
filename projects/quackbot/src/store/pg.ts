import { Pool } from 'pg';

let pool: Pool | null = null;

function buildPool(): Pool {
  const raw = process.env.DATABASE_URL;
  if (!raw) {
    throw new Error('DATABASE_URL is not set');
  }

  // pg parses ssl* query params itself and treats `sslrootcert=system` (as in
  // PlanetScale connection strings) as a literal cert-file path — ENOENT. TLS
  // is configured explicitly below instead, so drop those params from the URL;
  // Node's default trust store already covers what `sslrootcert=system` asks
  // for. `ssl` is dropped too: pg applies connection-string params AFTER the
  // explicit options, so a stray `?ssl=0` / `?ssl=no-verify` would silently
  // weaken the strict TLS config set here.
  let connectionString = raw;
  const sslDisabled = /sslmode=disable/i.test(raw);
  try {
    const url = new URL(raw);
    const rootcert = url.searchParams.get('sslrootcert');
    if ((rootcert && rootcert !== 'system') || url.searchParams.has('sslcert') || url.searchParams.has('sslkey')) {
      // Custom CA or mutual TLS — those params point at real files, so let
      // pg parse the URL as-is rather than clobber the operator's setup.
      return new Pool({ connectionString: raw, max: 5 });
    }
    for (const key of ['ssl', 'sslmode', 'sslrootcert']) {
      url.searchParams.delete(key);
    }
    connectionString = url.toString();
  } catch {
    // Not URL-shaped (e.g. key=value form) — pass through untouched.
  }

  return new Pool({
    connectionString,
    max: 5,
    ssl: sslDisabled ? false : { rejectUnauthorized: true },
  });
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
