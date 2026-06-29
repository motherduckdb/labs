/* lib — shared tokens + atoms for the "Malloy vs Context" dive.
   Tufte-inspired data-journalism: high data-ink, restrained palette (grays + two
   arm colors), serif prose, mono numerals, direct labels, reference lines, captions. */
import { useState } from "react";
import { Loader2 } from "lucide-react";

export const N = (v: unknown): number => (v != null ? Number(v) : 0);
export const rows = (d: unknown): any[] => (Array.isArray(d) ? d : []);
export const pct = (v: unknown) => `${N(v).toFixed(1)}%`;

export const STORY = `"agentic_malloy_story"."main"`;
export const LOGS = `"agentic_malloy_logs"."main"`;

// Ink: near-black text, two muted grays, hairline rule. Color is reserved for data.
export const INK = {
  text: "#222222", muted: "#6f6f6f", faint: "#9a9a9a",
  rule: "#e3e0d8", bg: "#f6f4ee", paper: "#ffffff", panel: "#fbfaf6",
};
// The only saturated inks: the two substrates, and the three answer paths.
export const ARM = { baseline: "#2d6a2d", malloy: "#0a6aa8" };
export const PATH = { sql: "#b0521f", malloy: "#0a6aa8", other: "#b8b4a8" };

export const SERIF = 'Georgia, "Iowan Old Style", Charter, "Palatino Linotype", Palatino, serif';
export const SANS = 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, sans-serif';
export const MONO = 'ui-monospace, SFMono-Regular, Menlo, Monaco, "Roboto Mono", Consolas, monospace';

// Shared run-label constants (used across tabs — defined once to avoid bundle collisions).
export const OFFICIAL = "Malloy · sonnet+opus · official";
export const PREFIX = "Malloy · sonnet+opus · official (pre-fix)";
export const CONTROLLED = "Malloy · gemini · controlled (low)";
// Shared <select> style.
export const sel: React.CSSProperties = { fontFamily: SANS, fontSize: 12.5, padding: "3px 8px", border: `1px solid ${INK.rule}`, borderRadius: 4, background: INK.paper, color: INK.text };

export const TABS = [
  { key: "story", label: "The story" },
  { key: "metrics", label: "Metrics & misses" },
  { key: "build", label: "Harness & prompts" },
  { key: "layer", label: "The layer" },
  { key: "traces", label: "Agent traces" },
];

/* Plain-language gloss for the run-label jargon — surfaced as hover tooltips. */
export function noteFor(label: string): string {
  if (label.includes("Baseline")) return "The tuned markdown+SQL context layer — the thing Malloy is measured against.";
  if (label.includes("pre-fix")) return "An earlier official run, before the skill fixes (answer-format rules + a clean SQL fallback) that raised it from 88.3% to 91.2%.";
  if (label.includes("controlled")) return "The clean same-model control: gemini on both arms, so only the substrate differs.";
  if (label.includes("new-harness")) return "Harness with a one-call view catalog, a SQL fallback, and deterministic linting. 'high' = more model reasoning.";
  if (label.includes("official")) return "The canonical config behind the claim: a mid-tier model authors, a stronger model fixes errors, on the model-authored layer, no in-place steering.";
  return "";
}

/* Inline glossed term: dotted underline + an instant styled popover (native title is
   unreliable — delayed, and flaky on SVG). */
export function Tip({ text, children }: { text: string; children: React.ReactNode }) {
  const [show, setShow] = useState(false);
  if (!text) return <>{children}</>;
  return (
    <span style={{ position: "relative", display: "inline-block", borderBottom: `1px dotted ${INK.faint}`, cursor: "help" }}
      onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}>
      {children}
      {show ? (
        <span style={{ position: "absolute", bottom: "135%", left: 0, zIndex: 60, width: 250, background: INK.text, color: "#fff",
          fontFamily: SANS, fontSize: 11.5, fontWeight: 400, fontStyle: "normal", lineHeight: 1.45, padding: "7px 10px",
          borderRadius: 6, boxShadow: "0 6px 18px rgba(0,0,0,0.2)", whiteSpace: "normal" }}>{text}</span>
      ) : null}
    </span>
  );
}

/* Editorial intro paragraph. */
export function Lede({ children }: { children: React.ReactNode }) {
  return <p style={{ fontFamily: SERIF, fontSize: 17, lineHeight: 1.55, color: INK.text, margin: "0 0 14px" }}>{children}</p>;
}

/* A figure wrapper with an italic caption beneath — the data-journalism unit. */
export function Figure({ children, caption }: { children: React.ReactNode; caption: React.ReactNode }) {
  return (
    <figure style={{ margin: "0 0 22px" }}>
      {children}
      <figcaption style={{ fontFamily: SERIF, fontStyle: "italic", fontSize: 12.5, color: INK.muted, marginTop: 7, lineHeight: 1.45 }}>{caption}</figcaption>
    </figure>
  );
}

/* A restrained KPI: big mono numeral, small label, optional sub. */
export function Stat({ value, label, color, sub }: { value: string; label: string; color?: string; sub?: string }) {
  return (
    <div>
      <div style={{ fontFamily: MONO, fontSize: 34, fontWeight: 600, color: color ?? INK.text, lineHeight: 1.05, letterSpacing: "-0.02em" }}>{value}</div>
      <div style={{ fontSize: 12.5, color: INK.muted, marginTop: 3 }}>{label}</div>
      {sub ? <div style={{ fontSize: 11, color: INK.faint, marginTop: 1 }}>{sub}</div> : null}
    </div>
  );
}

/* Inline horizontal bar inside a table cell (bar-in-table). value drawn as a fill;
   the number sits right-aligned on top. max scales the fill. */
export function BarCell({ value, max = 100, color = INK.text, label }: { value: number; max?: number; color?: string; label?: string }) {
  const w = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div style={{ position: "relative", height: 18, minWidth: 90 }}>
      <div style={{ position: "absolute", left: 0, top: 3, height: 12, width: `${w}%`, background: color, opacity: 0.18, borderRadius: 1 }} />
      <div style={{ position: "absolute", right: 4, top: 0, fontFamily: MONO, fontSize: 12, color: INK.text }}>{label ?? value}</div>
    </div>
  );
}

export function Dot({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12, color: INK.muted, marginRight: 12 }}>
      <span style={{ width: 9, height: 9, background: color, borderRadius: 2, display: "inline-block" }} />{children}
    </span>
  );
}

export function Rule() { return <div style={{ borderTop: `1px solid ${INK.rule}`, margin: "26px 0" }} />; }

export function Skel({ h = 16, w = "60%" }: { h?: number; w?: number | string }) {
  return <div className="animate-pulse" style={{ height: h, width: w, background: "#eceae3", borderRadius: 3 }} />;
}
export function Loading({ label }: { label: string }) {
  return <div style={{ display: "flex", alignItems: "center", gap: 8, color: INK.muted, fontSize: 13, padding: "10px 0", fontFamily: SANS }}><Loader2 className="animate-spin" size={14} /> {label}</div>;
}

/* Section header — small serif kicker + rule. */
export function Head({ kicker, title, children }: { kicker?: string; title: string; children?: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 14 }}>
      {kicker ? <div style={{ fontFamily: SANS, fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", color: INK.faint, marginBottom: 4 }}>{kicker}</div> : null}
      <h2 style={{ fontFamily: SERIF, fontSize: 21, fontWeight: 600, color: INK.text, margin: 0 }}>{title}</h2>
      {children ? <p style={{ fontFamily: SERIF, fontSize: 14, color: INK.muted, marginTop: 6, lineHeight: 1.5, fontStyle: "italic" }}>{children}</p> : null}
    </div>
  );
}

/* table cell styles */
export const td: React.CSSProperties = { padding: "5px 10px", fontSize: 12.5, borderBottom: `1px solid ${INK.rule}`, textAlign: "right", fontFamily: MONO, color: INK.text };
export const tdL: React.CSSProperties = { ...td, textAlign: "left", fontFamily: SANS };
export const th: React.CSSProperties = { padding: "4px 10px", fontSize: 10.5, letterSpacing: "0.04em", textTransform: "uppercase", color: INK.faint, fontWeight: 500, borderBottom: `1px solid ${INK.faint}`, fontFamily: SANS };
export const thL: React.CSSProperties = { ...th, textAlign: "left" };
