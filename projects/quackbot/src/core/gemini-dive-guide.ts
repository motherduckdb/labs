/**
 * Gemini-tuned dive guide.
 *
 * The dive-authoring guide is served by the MotherDuck MCP as
 * `get_guide("dives.md")` (mdw-turbo's era exposed it as a dedicated
 * `get_dive_guide` tool with `chatgpt` / `claude` / `claude_code` / `other`
 * variants — no `gemini` variant). Because mdw-turbo runs on Gemini 3 Flash,
 * fetching the default guide and passing it through produced a persistent
 * 30-42% failure rate on
 * `save_dive` / `update_dive` / `edit_dive_content` (see issue #149). Two
 * concrete causes from the failure analysis:
 *   1. Wrong hook + wrong package — the model writes `useQuery` from
 *      `@motherduck/wasm-client` instead of `useSQLQuery` from
 *      `@motherduck/react-sql-query`. The dive viewer's runtime only
 *      resolves the latter, so the validator rejects the dive.
 *   2. Missing `REQUIRED_DATABASES` declaration — successful saves declare
 *      it ~6× more often than failures.
 *
 * Gemini 3 prompting guidance is to put hard, behavior-shaping constraints
 * at the TOP of the system instruction, with explicit negative examples.
 * That's the shape this guide takes: a "Hard rules" block first, followed
 * by workflow phases, then reference material. The MCP guide content is
 * preserved in substance — only the ordering and emphasis change.
 *
 * The agentic loop intercepts `get_guide("dives.md")` on Gemini profiles and
 * returns this string instead of dispatching to MCP (see
 * src/core/agentic-loop.ts).
 */

import galacticCoffee from './dive-examples/galactic-coffee.json';
import visualHistory from './dive-examples/visual-history.json';

interface DiveExample {
  title: string;
  sourceUrl: string;
  source: string;
}

/**
 * Build the Gemini dive guide. No arguments today — kept as a function so
 * we can introduce per-database or per-mode tailoring without breaking the
 * call site. The rules-and-workflow portion is the static GEMINI_DIVE_GUIDE
 * below; an appendix of full-source reference dives is concatenated at the
 * end so the model has concrete, ship-quality examples to anchor on. The
 * appendix is large (~40K tokens) and prompt-cache stable, so the cost
 * lands on the first call per cache window and amortises across the rest.
 */
export function buildGeminiDiveGuide(): string {
  return `${GEMINI_DIVE_GUIDE}\n\n${buildReferenceDivesSection([galacticCoffee, visualHistory])}`;
}

function buildReferenceDivesSection(examples: DiveExample[]): string {
  const parts: string[] = [];
  parts.push('---');
  parts.push('');
  parts.push('## Reference dives — study these for visual polish');
  parts.push('');
  parts.push(
    'Two real dives from the public MotherDuck gallery. Both ship in production and demonstrate the visual target: typography hierarchy, design-token objects, theme-aware styling, skeleton loaders that match the final shape, narrative pacing, recharts wired through `useSQLQuery`, fully qualified table refs, and the `N()` BigInt guard applied consistently.',
  );
  parts.push('');
  parts.push(
    'Do not copy them line-for-line — the user did not ask for a theme gallery or a slideshow. Adapt the *patterns*: how design tokens are factored out, how loading and empty states are rendered, how chart components are composed, how filter state threads through the page. When in doubt about what good looks like, refer back to these.',
  );
  for (const ex of examples) {
    parts.push('');
    parts.push(`### ${ex.title}`);
    parts.push('');
    parts.push(`Source: ${ex.sourceUrl}`);
    parts.push('');
    parts.push('```tsx');
    parts.push(ex.source);
    parts.push('```');
  }
  return parts.join('\n');
}

const GEMINI_DIVE_GUIDE = `# MotherDuck Dives Guide (Gemini)

You are generating a **MotherDuck Dive** — a self-contained React component
that runs in a sandboxed iframe in the MotherDuck app and queries the user's
data live via a single allow-listed hook. Every dive write tool call
(\`save_dive\`, \`update_dive\`, \`edit_dive_content\`) is validated against
the rules below before the dive is persisted. Validation failures cost the
user time and money on retries.

This guide augments your general knowledge of React, Recharts, Tailwind CSS,
SQL, and visualization design. Where this guide and your training data
disagree about MotherDuck specifics, **this guide wins**.

---

## HARD RULES — read first

If you violate any of these, the dive will fail validation. Do not skip.

### 0. Never print raw dive source in chat

The dive source is delivered exclusively through tool calls — \`save_dive\`
(for new dives), \`update_dive\` / \`edit_dive_content\` (for edits), and
\`view_dive\` (to render). The user does NOT need to see the React/TSX
in chat, and printing it bloats the conversation, pollutes prompt
caches, and tempts the user to copy-paste instead of using the tools.

Do not:

- Output the component in a \`\`\`tsx fenced block as part of your reply.
- Paste fragments of JSX, useSQLQuery calls, or REQUIRED_DATABASES
  declarations into prose.
- Show a "here's the code" preview before calling \`save_dive\`.

Do instead:

- Describe the dive in plain English ("I'll build a 3-KPI strip with a
  monthly revenue line chart"), then call \`save_dive\` directly with
  the source as a tool argument.
- After the tool returns, the dive renders inline via \`view_dive\`.
  Refer the user to the rendered preview, not to the source.
- If the user explicitly asks "show me the code" — and only then —
  paste it. Default is to keep it inside tool calls.

The reference dives in the appendix below are reading material **for
you**, not output material — never echo them.

### 1. Use \`useSQLQuery\` from \`@motherduck/react-sql-query\`

The dive runtime only resolves **one** SQL hook. Always:

\`\`\`tsx
import { useSQLQuery } from "@motherduck/react-sql-query";

const { data, isLoading, isError, error } = useSQLQuery(\`
  SELECT col FROM "my_db"."main"."my_table"
\`);
\`\`\`

**Never use any of the following — they look plausible but the runtime cannot
resolve them and the dive will reject:**

\`\`\`tsx
// ❌ WRONG — package does not exist in the dive sandbox
import { useQuery } from "@motherduck/wasm-client";

// ❌ WRONG — different library, not loaded
import { useQuery } from "@tanstack/react-query";

// ❌ WRONG — Node SDK, not browser-side
import { MotherDuck } from "@motherduck/client";
\`\`\`

If you ever find yourself writing \`useQuery\` or \`@motherduck/wasm-client\`,
stop and rewrite the import. This single mistake accounts for the largest
share of historical dive-write failures.

\`data\` is the row array **directly** — there is **no** \`data.rows\`. Guard
with \`const rows = Array.isArray(data) ? data : [];\` before any access.

### 2. Declare \`REQUIRED_DATABASES\` at the top of the file

Every dive must declare which MotherDuck databases it reads from as an
**\`export const\` array of objects**, before the component definition.
The dive runtime parses this declaration to ATTACH the listed databases
in the viewer's WASM client — without it, every query against a shared
database renders blank.

For a **share** (the common case — what you get from \`list_shares\`):

\`\`\`tsx
export const REQUIRED_DATABASES = [
  { type: 'share', path: 'md:_share/<share_name>/<uuid>', alias: '<short_alias>' },
];
\`\`\`

For multiple databases, add more entries:

\`\`\`tsx
export const REQUIRED_DATABASES = [
  { type: 'share', path: 'md:_share/nba_box_scores_v2/a7b37364-...', alias: 'nba_box_scores_v2' },
  { type: 'share', path: 'md:_share/another_share/b8c48f...', alias: 'another' },
];
\`\`\`

The \`alias\` is what you use as the **first segment** in every fully
qualified table reference inside \`useSQLQuery\` — e.g. \`"nba_box_scores_v2"."main"."games"\`.

**Hard rules on this declaration:**

- The keyword \`export\` is required — the runtime regex only matches
  \`export const REQUIRED_DATABASES = [...]\`.
- It must be a literal array of objects with string-valued \`path\` and
  \`alias\` keys (and optional \`type: 'share'\`). The parser rejects
  template literals, function calls, getters, and operator expressions
  as a security measure, so anything dynamic silently produces an empty
  list and the dive renders blank.
- Declare it **exactly once** in the file. A second declaration
  ("const REQUIRED_DATABASES = [...]" below the first) is a syntax
  error — the dive will not transpile. If you copy a share entry from
  context, replace any starter declaration; do not append.
- Do NOT write \`const REQUIRED_DATABASES = ["my_db"]\` (string array
  without \`export\`). That form is a no-op — the regex won't match, the
  array stays empty, and queries against the share fail.

Dives that declare \`REQUIRED_DATABASES\` correctly succeed at roughly
6× the rate of dives that omit it.

### 3. Fully qualify every table reference

In \`useSQLQuery\` SQL and every export query, write the three-part
double-quoted form \`"database"."schema"."table"\` — every time, even for
the default \`main\` schema:

\`\`\`tsx
// ✅
useSQLQuery(\`SELECT * FROM "my_db"."main"."sales"\`);

// ❌ unqualified — works in the MCP \`query\` tool but breaks the saved dive
useSQLQuery(\`SELECT * FROM sales\`);
\`\`\`

The dive runtime does not share the MCP query tool's database context, so a
bare identifier that worked during exploration will fail after save.

### 4. Wrap every numeric value with \`N()\`

DuckDB returns \`BIGINT\`, \`HUGEINT\`, and \`DECIMAL\` as JavaScript
\`BigInt\` or wrapper objects, not \`number\`. Rendering one in JSX,
passing it to \`.toFixed()\`, \`.toLocaleString()\`, or
\`JSON.stringify\` will **blank-screen the entire dive with no error**.

Define this helper once and use it on every numeric value:

\`\`\`tsx
const N = (v: unknown): number => (v != null ? Number(v) : 0);
\`\`\`

Wrap on every access: \`{N(row.revenue).toLocaleString()}\`, not
\`{row.revenue.toLocaleString()}\`.

### 5. Default export the component

The validator looks for \`export default function ComponentName()\`.
Named exports, anonymous arrow defaults, and \`module.exports\` all fail.

\`\`\`tsx
export default function SalesOverview() { ... }
\`\`\`

### 6. Before \`edit_dive_content\`, call \`read_dive\` this turn

\`edit_dive_content\` requires \`old_string\` to match the current dive
content exactly. If you have not called \`read_dive\` in the current turn,
do that first — relying on history can silently use a stale snapshot and
the edit will fail with "old_string not found".

For larger rewrites, use \`update_dive\` with the full new content instead.

### 7. Allowed libraries only

| Library | Import |
|---|---|
| react | \`import { useState, useEffect, useRef } from "react"\` |
| @motherduck/react-sql-query | \`import { useSQLQuery, useExport, useDiveState } from "@motherduck/react-sql-query"\` |
| recharts | \`import { LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts"\` |
| d3 | \`import * as d3 from "d3"\` (non-chart use only — geo, force layouts) |
| lucide-react | \`import { Loader2, AlertCircle } from "lucide-react"\` |

Not available: shadcn/ui, styled-components, emotion, \`fetch()\` to
external APIs (CSP), external scripts/fonts/stylesheets, dynamic
\`import()\`, transpilers (Babel/Sucrase/SWC).

---

## Workflow phases

You are always in one of these phases. Do not skip phases.

| Phase | Trigger | Allowed actions |
|---|---|---|
| **EXPLORE** | New dive request | \`list_databases\`, \`list_tables\`, \`list_columns\`, \`search_catalog\`, \`query\` |
| **DRAFT** | Schema understood, ready to design | Run real \`query\` calls; build static-data component; show to user |
| **SAVE** | User explicitly says "save" / "save as a dive" | Run pre-save checklist; call \`save_dive\` |
| **EDIT** | User wants to change an existing dive | \`read_dive\` first (same turn); then \`edit_dive_content\` (small) or \`update_dive\` (large) |

### Phase EXPLORE

1. Check saved **guides** first (\`list_guides\` with the database name as
   \`keyword\`, then \`get_guide\` on relevant paths) to find established naming
   conventions, palette choices, and domain memos for this database.
2. Inspect schema with \`list_columns\` / \`search_catalog\` rather than
   guessing column names. Hallucinated identifiers are a common failure
   mode that the catalog lookup eliminates.
3. Run small exploratory \`query\` calls (LIMIT 100, or aggregate) to
   understand cardinality and ranges before designing.

### Phase DRAFT

Build the component with **real data as static constants**. The dive will
re-query live via \`useSQLQuery\` after save, but during iteration static
data keeps the render fast and lets the user steer the design before any
write tool runs.

Above each constant, leave a SQL comment with the query that produced it.
Conversion to \`useSQLQuery\` then becomes a mechanical find-and-replace.

\`\`\`tsx
// QUERY: SELECT strftime(date_trunc('month', order_date), '%Y-%m') as month,
//        SUM(revenue) as revenue
//   FROM "my_db"."main"."sales" GROUP BY 1 ORDER BY 1
const MONTHLY_DATA = [
  { month: "2024-01", revenue: 64000 },
  { month: "2024-02", revenue: 78000 },
];
\`\`\`

Show the draft to the user. Wait for explicit save intent before moving on.

### Phase SAVE — pre-save checklist

Run **all** of these before calling \`save_dive\`:

- [ ] \`export default function\` present
- [ ] \`export const REQUIRED_DATABASES = [...]\` declared **exactly once**, with object entries (\`{ type, path, alias }\`), aliases matching every \`useSQLQuery\` table reference
- [ ] At least one \`useSQLQuery\` (or \`exportQuery\`) call
- [ ] Every table reference is \`"db"."schema"."table"\` fully qualified
- [ ] \`useSQLQuery\` imported from \`@motherduck/react-sql-query\` (NOT \`@motherduck/wasm-client\`)
- [ ] No \`useQuery\` calls — only \`useSQLQuery\`
- [ ] \`N()\` wrapping every numeric value
- [ ] Dates formatted in SQL with \`strftime()\`, not JavaScript
- [ ] Each section has its own loading placeholder (no single full-page spinner)
- [ ] Export controls (if present) only run from user \`onClick\` handlers
- [ ] Preview banner block included as first child (see below)

Pass any check? Fix the dive before calling \`save_dive\`. Calling and
hoping the validator catches it costs the user 2-3 retry round trips.

### Phase EDIT

\`\`\`
read_dive(id: "...")           // SAME TURN, always
edit_dive_content(
  id, edits: [{ old_string, new_string }]
)
\`\`\`

For more than ~3 distinct edits, or a wholesale redesign, prefer
\`update_dive\` with the full new content over a long \`edits\` array.

---

## Preview banner (required block)

Every dive must include this banner as the first child inside the outermost
\`<div>\`. The save tools strip it automatically — do not remove it manually.

\`\`\`tsx
{/* Preview banner — stripped on save */}
<div data-dive-preview style={{background:"#fff3cd",padding:"8px 16px",display:"flex",justifyContent:"space-between",alignItems:"center",fontSize:"13px",border:"1px solid #f5d680",borderRadius:"4px",color:"#664d03"}}>
  <span style={{fontWeight:600}}>Preview — using subset of your data</span>
  <span style={{color:"#664d03"}}>Save dive to view in MotherDuck</span>
</div>
\`\`\`

---

## Hooks reference

### \`useSQLQuery(sql, options?)\`

\`\`\`tsx
const { data, isLoading, isError, error, exportAs } = useSQLQuery(
  \`SELECT ... FROM "db"."main"."t"\`,
  { enabled: !!selected },   // skip while dependency unset
);
\`\`\`

- \`data\` is the row array directly — \`undefined\` while loading, then an
  array of \`{ col: value, ... }\` objects.
- Guard: \`const rows = Array.isArray(data) ? data : [];\`
- One query per visual section. Don't union unrelated aggregates.
- Results are truncated at ~50 KB; aggregate more aggressively if you hit it.

### \`useDiveState(key, initial)\`

Same shape as \`useState\` but takes a leading string key. Values persist
to the URL fragment (round-trips when the link is shared).

\`\`\`tsx
const [view, setView] = useDiveState<"cards" | "list">("view", "cards");
const [filters, setFilters] = useDiveState<string[]>("filters", []);
\`\`\`

JSON-serializable values only — no \`Date\`, \`Map\`, \`Set\`, functions,
class instances. Setting to \`undefined\` resets to the initial value. Two
callsites with the same key share state. Values are visible to anyone
with the share link — never store credentials.

In the **embedded preview** (the view rendered inline by \`view_dive\`),
\`useDiveState\` is stubbed to plain \`useState\` — no URL persistence, and
two callsites with the same key do NOT share state. Production
MotherDuck behaves as documented above. Build the dive against the
production semantics; the preview is for visual validation only.

### \`useExport().exportQuery({ sql, format, filename, ... })\` / \`useSQLQuery().exportAs(...)\`

Only add export controls when the user asks. Must run from a real user
gesture (\`onClick\`). Formats: \`"csv"\`, \`"json"\`, \`"parquet"\`, \`"xlsx"\`.

\`\`\`tsx
await ordersQuery.exportAs({ format: "csv", filename: "orders" });
\`\`\`

Don't construct Blob URLs, \`COPY TO\` statements, or hidden anchors —
the sandbox runtime owns the download flow.

---

## SQL best practices

- **Fully qualified tables**, always: \`"db"."schema"."table"\`.
- **Format dates in SQL** with \`strftime(col, '%Y-%m')\` — JavaScript
  \`Date\` parsing on DuckDB temporal types corrupts them.
- **Fill time-series gaps in SQL**. Recharts does not interpolate; a
  missing month leaves a gap. Use a \`generate_series\` spine:
  \`\`\`sql
  SELECT strftime(d, '%Y-%m') as month, COALESCE(SUM(s.revenue), 0) as revenue
    FROM generate_series(DATE '2024-01-01', DATE '2024-12-01', INTERVAL 1 MONTH) AS t(d)
    LEFT JOIN "my_db"."main"."sales" s ON date_trunc('month', s.order_date) = t.d
   GROUP BY 1 ORDER BY 1;
  \`\`\`
- **One query per visual.** Filters can be shared via \`useState\` /
  \`useDiveState\`; don't combine unrelated aggregates.

---

## Design system

**Tone.** Matter-of-fact. State what the data shows, not what it means.
"Revenue was $64M in Q1, $176M in Q2" — not "strong growth."

**Tables before charts** for fewer than ~8 categories. A chart is only
earned when (a) time-series shape matters → line, (b) you have 8+
categories to rank → bar, or (c) spatial relationships matter → scatter.
Never show a chart AND a table with the same data.

**Palette.**

\`\`\`tsx
const PALETTE = ["#0777b3", "#bd4e35", "#2d7a00", "#e18727", "#638CAD", "#adadad"];
\`\`\`

| Role | Hex |
|---|---|
| Primary | \`#0777b3\` |
| Positive (↑) | \`#2d7a00\` |
| Negative (↓) | \`#bc1200\` |
| Background | \`#f8f8f8\` |
| Text | \`#231f20\` |
| Text muted | \`#6a6a6a\` |

**Layout.**

- Charts: \`<ResponsiveContainer width="100%" height={250}>\`. Don't hardcode widths.
- KPIs: \`text-5xl font-bold\` numeric, label below, horizontal grid
  (\`grid grid-cols-4 gap-8\`), never stacked vertically, no card borders.
- Line charts: \`type="linear"\` interpolation, no curves.
- No \`bg-white\`, no \`border\`, no \`rounded-lg\` on chart wrappers.

**Tailwind.**

- No bracket / arbitrary values (\`bg-[#f8f8f8]\`, \`w-[300px]\`,
  \`text-[14px]\`) — the dive runtime cannot resolve them. Use inline
  \`style={{}}\` for custom colors and sizes; standard utilities
  (\`p-6\`, \`text-sm\`, \`font-bold\`, \`grid\`, \`gap-8\`) work.
- Never construct classes dynamically (\`text-\${color}\`, \`bg-\${variant}-500\`).
- \`shadcn/ui\` is not available — use native HTML with Tailwind.

**Sizing.** The dive renders in roughly 800×600 px visible area. Keep to
1-2 charts, 200-280 px height each, 4 KPIs max in a single row.

---

## Visual craft

Mechanically valid is not the same as well-designed. These rules cover the
choices the model otherwise makes inconsistently.

**Typography scale.** Don't pick text sizes ad-hoc — use one of these roles:

| Role | Class | When |
|---|---|---|
| Dive title (\`h1\`) | \`text-2xl font-semibold\` | Once, at the top |
| Section heading (\`h2\`) | \`text-lg font-semibold\` | Above each chart or table |
| KPI number | \`text-5xl font-bold\` | Headline metric only |
| Body | \`text-sm\` | Default for paragraphs and table cells |
| Caption / label | \`text-xs\` style \`color:"#6a6a6a"\` | Subtitles, axis labels, KPI labels |

Use \`color:"#231f20"\` for primary text and \`color:"#6a6a6a"\` for muted —
never \`text-gray-500\` (arbitrary Tailwind doesn't always resolve).

**Spacing scale.** Stay on a 4-px grid via Tailwind utilities — \`gap-2\`
(8px), \`gap-4\` (16px), \`gap-6\` (24px), \`gap-8\` (32px). Container
padding \`p-4\` for compact sections, \`p-6\` for the outermost wrapper.
\`mb-8\` between major sections; \`mb-2\` between a heading and its body.

**Visual hierarchy.** Order top to bottom: (1) title + subtitle,
(2) KPI row — the highest-density summary, (3) the primary chart or
table — the largest visual element, (4) any secondary chart or detail
section, half the height of the primary. The user's eye should land on
the KPIs first, then the chart that supports them.

**State design.** Every \`useSQLQuery\` has four states; cover all four:

- **Loading** — per-section skeleton (see Progressive loading).
- **Error** (\`isError\`) — render a one-line muted message in place of the
  section: \`<p className="text-sm" style={{color:"#6a6a6a"}}>Couldn't
  load this section.</p>\`. Don't surface raw \`error.message\` to the user.
- **Empty** (loaded, zero rows) — replace the chart/table with a single
  centered caption: \`No data in the selected range.\` Don't render an
  empty chart frame; it reads as broken.
- **Loaded** — the normal path.

Guard the empty case explicitly: \`if (!query.isLoading && rows.length === 0)
return <Empty />;\` — Recharts will render a confusing empty grid otherwise.

**Accessibility minimums.**

- One \`<h1>\` per dive; section headings use \`<h2>\`. Don't use \`<div>\`
  with big text in place of headings — screen readers skip them.
- Charts get a real \`<h2>\` above them describing what they show
  ("Monthly revenue, 2024"), not a styled paragraph.
- Color must not be the only signal. If you encode trend with red/green,
  also include a \`↑\` / \`↓\` glyph and the numeric value.
- Interactive elements (buttons, table sort headers) get \`aria-label\`
  when the text isn't self-explanatory.

**Wireframe first.** Before writing JSX, list the sections in plain text
("Title → 4 KPIs → revenue line chart → top-products table"). This is the
output structure the user sees; mismatched structure is the most common
post-render rework. Skip the wireframe for single-metric dives only.

---

## Progressive loading

Each \`useSQLQuery\` loads independently. Render the page layout
immediately and show a per-section skeleton — never a single top-level
\`if (isLoading) return <Spinner />\`.

\`\`\`tsx
{query.isLoading ? (
  <div className="h-12 w-24 bg-gray-200 animate-pulse rounded" />
) : (
  <p className="text-5xl font-bold" style={{color:"#231f20"}}>{N(data[0].kpi)}</p>
)}
\`\`\`

Use \`{ enabled: !!dep }\` on dependent queries; otherwise let each
section race its own request.

---

## DuckDB → JavaScript type cheat sheet

| DuckDB type | JS type | Conversion |
|---|---|---|
| INTEGER, FLOAT, DOUBLE | number | direct |
| BIGINT, HUGEINT | bigint | \`N(value)\` |
| DECIMAL | wrapper | \`N(value)\` |
| VARCHAR | string | direct |
| JSON | string | \`JSON.parse(v)\` |
| BOOLEAN | boolean | direct |
| DATE, TIMESTAMP | wrapper | format in SQL with \`strftime()\` |
| INTERVAL | wrapper | \`v.toString()\` |
| ARRAY, LIST | wrapper | \`v.values\` |
| STRUCT | wrapper | \`v.toJson()\` |

A single unguarded BigInt or DATE access in JSX will silently blank-screen
the dive — no console error, no validator warning. \`N()\` for numerics,
SQL formatting for temporals, every time.

---

## Troubleshooting (read on failure)

| Symptom | Likely cause | Fix |
|---|---|---|
| Validator rejects: unresolved import | \`@motherduck/wasm-client\` or \`useQuery\` | Switch to \`useSQLQuery\` from \`@motherduck/react-sql-query\` |
| Validator rejects: no useSQLQuery hooks | False negative — verify hooks ARE present and proceed | (Known issue) |
| Dive blank screen, no error | Unguarded BigInt / DATE in JSX | Wrap with \`N()\` or format in SQL |
| Dive saves but queries return empty in MotherDuck | Unqualified table names | Use \`"db"."schema"."table"\` |
| \`edit_dive_content\`: "old_string not found" | Stale view of dive content | \`read_dive\` first **this turn**, then edit |
| \`data.rows\` is undefined | Wrong access pattern | \`data\` IS the rows array; \`Array.isArray(data) ? data : []\` |
| Chart has gaps in time series | No spine in SQL | \`generate_series\` + LEFT JOIN |

---

## Complete example — DRAFT phase

\`\`\`tsx
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";

export const REQUIRED_DATABASES = [
  { type: 'share', path: 'md:_share/my_db/<uuid-from-list_shares>', alias: 'my_db' },
];

const N = (v: unknown): number => (v != null ? Number(v) : 0);

// QUERY: SELECT strftime(date_trunc('month', order_date), '%Y-%m') as month,
//        SUM(revenue) as revenue FROM "my_db"."main"."sales" GROUP BY 1 ORDER BY 1
const MONTHLY_DATA = [
  { month: "2024-01", revenue: 64000 },
  { month: "2024-02", revenue: 78000 },
  { month: "2024-03", revenue: 92000 },
  { month: "2024-04", revenue: 176000 },
];

// QUERY: SELECT SUM(revenue) as total, AVG(revenue) as avg_monthly
//   FROM "my_db"."main"."sales" WHERE order_date >= '2024-01-01'
const SUMMARY = [{ total: 410000, avg_monthly: 102500 }];

export default function SalesOverview() {
  const rows = MONTHLY_DATA.map(r => ({ month: r.month, revenue: N(r.revenue) }));

  return (
    <div className="p-6" style={{background:"#f8f8f8"}}>
      {/* Preview banner — stripped on save */}
      <div data-dive-preview style={{background:"#fff3cd",padding:"8px 16px",display:"flex",justifyContent:"space-between",alignItems:"center",fontSize:"13px",border:"1px solid #f5d680",borderRadius:"4px",color:"#664d03"}}>
        <span style={{fontWeight:600}}>Preview — using subset of your data</span>
        <span style={{color:"#664d03"}}>Save dive to view in MotherDuck</span>
      </div>
      <h1 className="text-2xl font-semibold" style={{color:"#231f20"}}>Sales Overview</h1>
      <p className="text-sm mb-8" style={{color:"#6a6a6a"}}>Q1 2024</p>

      <div className="grid grid-cols-4 gap-8 mb-8">
        <div>
          <p className="text-5xl font-bold" style={{color:"#231f20"}}>
            \${(N(SUMMARY[0].total) / 1000).toFixed(0)}K
          </p>
          <p className="text-sm mt-2" style={{color:"#6a6a6a"}}>Total Revenue</p>
        </div>
      </div>

      <ResponsiveContainer width="100%" height={250}>
        <LineChart data={rows}>
          <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
          <XAxis dataKey="month" fontSize={11} />
          <YAxis tickFormatter={(v) => \`\${(v/1000).toFixed(0)}K\`} fontSize={11} />
          <Tooltip />
          <Line type="linear" dataKey="revenue" stroke="#0777b3" strokeWidth={2} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
\`\`\`

For SAVE phase, replace \`MONTHLY_DATA\` and \`SUMMARY\` with their
\`useSQLQuery\` calls, add per-section loading placeholders, then call
\`save_dive\`.
`;
