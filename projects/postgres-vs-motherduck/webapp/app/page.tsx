"use client";

/**
 * The demo's money shot: the SAME query, rendered as a chart from BOTH engines
 * side by side. Each panel fetches its own engine independently (/api/chart),
 * so you watch Postgres grind while MotherDuck has already drawn its chart.
 *
 * Hit "Run comparison" to fire both at once. A live timer ticks up while each
 * engine is working, then freezes at the server-measured query latency.
 *
 * Styled to MotherDuck's design language: sand canvas, #383838 ink, sharp 2px
 * borders, hard offset shadows, uppercase mono headings, sky/sun/duck accents.
 */
import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { PLATFORM_MONTHLY_REVENUE } from "@/lib/queries";

type Point = { month: string; revenue: number };
type Result = { ms: number; rowCount: number; points: Point[] };
type EngineState = "idle" | "loading" | "done" | "error";

const ENGINES = [
  {
    source: "postgres",
    label: "Postgres",
    color: "#336791", // postgres brand blue
    note: "your managed Postgres",
    logo: "/postgres.svg",
    wordmark: false, // icon only — pair it with the text label
  },
  {
    source: "motherduck",
    label: "MotherDuck",
    color: "#ff9538", // duck orange
    note: "Postgres wire endpoint",
    logo: "/motherduck.svg",
    wordmark: true, // the SVG already contains the "MotherDuck" wordmark
  },
] as const;

// Sections, in order — drives both the anchors and the left "on this page" nav.
const SECTIONS = [
  { id: "compare", label: "The comparison" },
  { id: "dataset", label: "About the dataset" },
  { id: "connection", label: "How it connects" },
  { id: "clients", label: "Ways to connect" },
] as const;

// Source lives in the MotherDuck Labs monorepo — link straight to this project's folder.
const GITHUB_URL = "https://github.com/motherduckdb/labs/tree/main/projects/postgres-vs-motherduck";
const SEED_URL =
  "https://github.com/motherduckdb/labs/blob/main/projects/postgres-vs-motherduck/pipeline/seed_postgres.py";

// Relevant MotherDuck docs, linked inline where each topic shows up.
const DOCS = {
  pgEndpoint:
    "https://motherduck.com/docs/key-tasks/authenticating-and-connecting-to-motherduck/postgres-endpoint",
  nodejs: "https://motherduck.com/docs/integrations/language-apis-and-drivers/node-js",
  wasm: "https://motherduck.com/docs/sql-reference/wasm-client",
};

// ── Minimal, dependency-free syntax highlighting for the on-page code ──────────
const TOKEN = {
  comment: "#8a948c",
  string: "#8ee6c8",
  number: "#f6c177",
  keyword: "#6fc2ff",
  func: "#ffb86b",
};
const SQL_KEYWORDS = new Set([
  "select",
  "from",
  "join",
  "left",
  "right",
  "inner",
  "outer",
  "full",
  "on",
  "where",
  "group",
  "by",
  "order",
  "as",
  "and",
  "or",
  "not",
  "in",
  "is",
  "null",
  "distinct",
  "case",
  "when",
  "then",
  "else",
  "end",
  "limit",
  "offset",
  "having",
  "union",
  "all",
  "interval",
  "asc",
  "desc",
  "using",
  "with",
  "between",
  "like",
]);
const SQL_FUNCS = new Set([
  "sum",
  "count",
  "avg",
  "min",
  "max",
  "date_trunc",
  "now",
  "coalesce",
  "cast",
  "round",
]);
const JS_KEYWORDS = new Set([
  "import",
  "from",
  "const",
  "let",
  "var",
  "await",
  "async",
  "new",
  "return",
  "function",
  "export",
  "default",
  "true",
  "false",
  "null",
  "of",
  "in",
  "class",
  "extends",
  "try",
  "catch",
  "if",
  "else",
  "for",
  "while",
  "typeof",
]);

function tokenize(code: string, lang: "sql" | "js"): ReactNode[] {
  const re =
    lang === "sql"
      ? /(--[^\n]*)|('(?:[^']|'')*')|(\d+(?:\.\d+)?)|([A-Za-z_]\w*)|(\s+|[^\sA-Za-z0-9_]+)/g
      : /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\d+(?:\.\d+)?)|([A-Za-z_$][\w$]*)|(\s+|[^\sA-Za-z0-9_$]+)/g;
  const kw = lang === "sql" ? SQL_KEYWORDS : JS_KEYWORDS;
  const fns = lang === "sql" ? SQL_FUNCS : null;
  const out: ReactNode[] = [];
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(code)) !== null) {
    const [text, comment, str, num, word] = m;
    let color: string | undefined;
    let italic = false;
    let bold = false;
    if (comment) {
      color = TOKEN.comment;
      italic = true;
    } else if (str) {
      color = TOKEN.string;
    } else if (num) {
      color = TOKEN.number;
    } else if (word) {
      const lw = word.toLowerCase();
      if (kw.has(lw)) {
        color = TOKEN.keyword;
        bold = true;
      } else if (fns?.has(lw)) {
        color = TOKEN.func;
      }
    }
    out.push(
      color ? (
        <span
          key={i}
          style={{
            color,
            fontStyle: italic ? "italic" : undefined,
            fontWeight: bold ? 600 : undefined,
          }}
        >
          {text}
        </span>
      ) : (
        <span key={i}>{text}</span>
      ),
    );
    i++;
  }
  return out;
}

function CodeBlock({
  code,
  lang,
  style,
}: {
  code: string;
  lang: "sql" | "js";
  style?: CSSProperties;
}) {
  return (
    <pre className="md-code" style={style}>
      <code>{tokenize(code, lang)}</code>
    </pre>
  );
}

function GitHubMark() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

export default function ComparePage() {
  const [runId, setRunId] = useState(0);
  // Lifted per-engine state so the connector lanes know which side is "running".
  const [states, setStates] = useState<Record<string, EngineState>>({
    postgres: "idle",
    motherduck: "idle",
  });
  const report = useCallback((source: string, s: EngineState) => {
    setStates((prev) => (prev[source] === s ? prev : { ...prev, [source]: s }));
  }, []);

  return (
    <div className="md-layout">
      <TocSidebar />
      <main className="md-main">
        <section id="compare">
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "flex-start",
              gap: 16,
              flexWrap: "wrap",
            }}
          >
            <div>
              <p className="md-eyebrow" style={{ margin: "0 0 8px" }}>
                MotherDuck Labs · experiment
              </p>
              <h1 style={{ marginBottom: 0 }}>Postgres vs MotherDuck</h1>
            </div>
            <a className="md-source" href={GITHUB_URL} target="_blank" rel="noreferrer">
              <GitHubMark /> View source
            </a>
          </div>

          {/* Subtitle: what the experiment is, in plain terms. */}
          <p
            style={{
              fontSize: 17,
              lineHeight: 1.5,
              color: "var(--ink)",
              maxWidth: 720,
              marginTop: 16,
            }}
          >
            Is the same analytics query really faster on <strong>MotherDuck</strong> than on{" "}
            <strong>Postgres</strong>? This experiment runs the <em>exact same SQL</em> against both
            engines, live in your browser — so you can measure the gap yourself.
          </p>
          {/* More info: the technical detail, demoted. */}
          <p
            style={{
              color: "var(--darker-grey)",
              marginTop: 0,
              maxWidth: 720,
              lineHeight: 1.55,
              fontSize: 14,
            }}
          >
            Under the hood it's a full scan of ~3.9M order-items joined to orders, through the same{" "}
            <code>pg</code> driver — only the connection host changes. Hit <em>Run comparison</em>{" "}
            and watch Postgres grind while MotherDuck has already drawn its chart.
          </p>

          <details open style={{ marginBottom: 22 }}>
            <summary className="md-eyebrow" style={{ cursor: "pointer", marginBottom: 10 }}>
              The query — run verbatim against both engines
            </summary>
            <CodeBlock code={PLATFORM_MONTHLY_REVENUE.trim()} lang="sql" />
          </details>

          <div style={{ display: "flex", justifyContent: "center" }}>
            <button className="md-btn" onClick={() => setRunId((n) => n + 1)}>
              {runId === 0 ? "Run comparison" : "Run again"}
            </button>
          </div>

          {/* Dashed lanes flow from the button down into whichever engine is running. */}
          <RunLanes states={states} />

          <div className="md-cols2" style={{ gap: 20 }}>
            {ENGINES.map((e) => (
              <EnginePanel key={e.source} engine={e} runId={runId} onState={report} />
            ))}
          </div>

          {/* Transparency: the Postgres side is properly indexed — head off the
              "you didn't index Postgres" objection. */}
          <div className="md-note">
            <p>
              <strong style={{ color: "var(--ink)" }}>Fair comparison.</strong> Both engines run the
              identical SQL, and the Postgres side is <strong>indexed</strong> on its primary and
              foreign keys — <code>orders(order_id, shop_id, status, ordered_at)</code>,{" "}
              <code>order_items(order_id, shop_id, product_id)</code>, and every table&rsquo;s PK —
              so it&rsquo;s row-store vs columnar, not Postgres without indexes (
              <a href={SEED_URL} target="_blank" rel="noreferrer">
                seed script
              </a>
              ).
            </p>
            <p>
              <strong style={{ color: "var(--ink)" }}>Comparable compute.</strong> Postgres runs on
              a standard managed instance — <strong>0.5 vCPU · 4 GB RAM · 10 GB storage</strong>,
              single node. MotherDuck runs on a single <strong>Standard</strong> Duckling — its
              default, production-grade compute tier. Roughly standard compute on both sides — the
              &ldquo;after&rdquo; isn&rsquo;t an oversized warehouse.
            </p>
          </div>
        </section>

        <AboutTheDataset />
        <HowTheConnectionWorks />
        <OtherWaysToConnect />

        <footer className="md-footer">
          <a href={GITHUB_URL} target="_blank" rel="noreferrer">
            <GitHubMark /> Source on GitHub
          </a>
          <span style={{ color: "var(--grey)" }}>Part of MotherDuck Labs · experimental</span>
        </footer>
      </main>
    </div>
  );
}

// Connector lanes: each runs from the centered button (x=50) down to a card center
// (Postgres ≈ 25%, MotherDuck ≈ 75%) and animates while that engine is loading.
const LANES = [
  { source: "postgres", x: 25, color: "#336791" },
  { source: "motherduck", x: 75, color: "#ff9538" },
] as const;

function RunLanes({ states }: { states: Record<string, EngineState> }) {
  return (
    <svg
      className="md-run-lanes"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      width="100%"
      height={52}
      aria-hidden
      style={{ display: "block", margin: "2px 0" }}
    >
      {LANES.map((l) => {
        const loading = states[l.source] === "loading";
        return (
          <path
            key={l.source}
            d={`M50,0 C50,50 ${l.x},50 ${l.x},100`}
            fill="none"
            stroke={loading ? l.color : "var(--dark-sand)"}
            strokeWidth={2}
            strokeDasharray="6 6"
            vectorEffect="non-scaling-stroke"
            className={loading ? "lane-flow" : undefined}
            style={{ opacity: loading ? 1 : 0.4 }}
          />
        );
      })}
    </svg>
  );
}

// Left "navigation doc" — sticky anchors with scroll-spy highlighting the
// section currently in view (collapses under 900px via CSS).
function TocSidebar() {
  const [active, setActive] = useState<string>(SECTIONS[0].id);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setActive(entry.target.id);
        }
      },
      { rootMargin: "-15% 0px -75% 0px", threshold: 0 },
    );
    for (const s of SECTIONS) {
      const el = document.getElementById(s.id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, []);

  return (
    <aside className="md-toc">
      <p className="md-eyebrow" style={{ margin: "0 0 12px" }}>
        On this page
      </p>
      <nav>
        {SECTIONS.map((s) => (
          <a key={s.id} href={`#${s.id}`} className={active === s.id ? "active" : undefined}>
            {s.label}
          </a>
        ))}
      </nav>
    </aside>
  );
}

// Real row counts for the synthetic multi-shop commerce dataset (from the source Postgres).
const DATASET = [
  { table: "shops", rows: "500", kind: "dimension", desc: "tenants, each on a plan tier" },
  { table: "categories", rows: "12", kind: "dimension", desc: "product categories" },
  { table: "products", rows: "50,000", kind: "dimension", desc: "catalog across all shops" },
  { table: "customers", rows: "500,000", kind: "dimension", desc: "buyers" },
  { table: "orders", rows: "2,000,000", kind: "fact", desc: "one row per placed order" },
  { table: "order_items", rows: "3,938,272", kind: "fact", desc: "line items — the heavy grain" },
];

function AboutTheDataset() {
  return (
    <section id="dataset" style={{ marginTop: 40 }}>
      <h2>About the dataset</h2>
      <p style={{ color: "var(--darker-grey)", marginTop: 0, fontSize: 14, lineHeight: 1.55 }}>
        A synthetic multi-shop commerce platform — shops (tenants) on plan tiers, their catalog, and
        ~3.9M order line-items. The revenue query above is a full scan of <code>order_items</code>{" "}
        joined up to <code>orders</code> and <code>shops</code> — exactly the kind of analytical
        aggregate that row-store Postgres labors over and a columnar engine eats for breakfast.
      </p>
      <div className="md-card" style={{ overflowX: "auto", marginTop: 14 }}>
        <table cellPadding={0} style={{ borderCollapse: "collapse", width: "100%", fontSize: 13 }}>
          <thead>
            <tr
              style={{
                textAlign: "left",
                background: "var(--sand)",
                borderBottom: "2px solid var(--ink)",
              }}
            >
              <Th>Table</Th>
              <Th>Kind</Th>
              <Th align="right">Rows</Th>
              <Th>What it is</Th>
            </tr>
          </thead>
          <tbody>
            {DATASET.map((t) => (
              <tr key={t.table} style={{ borderBottom: "1px solid var(--dark-sand)" }}>
                <Td mono>{t.table}</Td>
                <Td>
                  <span
                    style={{ color: t.kind === "fact" ? "var(--dark-sky)" : "var(--darker-grey)" }}
                  >
                    {t.kind}
                  </span>
                </Td>
                <Td align="right" mono>
                  {t.rows}
                </Td>
                <Td muted>{t.desc}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
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
  muted,
}: {
  children: React.ReactNode;
  align?: "right";
  mono?: boolean;
  muted?: boolean;
}) {
  return (
    <td
      style={{
        padding: "9px 14px",
        textAlign: align ?? "left",
        fontFamily: mono ? "var(--font-mono)" : undefined,
        fontVariantNumeric: align === "right" ? "tabular-nums" : undefined,
        color: muted ? "var(--darker-grey)" : "var(--ink)",
      }}
    >
      {children}
    </td>
  );
}

function HowTheConnectionWorks() {
  return (
    <section id="connection" style={{ marginTop: 40 }}>
      <h2>How the connection works</h2>
      <p style={{ color: "var(--darker-grey)", marginTop: 0, fontSize: 14, lineHeight: 1.55 }}>
        Both engines are reached through the{" "}
        <strong>
          same Node <code>pg</code> driver
        </strong>
        . MotherDuck speaks the Postgres wire protocol, so &ldquo;switching to MotherDuck&rdquo; is
        just a different host + credentials — no DuckDB native extension, no SQL rewrite, no driver
        change. That&rsquo;s why this runs fine in a serverless function.
      </p>
      <div className="md-cols2" style={{ gap: 16, marginTop: 14 }}>
        <div className="md-card" style={{ padding: 16 }}>
          <strong style={{ color: "var(--postgres)" }}>Postgres</strong>
          <span style={{ color: "var(--darker-grey)", fontSize: 12.5 }}>
            {" "}
            — standard connection string
          </span>
          <CodeBlock
            lang="js"
            style={{ marginTop: 10, fontSize: 12 }}
            code={`new Pool({
  connectionString: POSTGRES_URL,
  ssl: { rejectUnauthorized: false },
})`}
          />
        </div>
        <div className="md-card" style={{ padding: 16 }}>
          <strong style={{ color: "var(--darker-duck)" }}>MotherDuck</strong>
          <span style={{ color: "var(--darker-grey)", fontSize: 12.5 }}>
            {" "}
            — its Postgres wire endpoint
          </span>
          <CodeBlock
            lang="js"
            style={{ marginTop: 10, fontSize: 12 }}
            code={`new Pool({
  host: "pg.us-east-1-aws.motherduck.com",
  port: 5432,
  user: "motherduck",        // any non-empty user
  password: MOTHERDUCK_TOKEN, // the token is the credential
  database: "multishop_commerce",
  ssl: { rejectUnauthorized: false },
})`}
          />
        </div>
      </div>
      <p style={{ color: "var(--grey)", fontSize: 12.5, marginBottom: 0, marginTop: 14 }}>
        Defined once in <code>lib/db.ts</code> — the <code>?source=</code> param picks which pool
        answers. Same query text either way.
      </p>
      <p style={{ marginTop: 12, marginBottom: 0 }}>
        <a className="md-doclink" href={DOCS.pgEndpoint} target="_blank" rel="noreferrer">
          MotherDuck Postgres wire endpoint docs ↗
        </a>
      </p>
    </section>
  );
}

// The three first-party ways to query MotherDuck from JS/TS. This app uses the
// first (Postgres wire) precisely because it needs zero new deps and runs in a
// serverless function — but the native and Wasm clients buy you more.
const CONNECTION_OPTIONS = [
  {
    name: "Postgres wire",
    pkg: "pg",
    accent: "var(--dark-sky)",
    thisApp: true,
    blurb: "MotherDuck's Postgres-protocol endpoint, via the standard node-postgres driver.",
    code: `import { Pool } from "pg";

const pool = new Pool({
  host: "pg.us-east-1-aws.motherduck.com",
  user: "motherduck",         // any non-empty user
  password: MOTHERDUCK_TOKEN, // token is the credential
  database: "multishop_commerce",
  ssl: { rejectUnauthorized: false },
});
const { rows } = await pool.query("SELECT 1");`,
    pros: [
      "Zero new deps if you already use Postgres",
      "Pure JS — runs in any serverless / Node runtime",
      "Drop-in for an existing PG app: just swap the host",
    ],
    cons: "Goes through the Postgres-protocol surface — a subset of DuckDB SQL and PG type coercion; no local-file ATTACH.",
    docs: DOCS.pgEndpoint,
  },
  {
    name: "DuckDB Node.js",
    pkg: "@duckdb/node-api",
    accent: "var(--darker-duck)",
    thisApp: false,
    blurb: "The native DuckDB engine in-process, connected to MotherDuck with an md: string.",
    code: `import duckdb from "@duckdb/node-api";

const instance = await duckdb.DuckDBInstance.create(
  \`md:multishop_commerce?motherduck_token=\${MOTHERDUCK_TOKEN}\`
);
const connection = await instance.connect();
const result = await connection.run("SELECT 1");`,
    pros: [
      "Full native DuckDB SQL + extensions",
      "ATTACH local files / Parquet alongside MotherDuck",
      "Arrow-native results; hybrid local+cloud execution",
    ],
    cons: "Native addon — platform-specific binary, larger bundle, heavier cold starts; not edge-runtime compatible.",
    docs: DOCS.nodejs,
  },
  {
    name: "MotherDuck Wasm",
    pkg: "@motherduck/wasm-client",
    accent: "var(--garden)",
    thisApp: false,
    blurb: "DuckDB-Wasm in the browser — query MotherDuck straight from the client.",
    code: `import { MDConnection } from "@motherduck/wasm-client";

const connection = MDConnection.create({
  mdToken: READ_SCALING_TOKEN, // reaches the browser!
});
await connection.isInitialized();
const result = await connection.evaluateQuery("SELECT 1");`,
    pros: [
      "Queries run in the browser — no server round-trip",
      "Hybrid execution: local Wasm + cloud compute",
      "Great for interactive dashboards & per-user drill-downs",
    ],
    cons: "The token reaches the client — use a read-scaling / short-lived token, never your main one. Plus Wasm bundle + browser memory limits.",
    docs: DOCS.wasm,
  },
] as const;

function OtherWaysToConnect() {
  return (
    <section id="clients" style={{ marginTop: 40 }}>
      <h2>Three ways to query MotherDuck from JS/TS</h2>
      <p
        style={{
          color: "var(--darker-grey)",
          marginTop: 0,
          fontSize: 14,
          lineHeight: 1.55,
          maxWidth: 760,
        }}
      >
        This demo uses the <strong>Postgres wire</strong> path because it drops into an existing
        Postgres app with no new dependencies and runs in a serverless function. When you want the
        full native engine or browser-side compute, reach for one of the other two.
      </p>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 280px), 1fr))",
          gap: 16,
          marginTop: 14,
        }}
      >
        {CONNECTION_OPTIONS.map((opt) => (
          <div
            key={opt.name}
            className="md-card"
            style={{ padding: 16, display: "flex", flexDirection: "column" }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
              <strong
                style={{
                  fontFamily: "var(--font-mono)",
                  textTransform: "uppercase",
                  fontSize: 14,
                  color: opt.accent,
                }}
              >
                {opt.name}
              </strong>
              {opt.thisApp && (
                <span
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 9,
                    textTransform: "uppercase",
                    letterSpacing: "0.06em",
                    background: "var(--sun)",
                    border: "2px solid var(--ink)",
                    borderRadius: "var(--radius)",
                    padding: "1px 6px",
                  }}
                >
                  This app
                </span>
              )}
            </div>
            <code style={{ fontSize: 11, color: "var(--darker-grey)" }}>{opt.pkg}</code>
            <p
              style={{
                fontSize: 12.5,
                color: "var(--darker-grey)",
                lineHeight: 1.5,
                margin: "8px 0 0",
              }}
            >
              {opt.blurb}
            </p>
            <CodeBlock
              lang="js"
              style={{ marginTop: 10, fontSize: 11, flexGrow: 1 }}
              code={opt.code}
            />
            <ul style={{ listStyle: "none", padding: 0, margin: "12px 0 0" }}>
              {opt.pros.map((p) => (
                <li
                  key={p}
                  style={{
                    fontSize: 12,
                    color: "var(--ink)",
                    lineHeight: 1.45,
                    paddingLeft: 18,
                    position: "relative",
                    marginBottom: 4,
                  }}
                >
                  <span
                    style={{ position: "absolute", left: 0, color: opt.accent, fontWeight: 700 }}
                  >
                    +
                  </span>
                  {p}
                </li>
              ))}
            </ul>
            <p
              style={{
                fontSize: 11.5,
                color: "var(--darker-grey)",
                lineHeight: 1.45,
                margin: "10px 0 0",
                paddingTop: 10,
                borderTop: "1px solid var(--dark-sand)",
              }}
            >
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  textTransform: "uppercase",
                  fontSize: 10,
                  letterSpacing: "0.06em",
                  color: "var(--watermelon)",
                }}
              >
                Trade-off ·{" "}
              </span>
              {opt.cons}
            </p>
            <a
              className="md-doclink"
              href={opt.docs}
              target="_blank"
              rel="noreferrer"
              style={{ display: "inline-block", marginTop: 10 }}
            >
              MotherDuck docs ↗
            </a>
          </div>
        ))}
      </div>
      <p style={{ color: "var(--grey)", fontSize: 12, marginBottom: 0, marginTop: 14 }}>
        All three authenticate with the same MotherDuck access token. For the Wasm path, mint a{" "}
        <strong>read-scaling token</strong> server-side so your primary token never ships to the
        browser.
      </p>
    </section>
  );
}

function EnginePanel({
  engine,
  runId,
  onState,
}: {
  engine: (typeof ENGINES)[number];
  runId: number;
  onState: (source: string, s: EngineState) => void;
}) {
  const [state, setState] = useState<EngineState>("idle");
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

  // Report state up so the connector lanes can animate the running engine.
  useEffect(() => {
    onState(engine.source, state);
  }, [state, engine.source, onState]);

  return (
    <section className="md-card" style={{ padding: 18, minHeight: 320 }}>
      <header style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={engine.logo}
          alt={engine.label}
          height={24}
          style={{ height: 24, width: "auto", display: "block" }}
        />
        {!engine.wordmark && (
          <strong
            style={{ fontFamily: "var(--font-mono)", textTransform: "uppercase", fontSize: 14 }}
          >
            {engine.label}
          </strong>
        )}
        <span style={{ color: "var(--grey)", fontSize: 12 }}>· {engine.note}</span>
        <span style={{ marginLeft: "auto", fontVariantNumeric: "tabular-nums" }}>
          {state === "loading" && (
            <span style={{ color: engine.color, fontFamily: "var(--font-mono)" }}>
              {(elapsed / 1000).toFixed(1)}s…
            </span>
          )}
          {state === "done" && result && (
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontWeight: 600,
                fontSize: 16,
                color: "var(--ink)",
                background: engine.color,
                padding: "3px 9px",
                borderRadius: "var(--radius)",
                border: "2px solid var(--ink)",
              }}
            >
              {result.ms < 1000 ? `${result.ms} ms` : `${(result.ms / 1000).toFixed(2)} s`}
            </span>
          )}
        </span>
      </header>

      {state === "idle" && <Placeholder text="Press “Run comparison” to query this engine." />}
      {state === "loading" && <Placeholder text="Querying…" pulse color={engine.color} />}
      {state === "error" && <Placeholder text={`Error: ${error}`} color="var(--watermelon)" />}
      {state === "done" && result && <BarChart points={result.points} color={engine.color} />}

      {state === "done" && result && (
        <p
          style={{
            color: "var(--grey)",
            fontSize: 12,
            marginBottom: 0,
            fontFamily: "var(--font-mono)",
          }}
        >
          {result.rowCount.toLocaleString()} rows aggregated to {result.points.length} months
        </p>
      )}
    </section>
  );
}

function Placeholder({
  text,
  pulse,
  color = "var(--light-grey)",
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
        fontSize: 13,
        fontFamily: "var(--font-mono)",
        textTransform: "uppercase",
        letterSpacing: "0.04em",
        background: "var(--snow)",
        border: "1px dashed var(--lighter-grey)",
        borderRadius: "var(--radius)",
        animation: pulse ? "pulse 1.2s ease-in-out infinite" : undefined,
        textAlign: "center",
        padding: "0 16px",
      }}
    >
      {text}
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
  const gradId = `g-${color.replace(/[^a-z0-9]/gi, "")}`;
  const ticks = [0, 0.25, 0.5, 0.75, 1]; // horizontal gridlines
  const labelStep = Math.ceil(points.length / 8); // keep the x-axis readable

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label="Revenue by month">
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={1} />
          <stop offset="100%" stopColor={color} stopOpacity={0.7} />
        </linearGradient>
      </defs>

      {/* gridlines + $ axis labels */}
      {ticks.map((t) => {
        const y = baseY - t * innerH;
        return (
          <g key={t}>
            <line x1={PAD.left} y1={y} x2={W - PAD.right} y2={y} stroke="#e1d6cb" strokeWidth={1} />
            <text x={PAD.left - 6} y={y + 3} fontSize={9} fill="#a1a1a1" textAnchor="end">
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
            <rect
              x={x + 1}
              y={y}
              width={Math.max(1, bw - 2)}
              height={h}
              fill={`url(#${gradId})`}
              stroke="#383838"
              strokeWidth={0.75}
            >
              <title>{`${p.month}: ${fmtMoney(p.revenue)}`}</title>
            </rect>
            {i % labelStep === 0 && (
              <text x={x + bw / 2} y={H - 8} fontSize={9} fill="#818181" textAnchor="middle">
                {p.month.slice(2)}
              </text>
            )}
          </g>
        );
      })}

      {/* baseline */}
      <line
        x1={PAD.left}
        y1={baseY}
        x2={W - PAD.right}
        y2={baseY}
        stroke="#383838"
        strokeWidth={1.5}
      />
    </svg>
  );
}
