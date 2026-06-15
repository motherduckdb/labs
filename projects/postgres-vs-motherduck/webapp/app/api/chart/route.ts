/**
 * GET /api/chart?source=postgres|motherduck
 *
 * Runs the SAME heavy platform aggregate against ONE engine and returns the
 * monthly-revenue series plus the server-measured query latency. The comparison
 * page calls this twice — once per engine, in parallel — so each chart renders
 * the moment its own engine answers, and you watch the load-time gap live.
 */
import { NextResponse } from "next/server";
import { poolFor, timedQuery, type DataSource } from "@/lib/db";
import { PLATFORM_MONTHLY_REVENUE } from "@/lib/queries";

export const dynamic = "force-dynamic";

type Row = { plan_tier: string; month: string; revenue: number; orders: number };

export async function GET(req: Request) {
  const param = new URL(req.url).searchParams.get("source");
  const source: DataSource = param === "motherduck" ? "motherduck" : "postgres";

  const pool = poolFor(source);
  try {
    const { ms, rows } = await timedQuery<Row>(pool, PLATFORM_MONTHLY_REVENUE);

    // Roll the tier breakdown up to one revenue total per month — a basic chart.
    const byMonth = new Map<string, number>();
    for (const r of rows) {
      const month = new Date(r.month).toISOString().slice(0, 7);
      byMonth.set(month, (byMonth.get(month) ?? 0) + Number(r.revenue));
    }
    const points = [...byMonth.entries()]
      .map(([month, revenue]) => ({ month, revenue }))
      .sort((a, b) => a.month.localeCompare(b.month));

    return NextResponse.json({ source, ms: Math.round(ms), rowCount: rows.length, points });
  } catch (err) {
    return NextResponse.json(
      { source, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  } finally {
    await pool.end();
  }
}
