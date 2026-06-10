/**
 * GET /api/benchmark?shop=1
 * Runs the platform aggregate against Postgres and MotherDuck and returns both
 * latencies + the speedup. This is the live version of scripts/benchmark.ts, so
 * the dashboard can show the before/after without a terminal.
 */
import { NextResponse } from "next/server";
import { poolFor, timedQuery } from "@/lib/db";
import { PLATFORM_MONTHLY_REVENUE } from "@/lib/queries";

export const dynamic = "force-dynamic";

export async function GET() {
  const pg = poolFor("postgres");
  const md = poolFor("motherduck");
  try {
    const postgres = await timedQuery(pg, PLATFORM_MONTHLY_REVENUE);
    const motherduck = await timedQuery(md, PLATFORM_MONTHLY_REVENUE);
    return NextResponse.json({
      query: "platform_monthly_revenue",
      postgres_ms: Math.round(postgres.ms),
      motherduck_ms: Math.round(motherduck.ms),
      speedup: Number((postgres.ms / motherduck.ms).toFixed(1)),
      row_counts_match: postgres.rowCount === motherduck.rowCount,
    });
  } finally {
    await Promise.allSettled([pg.end(), md.end()]);
  }
}
