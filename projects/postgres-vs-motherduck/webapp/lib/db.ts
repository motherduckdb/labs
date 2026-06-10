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

/**
 * The "after" reads a ready-made, unrestricted MotherDuck **share** — so the demo
 * needs zero data-loading. Attach it once into your account under the name the app
 * connects to (default `multishop_commerce`):
 *
 *     uv run pipeline/attach_share.py        # or, in any MotherDuck SQL console:
 *     ATTACH 'md:_share/multishop_commerce/ac3d36cc-f295-4c66-bf13-371b998f12e8'
 *       AS multishop_commerce;
 *
 * Override with your own loaded database via MD_DATABASE (e.g. after running the
 * pipeline against your own Postgres), or point at a different share via MD_SHARE_URL.
 */
export const MOTHERDUCK_SHARE_URL =
  process.env.MD_SHARE_URL ?? "md:_share/multishop_commerce/ac3d36cc-f295-4c66-bf13-371b998f12e8";

/** The MotherDuck database the app reads — an attached share or your own load. */
export const MD_DATABASE = process.env.MD_DATABASE ?? "multishop_commerce";

export function poolFor(source: DataSource): Pool {
  if (source === "motherduck") {
    return new Pool({
      host: process.env.MD_PG_HOST ?? "pg.us-east-1-aws.motherduck.com",
      port: Number(process.env.MD_PG_PORT ?? 5432),
      // Any non-empty username works; the MotherDuck token is the credential.
      user: process.env.MD_PG_USER ?? "motherduck",
      password: process.env.MOTHERDUCK_TOKEN,
      database: MD_DATABASE,
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
