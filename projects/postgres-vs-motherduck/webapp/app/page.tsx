"use client";

/**
 * The demo's money shot: the SAME query, rendered as a chart from BOTH engines
 * side by side. Each panel fetches its own engine independently (/api/chart),
 * so you watch Postgres grind while MotherDuck has already drawn its chart.
 *
 * Hit "Run comparison" to fire both at once. A live timer ticks up while each
 * engine is working, then freezes at the server-measured query latency.
 */
import { useCallback, useEffect, useState } from "react";
import { PLATFORM_MONTHLY_REVENUE } from "@/lib/queries";

type Point = { month: string; revenue: number };
type Result = { ms: number; rowCount: number; points: Point[] };

const ENGINES = [
  {
    source: "postgres",
    label: "Postgres",
    color: "#336791",
    note: "your managed Postgres",
    logo: "/postgres.svg",
    wordmark: false, // icon only — pair it with the text label
  },
  {
    source: "motherduck",
    label: "MotherDuck",
    color: "#f7b733",
    note: "Postgres wire endpoint",
    logo: "/motherduck.svg",
    wordmark: true, // the SVG already contains the "MotherDuck" wordmark
  },
] as const;

export default function ComparePage() {
  const [runId, setRunId] = useState(0);

  return (
    <main style={{ padding: 24, maxWidth: 1100, margin: "0 auto" }}>
      <h1 style={{ marginBottom: 4 }}>Same query. Two engines.</h1>
      <p style={{ color: "#666", marginTop: 0 }}>
        Monthly paid revenue — a full scan of ~39M order-items joined to orders. Identical SQL,
        identical <code>pg</code> driver; only the connection host differs.
      </p>

      <details open style={{ marginBottom: 20 }}>
        <summary style={{ cursor: "pointer", color: "#666", fontSize: 13, marginBottom: 8 }}>
          The query — run verbatim against both engines
        </summary>
        <pre
          style={{
            margin: 0,
            padding: "14px 16px",
            background: "#1a1a1a",
            color: "#e6e6e6",
            borderRadius: 8,
            fontSize: 12.5,
            lineHeight: 1.5,
            overflowX: "auto",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          }}
        >
          <code>{PLATFORM_MONTHLY_REVENUE.trim()}</code>
        </pre>
      </details>

      <button
        onClick={() => setRunId((n) => n + 1)}
        style={{
          padding: "10px 18px",
          fontSize: 15,
          fontWeight: 600,
          border: "none",
          borderRadius: 8,
          background: "#1a1a1a",
          color: "#fff",
          cursor: "pointer",
          marginBottom: 20,
        }}
      >
        {runId === 0 ? "Run comparison" : "Run again"}
      </button>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
        {ENGINES.map((e) => (
          <EnginePanel key={e.source} engine={e} runId={runId} />
        ))}
      </div>

      <AboutTheDataset />
      <HowTheConnectionWorks />
    </main>
  );
}

// Real row counts for the synthetic multi-shop commerce dataset (from the source Postgres).
const DATASET = [
  { table: "shops", rows: "500", kind: "dimension", desc: "tenants, each on a plan tier" },
  { table: "categories", rows: "12", kind: "dimension", desc: "product categories" },
  { table: "products", rows: "50,000", kind: "dimension", desc: "catalog across all shops" },
  { table: "customers", rows: "500,000", kind: "dimension", desc: "buyers" },
  { table: "orders", rows: "20,000,000", kind: "fact", desc: "one row per placed order" },
  { table: "order_items", rows: "39,382,720", kind: "fact", desc: "line items — the heavy grain" },
];

function AboutTheDataset() {
  return (
    <section style={{ marginTop: 32 }}>
      <h2 style={{ fontSize: 18, marginBottom: 6 }}>About the dataset</h2>
      <p style={{ color: "#666", marginTop: 0, fontSize: 14 }}>
        A synthetic multi-shop commerce platform — shops (tenants) on plan tiers, their catalog,
        and ~40M order line-items. The revenue query above is a full scan of <code>order_items</code>{" "}
        joined up to <code>orders</code> and <code>shops</code> — exactly the kind of analytical
        aggregate that row-store Postgres labors over and a columnar engine eats for breakfast.
      </p>
      <table cellPadding={6} style={{ borderCollapse: "collapse", width: "100%", fontSize: 13 }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "1px solid #ddd", color: "#888" }}>
            <th>Table</th>
            <th>Kind</th>
            <th style={{ textAlign: "right" }}>Rows</th>
            <th>What it is</th>
          </tr>
        </thead>
        <tbody>
          {DATASET.map((t) => (
            <tr key={t.table} style={{ borderBottom: "1px solid #f3f3f3" }}>
              <td style={{ fontFamily: "ui-monospace, Menlo, monospace" }}>{t.table}</td>
              <td style={{ color: "#999" }}>{t.kind}</td>
              <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{t.rows}</td>
              <td style={{ color: "#666" }}>{t.desc}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function HowTheConnectionWorks() {
  const cardStyle: React.CSSProperties = {
    border: "1px solid #eee",
    borderRadius: 10,
    padding: 16,
    fontSize: 12.5,
    lineHeight: 1.55,
  };
  const codeStyle: React.CSSProperties = {
    margin: "8px 0 0",
    padding: "12px 14px",
    background: "#1a1a1a",
    color: "#e6e6e6",
    borderRadius: 8,
    overflowX: "auto",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: 12,
    lineHeight: 1.5,
  };
  return (
    <section style={{ marginTop: 32 }}>
      <h2 style={{ fontSize: 18, marginBottom: 6 }}>How the connection works</h2>
      <p style={{ color: "#666", marginTop: 0, fontSize: 14 }}>
        Both engines are reached through the <strong>same Node <code>pg</code> driver</strong>.
        MotherDuck speaks the Postgres wire protocol, so &ldquo;switching to MotherDuck&rdquo; is
        just a different host + credentials — no DuckDB native extension, no SQL rewrite, no driver
        change. That&rsquo;s why this runs fine in a serverless function.
      </p>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <div style={cardStyle}>
          <strong style={{ color: "#336791" }}>Postgres</strong> — standard connection string
          <pre style={codeStyle}>
            <code>{`new Pool({
  connectionString: POSTGRES_URL,
  ssl: { rejectUnauthorized: false },
})`}</code>
          </pre>
        </div>
        <div style={cardStyle}>
          <strong style={{ color: "#c98a00" }}>MotherDuck</strong> — its Postgres wire endpoint
          <pre style={codeStyle}>
            <code>{`new Pool({
  host: "pg.us-east-1-aws.motherduck.com",
  port: 5432,
  user: "motherduck",        // any non-empty user
  password: MOTHERDUCK_TOKEN, // the token is the credential
  database: "multishop_commerce",
  ssl: { rejectUnauthorized: false },
})`}</code>
          </pre>
        </div>
      </div>
      <p style={{ color: "#999", fontSize: 12.5, marginBottom: 0 }}>
        Defined once in <code>lib/db.ts</code> — <code>DATA_SOURCE</code> (or the{" "}
        <code>?source=</code> param) picks which pool answers. Same query text either way.
      </p>
    </section>
  );
}

function EnginePanel({
  engine,
  runId,
}: {
  engine: (typeof ENGINES)[number];
  runId: number;
}) {
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);

  const run = useCallback(async () => {
    setState("loading");
    setResult(null);
    setError(null);
    setElapsed(0);
    const startedAt = performance.now();
    const timer = setInterval(() => setElapsed(performance.now() - startedAt), 50);
    try {
      const res = await fetch(`/api/chart?source=${engine.source}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setResult(data as Result);
      setState("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setState("error");
    } finally {
      clearInterval(timer);
    }
  }, [engine.source]);

  // Re-run whenever the user clicks "Run comparison".
  useEffect(() => {
    if (runId > 0) run();
  }, [runId, run]);

  return (
    <section
      style={{
        border: "1px solid #eee",
        borderRadius: 12,
        padding: 18,
        minHeight: 320,
        boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
      }}
    >
      <header style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={engine.logo}
          alt={engine.label}
          height={24}
          style={{ height: 24, width: "auto", display: "block" }}
        />
        {!engine.wordmark && <strong>{engine.label}</strong>}
        <span style={{ color: "#999", fontSize: 12 }}>· {engine.note}</span>
        <span style={{ marginLeft: "auto", fontVariantNumeric: "tabular-nums" }}>
          {state === "loading" && (
            <span style={{ color: engine.color }}>{(elapsed / 1000).toFixed(1)}s…</span>
          )}
          {state === "done" && result && (
            <span style={{ fontWeight: 700, color: engine.color }}>
              {result.ms < 1000 ? `${result.ms} ms` : `${(result.ms / 1000).toFixed(2)} s`}
            </span>
          )}
        </span>
      </header>

      {state === "idle" && (
        <Placeholder text="Press “Run comparison” to query this engine." />
      )}
      {state === "loading" && <Placeholder text="Querying…" pulse color={engine.color} />}
      {state === "error" && (
        <Placeholder text={`Error: ${error}`} color="#c0392b" />
      )}
      {state === "done" && result && <BarChart points={result.points} color={engine.color} />}

      {state === "done" && result && (
        <p style={{ color: "#999", fontSize: 12, marginBottom: 0 }}>
          {result.rowCount.toLocaleString()} rows aggregated to {result.points.length} months
        </p>
      )}
    </section>
  );
}

function Placeholder({
  text,
  pulse,
  color = "#bbb",
}: {
  text: string;
  pulse?: boolean;
  color?: string;
}) {
  return (
    <div
      style={{
        height: 220,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color,
        fontSize: 14,
        border: "1px dashed #eee",
        borderRadius: 8,
        animation: pulse ? "pulse 1.2s ease-in-out infinite" : undefined,
      }}
    >
      {text}
      <style>{`@keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: 0.45 } }`}</style>
    </div>
  );
}

const fmtMoney = (n: number) =>
  n >= 1e9
    ? `$${(n / 1e9).toFixed(1)}B`
    : n >= 1e6
      ? `$${(n / 1e6).toFixed(1)}M`
      : n >= 1e3
        ? `$${(n / 1e3).toFixed(0)}k`
        : `$${n.toFixed(0)}`;

/** Dependency-free SVG bar chart of paid revenue by month. */
function BarChart({ points, color }: { points: Point[]; color: string }) {
  const W = 520;
  const H = 240;
  const PAD = { top: 16, right: 12, bottom: 26, left: 46 };
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const baseY = PAD.top + innerH;
  const max = Math.max(1, ...points.map((p) => p.revenue));
  const bw = innerW / Math.max(1, points.length);
  const gradId = `g-${color.replace("#", "")}`;
  const ticks = [0, 0.25, 0.5, 0.75, 1]; // horizontal gridlines
  const labelStep = Math.ceil(points.length / 8); // keep the x-axis readable

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label="Revenue by month">
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.95} />
          <stop offset="100%" stopColor={color} stopOpacity={0.55} />
        </linearGradient>
      </defs>

      {/* gridlines + $ axis labels */}
      {ticks.map((t) => {
        const y = baseY - t * innerH;
        return (
          <g key={t}>
            <line x1={PAD.left} y1={y} x2={W - PAD.right} y2={y} stroke="#f0f0f0" strokeWidth={1} />
            <text x={PAD.left - 6} y={y + 3} fontSize={9} fill="#aaa" textAnchor="end">
              {fmtMoney(max * t)}
            </text>
          </g>
        );
      })}

      {/* bars */}
      {points.map((p, i) => {
        const h = (p.revenue / max) * innerH;
        const x = PAD.left + i * bw;
        const y = baseY - h;
        return (
          <g key={p.month}>
            <rect x={x + 1} y={y} width={Math.max(1, bw - 2)} height={h} fill={`url(#${gradId})`} rx={1.5}>
              <title>{`${p.month}: ${fmtMoney(p.revenue)}`}</title>
            </rect>
            {i % labelStep === 0 && (
              <text x={x + bw / 2} y={H - 8} fontSize={9} fill="#999" textAnchor="middle">
                {p.month.slice(2)}
              </text>
            )}
          </g>
        );
      })}

      {/* baseline */}
      <line x1={PAD.left} y1={baseY} x2={W - PAD.right} y2={baseY} stroke="#ddd" strokeWidth={1} />
    </svg>
  );
}
