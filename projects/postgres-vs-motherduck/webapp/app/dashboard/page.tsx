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
  const accent = source === "motherduck" ? "var(--darker-duck)" : "var(--postgres)";

  return (
    <main style={{ padding: "32px 24px 64px", maxWidth: 760, margin: "0 auto" }}>
      <a
        href="/"
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 12,
          textTransform: "uppercase",
          letterSpacing: "0.03em",
          color: "var(--darker-grey)",
          textDecoration: "none",
        }}
      >
        ← Postgres vs MotherDuck
      </a>
      <p className="md-eyebrow" style={{ margin: "12px 0 8px" }}>
        Single-source dashboard
      </p>
      <h1>Platform revenue</h1>
      <p
        style={{
          color: "var(--darker-grey)",
          marginTop: 0,
          display: "flex",
          gap: 8,
          alignItems: "center",
          flexWrap: "wrap",
          fontSize: 14,
        }}
      >
        Source:{" "}
        <span
          style={{
            fontFamily: "var(--font-mono)",
            textTransform: "uppercase",
            fontSize: 12,
            fontWeight: 600,
            color: "var(--ink)",
            background: accent,
            padding: "2px 8px",
            borderRadius: "var(--radius)",
            border: "2px solid var(--ink)",
          }}
        >
          {source}
        </span>
        · query took <strong style={{ fontFamily: "var(--font-mono)" }}>{ms.toFixed(0)} ms</strong>{" "}
        · {rows.length} rows
      </p>

      <div className="md-card" style={{ overflow: "hidden", marginTop: 16 }}>
        <table cellPadding={0} style={{ borderCollapse: "collapse", width: "100%", fontSize: 13 }}>
          <thead>
            <tr
              style={{
                textAlign: "left",
                background: "var(--sand)",
                borderBottom: "2px solid var(--ink)",
              }}
            >
              <Th>Plan tier</Th>
              <Th>Month</Th>
              <Th align="right">Revenue</Th>
              <Th align="right">Orders</Th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 36).map((r, i) => (
              <tr key={i} style={{ borderBottom: "1px solid var(--dark-sand)" }}>
                <Td>{r.plan_tier}</Td>
                <Td mono>{new Date(r.month).toISOString().slice(0, 7)}</Td>
                <Td align="right" mono>
                  ${Number(r.revenue).toLocaleString()}
                </Td>
                <Td align="right" mono>
                  {Number(r.orders).toLocaleString()}
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}

function Th({ children, align }: { children: React.ReactNode; align?: "right" }) {
  return (
    <th
      style={{
        padding: "10px 14px",
        textAlign: align ?? "left",
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        textTransform: "uppercase",
        letterSpacing: "0.06em",
        color: "var(--darker-grey)",
        fontWeight: 600,
      }}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  align,
  mono,
}: {
  children: React.ReactNode;
  align?: "right";
  mono?: boolean;
}) {
  return (
    <td
      style={{
        padding: "9px 14px",
        textAlign: align ?? "left",
        fontFamily: mono ? "var(--font-mono)" : undefined,
        fontVariantNumeric: align === "right" ? "tabular-nums" : undefined,
        color: "var(--ink)",
      }}
    >
      {children}
    </td>
  );
}
