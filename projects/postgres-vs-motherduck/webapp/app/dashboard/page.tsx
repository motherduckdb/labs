/**
 * Internal admin dashboard (Server Component). Reads the heavy platform aggregate
 * through the `pg` driver — pointed at Postgres or MotherDuck purely by the
 * DATA_SOURCE env var. The component code does not change between "before" and
 * "after"; only where it connects does.
 */
import { appPool } from "@/lib/db";
import { PLATFORM_MONTHLY_REVENUE } from "@/lib/queries";

export const dynamic = "force-dynamic";

type Row = { plan_tier: string; month: string; revenue: number; orders: number };

export default async function DashboardPage() {
  const pool = appPool();
  const start = performance.now();
  const { rows } = await pool.query<Row>(PLATFORM_MONTHLY_REVENUE);
  const ms = performance.now() - start;
  const source = process.env.DATA_SOURCE ?? "postgres";

  return (
    <main style={{ fontFamily: "system-ui", padding: 24, maxWidth: 720 }}>
      <h1>Platform revenue</h1>
      <p style={{ color: "#666" }}>
        Source: <strong>{source}</strong> · query took <strong>{ms.toFixed(0)} ms</strong> ·{" "}
        {rows.length} rows
      </p>
      <table cellPadding={6} style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "1px solid #ddd" }}>
            <th>Plan tier</th>
            <th>Month</th>
            <th style={{ textAlign: "right" }}>Revenue</th>
            <th style={{ textAlign: "right" }}>Orders</th>
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 36).map((r, i) => (
            <tr key={i} style={{ borderBottom: "1px solid #f0f0f0" }}>
              <td>{r.plan_tier}</td>
              <td>{new Date(r.month).toISOString().slice(0, 7)}</td>
              <td style={{ textAlign: "right" }}>${Number(r.revenue).toLocaleString()}</td>
              <td style={{ textAlign: "right" }}>{Number(r.orders).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
