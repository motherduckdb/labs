import { Pool } from 'pg';

let pool: Pool | null = null;

function buildPool(): Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set');
  }

  const sslDisabled = /sslmode=disable/i.test(connectionString);

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
