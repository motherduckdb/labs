import { Pool } from "pg";

/**
 * The before/after switch lives here. Both code paths use the SAME `pg` driver;
 * `DATA_SOURCE` only decides which host the pool points at.
 *
 *   postgres   → your managed Postgres (Supabase / Neon / RDS / PlanetScale for Postgres…)
 *   motherduck → MotherDuck's Postgres wire-protocol endpoint
 *
 * The MotherDuck endpoint needs no DuckDB native extension, so this works fine
 * inside a Vercel serverless function / Next.js Server Component.
 */
export type DataSource = "postgres" | "motherduck";

export function poolFor(source: DataSource): Pool {
  if (source === "motherduck") {
    return new Pool({
      host: process.env.MD_PG_HOST ?? "pg.us-east-1-aws.motherduck.com",
      port: Number(process.env.MD_PG_PORT ?? 5432),
      // Any non-empty username works; the MotherDuck token is the credential.
      user: process.env.MD_PG_USER ?? "motherduck",
      password: process.env.MOTHERDUCK_TOKEN,
      database: process.env.MD_DATABASE ?? "multishop_commerce",
      ssl: { rejectUnauthorized: false },
      max: 4,
    });
  }
  // "postgres" — any managed Postgres, via a standard connection string.
  return new Pool({
    connectionString: process.env.POSTGRES_URL,
    ssl: process.env.POSTGRES_SSL === "false" ? false : { rejectUnauthorized: false },
    max: 4,
  });
}

/** The pool the app reads from, chosen by env. Flip DATA_SOURCE to swap engines. */
export function appPool(): Pool {
  return poolFor((process.env.DATA_SOURCE as DataSource) ?? "postgres");
}

export interface Timed<T> {
  ms: number;
  rowCount: number;
  rows: T[];
}

/** Run a query and measure wall-clock latency in milliseconds. */
export async function timedQuery<T = Record<string, unknown>>(
  pool: Pool,
  sql: string,
  params: unknown[] = [],
): Promise<Timed<T>> {
  const start = performance.now();
  const res = await pool.query(sql, params);
  const ms = performance.now() - start;
  return { ms, rowCount: res.rowCount ?? res.rows.length, rows: res.rows as T[] };
}
