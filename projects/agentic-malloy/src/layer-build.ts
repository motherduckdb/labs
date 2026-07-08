/**
 * layer-build — a GENERIC, model-authored Malloy layer builder. Given a dataset
 * (tables + a local DuckDB to introspect/validate against), domain context
 * markdown, a set of example Q/A pairs for coverage, and Malloy docs, an
 * expensive-tier model WRITES a reusable semantic layer (<modelsDir>/*.malloy +
 * <metaDir>/*.yaml) from scratch, each file compile+execute validated as it's
 * written with a localized repair loop.
 *
 * NOTHING here is dataset-specific: table names, the context source, the example
 * source, output naming, and any domain-specific guidance all arrive via
 * `LayerBuildConfig`. The DABstep experiment supplies those through a thin
 * wrapper (see dabstep-build.ts) — this module never reads DABstep files, names
 * "fee"/"merchant", or cites task IDs.
 *
 * INCREMENTAL: one file per LLM call (source-per-entity convention). The
 * `<table>_base.malloy` sources are authored first (independent, no joins), then
 * a small model-planned set of intermediate sources, then a thin top-level
 * `<outputName>.malloy`. Each call returns two fenced blocks (```malloy +
 * ```yaml) — far more robust than one giant JSON.
 */
import { readFile, readdir, writeFile, rm, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DuckDBInstance } from '@duckdb/node-api';
import { complete } from './llm-client.js';
import { MalloyRuntime } from './malloy-runtime.js';
import { viewQualitySmells, smellSummary } from './view-quality.js';
import { layerSourceGate } from './malloy-source.js';
import { detectRawSqlInMalloy } from './linter.js';
import { extractGlossary, groundGlossary, renderGlossary, type GlossaryEntry } from './glossary.js';
import * as cl from './controllog.js';

// Re-export the deterministic build gates (2A.3) so they conceptually "live with"
// layer-build per the plan's file index, while staying a dependency-light pure
// module (malloy-source.ts) the lean answer-time store can also import.
export { layerSourceGate, viewRankingAggregation, extremumViewNames, type GateFinding } from './malloy-source.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Repo-relative locations. The layer + its docs live here by default; a generic
// caller may override modelsDir/metaDir/provenancePath via the config. DATA_DIR
// is exported for repo consumers (it is NOT used by the generic builder itself).
export const DATA_DIR = path.join(REPO_ROOT, 'data');
const MALLOY_DIR = path.join(REPO_ROOT, 'malloy');
export const MODELS_DIR = path.join(MALLOY_DIR, 'models');
export const META_DIR = path.join(MALLOY_DIR, '_meta');
export const PROVENANCE_PATH = path.join(MALLOY_DIR, '.provenance.json');
const DOCS_DIR = path.join(REPO_ROOT, 'docs', 'malloy');

/** Read a doc from docs/malloy (the Malloy primer, relationship-discovery, …). */
export async function readDoc(name: string): Promise<string> {
  return readFile(path.join(DOCS_DIR, name), 'utf8');
}

// Table specs (ref vs Malloy identifier vs file stem) live in their own module so
// glossary.ts can share them without an import cycle. Imported for internal use
// AND re-exported for the existing `from './layer-build.js'` importers (tests, etc.).
import { quoteDuckRef, safeTableName, normalizeTables, type TableSpec, type TableInput, type NormTable } from './table-spec.js';
export { quoteDuckRef, safeTableName, normalizeTables };
export type { TableSpec, TableInput, NormTable };

// ---------------------------------------------------------------------------
// Generic data dictionary (columnProfiles) + schema introspection.
// ---------------------------------------------------------------------------

/**
 * Dataset-agnostic COLUMN PROFILE: for every column of every table, report the
 * facts a modeler must verify before writing joins/filters — the truth the
 * build model otherwise can't see (it gets only schema + prose docs). For each
 * column: data type, NULL count, and either its full DISTINCT domain (when
 * low-cardinality — the values a categorical match must reproduce exactly), or
 * a numeric range, or a few samples. For LIST/ARRAY columns, the NULL-vs-empty
 * split — because "applies to all" is usually the empty list, not NULL, and that
 * distinction silently breaks wildcard predicates. Generic: a data dictionary
 * computed from the data, nothing task-specific.
 */
const LOWCARD_MAX = 40; // ≤ this many distinct → enumerate the full domain
const NUMERIC_TYPES = /^(BIGINT|HUGEINT|INTEGER|SMALLINT|TINYINT|UBIGINT|UINTEGER|USMALLINT|UTINYINT|DOUBLE|FLOAT|REAL|DECIMAL|NUMERIC)/i;
function fmtVal(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'string') return `'${v}'`;
  return String(v);
}
export async function columnProfiles(tables: TableInput[], dbPath: string): Promise<Record<string, string>> {
  const specs = normalizeTables(tables);
  const instance = await DuckDBInstance.create(dbPath);
  const conn = await instance.connect();
  const num = (v: unknown) => Number(v as number | bigint);
  const out: Record<string, string> = {};
  try {
    for (const { name: tableName, quoted: t } of specs) {
      const total = num((await conn.runAndReadAll(`SELECT count(*) c FROM ${t}`)).getRowObjects()[0].c);
      const cols = (await conn.runAndReadAll(`DESCRIBE ${t}`)).getRowObjects();
      const lines: string[] = [];
      for (const c of cols) {
        const name = String(c.column_name);
        const type = String(c.column_type);
        const qn = `"${name.replace(/"/g, '""')}"`;
        try {
          if (type.includes('[]') || /^(LIST|ARRAY)/i.test(type)) {
            // LIST/ARRAY: the wildcard-encoding question (NULL vs empty list).
            const r = (await conn.runAndReadAll(
              `SELECT count(*) FILTER (WHERE ${qn} IS NULL) AS n_null, count(*) FILTER (WHERE ${qn} IS NOT NULL AND len(${qn})=0) AS n_empty FROM ${t}`,
            )).getRowObjects()[0];
            const samp = (await conn.runAndReadAll(
              `SELECT DISTINCT ${qn} v FROM ${t} WHERE ${qn} IS NOT NULL AND len(${qn})>0 LIMIT 3`,
            )).getRowObjects().map((x) => JSON.stringify((x.v as { items?: unknown })?.items ?? x.v, (_k, v) => (typeof v === 'bigint' ? Number(v) : v)));
            lines.push(`  ${name} ${type} — LIST: NULL=${num(r.n_null)}, empty[]=${num(r.n_empty)} (empty list = "applies to all"); e.g. ${samp.join(' | ') || '(none)'}`);
          } else {
            const agg = (await conn.runAndReadAll(`SELECT count(DISTINCT ${qn}) d, count(*) FILTER (WHERE ${qn} IS NULL) n FROM ${t}`)).getRowObjects()[0];
            const distinct = num(agg.d);
            const nulls = num(agg.n);
            const nullNote = nulls ? ` (+ ${nulls} NULL)` : '';
            if (distinct <= LOWCARD_MAX) {
              const vals = (await conn.runAndReadAll(`SELECT DISTINCT ${qn} v FROM ${t} WHERE ${qn} IS NOT NULL ORDER BY 1`)).getRowObjects().map((x) => fmtVal(x.v));
              lines.push(`  ${name} ${type} — ${distinct} distinct${nullNote}: {${vals.join(', ')}}`);
            } else if (NUMERIC_TYPES.test(type)) {
              const mm = (await conn.runAndReadAll(`SELECT min(${qn}) lo, max(${qn}) hi FROM ${t}`)).getRowObjects()[0];
              lines.push(`  ${name} ${type} — ${distinct} distinct${nullNote}, range [${fmtVal(mm.lo)} .. ${fmtVal(mm.hi)}]`);
            } else {
              const samp = (await conn.runAndReadAll(`SELECT DISTINCT ${qn} v FROM ${t} WHERE ${qn} IS NOT NULL LIMIT 4`)).getRowObjects().map((x) => fmtVal(x.v));
              lines.push(`  ${name} ${type} — ${distinct} distinct${nullNote}; e.g. ${samp.join(', ')}`);
            }
          }
        } catch {
          lines.push(`  ${name} ${type} — (profile unavailable)`);
        }
      }
      out[tableName] = `(${total.toLocaleString()} rows)\n${lines.join('\n')}`;
    }
  } finally {
    conn.closeSync();
  }
  return out;
}

async function schemaByTable(specs: NormTable[], dbPath: string): Promise<Record<string, string>> {
  const instance = await DuckDBInstance.create(dbPath);
  const conn = await instance.connect();
  const out: Record<string, string> = {};
  try {
    for (const { name, quoted } of specs) {
      const r = await conn.runAndReadAll(`DESCRIBE ${quoted}`);
      out[name] = r.getRowObjects().map((row) => `  ${row.column_name} ${row.column_type}`).join('\n');
    }
  } finally {
    conn.closeSync();
  }
  return out;
}

// ---------------------------------------------------------------------------
// Generic Malloy/DuckDB authoring guidance (dataset-agnostic).
// ---------------------------------------------------------------------------

// DuckDB-specifics the primer doesn't cover + the Malloy-first rule + general
// modeling discipline. All GENERIC — no dataset's entities or facts appear here.
export const DUCKDB_NOTES = `Malloy-on-DuckDB specifics (in addition to the primer above):
- Reference a table by NAME: \`duckdb.table('<table>')\` — never a file path. The model files compile as ONE unit (concatenated), so do NOT use \`import\`; every source sees every other.
- Do NOT redefine an existing table column as a dimension/measure (e.g. \`dimension: x is ...\` when an \`x\` column exists → "Cannot redefine"). Only ADD derived fields with NEW names.
- ANY DuckDB SQL function the primer doesn't list needs the TYPED raw escape \`fn!returntype(args)\` — e.g. \`list_contains!boolean(col, x)\`, \`len!number(col)\`, \`lpad!string(x, 3, '0')\`, \`strftime!string(d, '%Y')\`, \`make_date!date(y, m, d)\`. Plain \`lpad(...)\`/\`strftime(...)\` fail with "Unknown function". There is no native list-membership operator — use \`list_contains!boolean\` for list columns. Prefer Malloy-native date ops (\`@2023\`, \`.month\`, \`::date\`) over SQL date formatting where possible.
- MALLOY-ONLY — RAW SQL IS PROHIBITED (hard rule, enforced by the build gate): express EVERYTHING in Malloy — \`join_one\`/\`join_many\`, \`view:\`, \`nest:\`, filtered aggregates, \`extend\`, parameterized sources. **\`duckdb.sql(...)\` is FORBIDDEN** — a file that contains it is REJECTED and sent back to you. Do NOT wrap joins, group-bys, CROSS JOINs, or \`SELECT DISTINCT\`/\`UNNEST\` value universes in raw SQL. Build a value universe in Malloy instead (e.g. a query/source that \`group_by\`s the column over the base table, or unnests a list column with the typed escape), and use the typed raw-FUNCTION escape \`fn!returntype(args)\` for individual DuckDB functions Malloy doesn't natively expose. The \`fn!returntype(...)\` function escape is ALLOWED; a \`duckdb.sql(...)\` block is NOT.
- PARAMETERIZED SOURCES (\`experimental.parameters\`) — declare params in the source SIGNATURE, reference them by BARE NAME in the body. Exact syntax: (1) the file MUST begin with the pragma \`##! experimental.parameters\` on its OWN first line (before any \`source:\`) — without it, every parameter reference errors as "\`X\` is not defined" and the feature errors as "Experimental flag \`parameters\` is not set". (2) Declare each param INSIDE the source's parentheses with a type and a default: \`source: my_src(p1::number is null, p2::string is null, p3::boolean is null) is <base_source> extend { ... }\` (types \`::number\`/\`::string\`/\`::boolean\`/\`::date\`; \`is null\` = "unset/optional"). (3) Reference a param by its BARE declared name anywhere in the body (a \`dimension:\`, \`measure:\`, a join \`on:\`, or a \`pick ... when\`) — do NOT rename it with an \`arg_\`/\`param_\` prefix, and do NOT re-declare it with \`declare:\`/\`dimension:\`; the signature IS its declaration. (4) A caller instantiates it by passing arguments BY NAME: \`run: my_src(p1 is 100, p2 is 'x') -> { ... }\`. If a name you intend as a parameter reports "not defined", you either omitted the \`##! experimental.parameters\` pragma or forgot to list that name in the signature parentheses.

MODELING DISCIPLINE — verify against the data, never trust prose alone (general principles; apply them to ANY dataset):
- A COLUMN PROFILE (per-column type, NULL count, and either the full DISTINCT domain, a numeric range, or samples; for list columns the NULL-vs-empty split) is given for every table below. It is GROUND TRUTH — when the prose docs and the profile disagree about encoding or domain, the profile wins.
- WILDCARD / "applies to all" is a PHYSICAL-ENCODING question, not a prose one. Check the profile: a list/array column almost always encodes "all" as the EMPTY list (\`len!number(col)=0\`), NOT null; a scalar uses NULL. Write the wildcard branch to match what the data actually stores — \`len!number(col)=0 or list_contains!boolean(col, x)\` for a list field, \`col is null or col = x\` for a scalar — and put a wildcard branch on EVERY match field (one unguarded equality silently drops all wildcard rows for that field).
- CATEGORICAL MATCH BY EQUALITY: when you derive/bucket a value to compare (string-equality) against a categorical column, your output labels MUST be EXACTLY that column's distinct values from the profile. NEVER infer the set of buckets from a single documented example — reproduce the full observed domain. If a fact column's raw domain differs from the rule column's domain (the profile shows two different sets), you must transform/bucket the fact value to the rule's exact strings before matching.
- QUALIFY JOIN KEYS: if more than one joined table exposes the same column name, reference it qualified (\`some_source.col\`, not bare \`col\`) or you get a binder/scope error that only surfaces at EXECUTION, not at compile. After authoring a source with joins, mentally run a query THROUGH the join, not just a compile check.
- JOIN_MANY DOUBLE-COUNTS: a \`join_many\` multiplies each base row by the number of matched rows on the other side. Define the per-match measure at the joined grain — \`joined.sum(<expr combining joined columns and base columns>)\` — and NEVER re-aggregate a base-grain column (a volume, a count, an amount) after a join_many, or it is multiplied by the match count. State in the source's _meta which measures are base-grain vs match-grain.
- SYMMETRIC AGGREGATES ACROSS A JOIN (compile error, very common): you CANNOT write a bare \`avg(joined.col)\` / \`min(joined.col)\` / \`max(joined.col)\` / \`sum(joined.col)\` over a joined relationship — Malloy rejects it ("Cannot compute \`avg\` across \`join_many\` relationship X; use \`X.col.avg()\`" and "Symmetric aggregate \`min\` must be written as \`min(expression)\` or \`path.to.field.min()\`"). ALWAYS use the path form on the joined source: \`joined.col.avg()\`, \`joined.col.min()\`, \`joined.col.max()\`, \`joined.col.sum()\` (or define the per-row expression as a dimension on the joined source first, then \`joined.that_dim.avg()\`). Never \`avg(joined.col)\`.
- JOIN_MANY ON-CLAUSE SCOPE (critical, causes execution-only failures): a \`join_many ... on\` predicate must reference ONLY columns physically present on the two sources being joined. Do NOT reference a column reached through ANOTHER join — including a pass-through \`dimension: x is other_join.col\`. A pass-through dimension is just an ALIAS for the joined column, NOT a real column; it often COMPILES but the generated SQL references an out-of-scope alias and FAILS AT EXECUTION ("Referenced table … not found"). FIX (use this exact shape for fact×rule matching): (1) build an enriched fact source with a PROJECTION that turns the needed joined attributes into REAL local columns — \`source: enriched is fact_base extend { join_one: m is dim ... } -> { select: *, attr_a is m.col_a, attr_b is m.col_b, ... }\`; (2) then \`source: matched is enriched extend { join_many: rules on (len!number(rules.x)=0 or list_contains!boolean(rules.x, attr_a)) and ... }\` referencing ONLY \`enriched\`'s local columns. Keep the fan-out exactly ONE join level deep.
- AGGREGATION COMPLETENESS — expose the FULL standard set, not one mode. For each per-row quantity you measure, define ALL of \`sum\`, \`avg\`, \`min\`, \`max\`, and a \`count\` of the rows, grouped by each relevant dimension. Different questions need DIFFERENT aggregations of the SAME quantity ("the total a group accumulates" = SUM vs "the typical value across the group" = AVG); exposing only one mode silently forces the wrong answer. And do NOT pre-bake "answer" views that freeze an aggregation + a tiebreak + a \`limit: 1\` (a \`most_X\` / \`cheapest_X … limit: 1\` view) — they hard-code ONE interpretation of a ranking question. Expose the measures + the dimensions and let the caller compose the ranking (order_by + limit) last-mile. A view NAMED for an extremum/total ("most/least/cheapest/highest") must rank by a true total or extremum, never by an average.
- DERIVE ENUM/LIST UNIVERSES FROM THE DATA — never hardcode them. When you must explode a list/array column to group or rank by its elements, build the candidate universe from the column's OWN observed values (\`SELECT DISTINCT UNNEST(col) FROM <base>\`), NOT a literal \`(VALUES (...))\` set. A hardcoded literal drifts from the data — it can include a value that appears in zero rows (which then wins/loses a ranking on nothing) or miss one. (The full DEFINED domain — including zero-row codes — belongs ONLY in an explicitly-named "possible values of X" surface, never baked into a ranking source.)
- A VIEW THAT COMPILES IS NOT DONE — IT MUST EXECUTE. Every view/measure you author will be run end-to-end at build time; one that compiles but errors at execution (binder/scope) is a FAILED build and will be sent back to you to fix. Author each source so a query through its joins actually returns rows.

GRAIN & SELF-CONSISTENCY — a measure must be correct no matter HOW it is aggregated (these are the most common silent-wrongness bugs; they compile and run but return wrong numbers):
- GRAIN-INVARIANCE. Every measure must return the SAME value regardless of how a caller aggregates it. If a source FANS OUT rows — a \`join_many\`, a \`join_cross\`, or any candidate-sweep/cross-join projection that multiplies base rows — do NOT expose a base-grain total on that fanned source: aggregating it multiplies by the fan-out cardinality (a tell-tale clean integer-multiple inflation). Compute base-grain measures BEFORE the fan-out (or via \`count(distinct base_key)\`), or expose them ONLY on a view that first collapses back to one row per base entity.
- COMPARABLES SHARE ONE COMPUTATION. Two quantities meant to be compared or differenced (a baseline and a scenario, a before and an after) must be computed over the SAME population at the SAME grain within ONE query, and the difference exposed as its OWN measure — never left for a caller to subtract two independently-built aggregates. Average/sum over DISTINCT matching rows, not over a join's fan-out rows.
- RANK OVER THE PARTICIPATING UNIVERSE. A "most/least/extremum" ranking's candidate set is the values that DISTINCTLY participate — those appearing in a specific, non-wildcard/non-default row — never the full domain/catalog. Values matched only by wildcard/default rules carry no distinguishing signal, tie at the baseline, and must be excluded from rankings.
- COUNTERFACTUAL VIEWS CARRY THEIR OWN GUARDS. A "reassign to a DIFFERENT value" view must exclude the current value (\`candidate <> current\`) so the no-op option cannot win. An "entities affected by a change" view must expose the membership DIFFERENCE (matched-before XOR matched-after), not raw before/after counts a caller has to combine.
- NEVER MATERIALIZE UNDEFINED STRUCTURE. Only expose buckets, tiers, thresholds, or flags the source documentation NUMERICALLY defines. Inventing a plausible cutoff creates a false "answer surface" that presents an undefined concept as if it were defined.
- PRE-EXPOSE COMMON ANALYTICAL PRIMITIVES — percentiles/quantiles, distinct-entity counts, rate-by-count vs rate-by-volume, repeat-entity flags — as reusable measures/views, so a caller answers with a thin filter instead of hand-authoring window functions.

COMMENT DISCIPLINE — the .malloy and the _meta sidecar have DIFFERENT jobs; do not duplicate prose across them:
- The _meta yaml is the DESCRIPTION surface (it's what a reader/agent sees to navigate and call the layer): put ALL prose there — what each source/view means, the grain, and HOW TO CALL it (the \`usage\` per export).
- The .malloy carries CODE ONLY, with comments limited to TERSE, code-local notes that explain a non-obvious Malloy/DuckDB idiom right where it's used (e.g. why a raw escape \`fn!returntype\` is needed, an empty-list-vs-NULL wildcard encoding, a base-grain-vs-match-grain caution, a join-scope reason). A few words each.
- Do NOT write narration/header blocks in the .malloy that restate the _meta summary (domain overview, "this source exposes X by Y", usage walkthroughs). That prose belongs ONLY in the yaml. A lean model file + a rich sidecar, never the same words twice.

Output EXACTLY two fenced blocks and nothing else:
1. A \`\`\`malloy block: the file contents (code + only terse code-local comments, per the discipline above).
2. A \`\`\`yaml block: the _meta sidecar with TOP-LEVEL keys (do NOT nest under a \`_meta:\` key): file, domain, summary, exports (list of {name, kind, summary, usage}), provides_for (list of strings). \`usage\` is a one-line how-to-call for that export (the scoping \`where:\`, the final shape, e.g. "scope to one entity + time window then \`limit 1\` ordered asc for the cheapest").`;

// The anti-benchmark / reusable-concepts policy — applied to ALL output so the
// generated layer is a semantic model, not an answer key tailored to examples.
export const SEMANTIC_LAYER_POLICY = `SEMANTIC-LAYER POLICY (applies to ALL generated Malloy AND _meta):
- Produce a REUSABLE semantic layer describing the domain's entities, relationships, measures, and dimensions — NOT an answer key. Infer the reusable concepts from the domain context, the schema, the column profile, and the example questions.
- The example questions indicate the analytical surface area to COVER. GENERALIZE them into reusable views/measures; they are examples, not labels to copy.
- NEVER cite an example/task identifier (e.g. "Q123", "1711"), embed a gold/expected answer value, or create a one-off view named after or tailored to a single example. Name each view/measure for the CONCEPT it computes, never for a question.
- A reader of the layer or its _meta should not be able to tell which specific example questions existed.`;

// ---------------------------------------------------------------------------
// Parsing + filesystem
// ---------------------------------------------------------------------------

/** Parse a JSON array of {old,new} search/replace edits from a repair response. */
export function parseEdits(text: string): Array<{ old: string; new: string }> {
  const tryParse = (s: string): Array<{ old: string; new: string }> | null => {
    try {
      const arr = JSON.parse(s) as unknown;
      if (!Array.isArray(arr)) return null;
      return (arr as Array<{ old?: unknown; new?: unknown }>)
        .filter((e) => e && typeof e.old === 'string' && typeof e.new === 'string')
        .map((e) => ({ old: e.old as string, new: e.new as string }));
    } catch {
      return null;
    }
  };
  // Robust extraction: the old greedy /\[[\s\S]*\]/ spanned the FIRST `[` to the LAST
  // `]`, so any bracket in reasoning prose or a Malloy list snippet (`['A','B']`,
  // `col[0]`) around the JSON made JSON.parse throw → [] → "no applicable edits". At
  // --reasoning high (more bracket-laden reasoning) this failed every round. Instead:
  // prefer a ```json fence, else collect BALANCED-bracket `[…]` spans and try them
  // LAST-first (the intended array is emitted after any reasoning).
  const candidates: string[] = [];
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) candidates.push(fence[1].trim());
  const spans: string[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '[') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === ']' && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        spans.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  candidates.push(...spans.reverse());
  for (const c of candidates) {
    const r = tryParse(c);
    if (r && r.length) return r; // a candidate that parses to a non-empty edit list
  }
  return tryParse(text) ?? []; // last resort: the whole response
}

export function extractBlocks(text: string): { malloy?: string; meta?: string } {
  // 1. Tagged ```malloy block (case-insensitive).
  let malloy = text.match(/```[ \t]*malloy[ \t]*\r?\n([\s\S]*?)```/i)?.[1];
  // 2. Truncation salvage: an opener with no closing fence (hit the token cap).
  if (!malloy) {
    const open = text.match(/```[ \t]*malloy[ \t]*\r?\n/i);
    if (open) malloy = text.slice(open.index! + open[0].length);
  }
  // 3. Fall back to the largest fenced block of any/no language.
  if (!malloy) {
    const fences = [...text.matchAll(/```[a-zA-Z]*\r?\n([\s\S]*?)```/g)].map((m) => m[1]);
    if (fences.length) malloy = fences.sort((a, b) => b.length - a.length)[0];
  }
  const meta = text.match(/```[ \t]*ya?ml[ \t]*\r?\n([\s\S]*?)```/i)?.[1];
  return { malloy: malloy?.trim(), meta: meta?.trim() };
}

async function clearLayer(modelsDir: string, metaDir: string): Promise<void> {
  await mkdir(modelsDir, { recursive: true });
  await mkdir(metaDir, { recursive: true });
  for (const dir of [modelsDir, metaDir]) {
    for (const f of await readdir(dir)) await rm(path.join(dir, f));
  }
}

/** Source names declared in a model file — targets the execution smoke test at
 *  the sources this file actually introduces (not inherited ones). */
export function sourceNamesIn(src: string): string[] {
  return [...src.matchAll(/^[ \t]*source:[ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]+is\b/gm)].map((m) => m[1]);
}

/**
 * Compile-check the whole model (describe), AND — when a just-authored file is
 * given — EXECUTE every view of the source(s) that file introduces. A view can
 * COMPILE but fail at execution (e.g. a `join_many ... on` predicate that
 * references another join's alias compiles to SQL with an out-of-scope table →
 * DuckDB "Referenced table not found"). The first execution failure is returned
 * as a diagnostic so the repair loop fixes it. `modelsDir`/`dbPath` default to
 * this repo's layer + the MalloyRuntime default DB (back-compat for callers that
 * pass only a file name).
 */
/** Per-view execution budget during build/repair validation. A view that exceeds
 *  this is almost always an intractable grain (a full cross-join over a large
 *  candidate domain) — fail it FAST so the repair loop fixes it, rather than
 *  wedging the whole build on one query. Generous for legitimate heavy views. */
export const VIEW_VALIDATION_TIMEOUT_MS = 45_000;

export async function validateModel(
  modelFile?: string,
  opts: { modelsDir?: string; dbPath?: string; checkQuality?: boolean } = {},
): Promise<{ ok: boolean; diag: string; smellDiag?: string }> {
  const modelsDir = opts.modelsDir ?? MODELS_DIR;
  const rt = new MalloyRuntime({ ...(opts.dbPath ? { databasePath: opts.dbPath } : {}), modelsDir });
  // With checkQuality, pull enough rows to judge a view's output distribution (the
  // degeneracy detector); otherwise 1 row is enough to prove it executes.
  const cap = opts.checkQuality ? 500 : 1;
  const smellLines: string[] = [];
  try {
    const inv = await rt.describe(); // compile check (throws on compile error)
    if (modelFile && existsSync(path.join(modelsDir, modelFile))) {
      const mine = new Set(sourceNamesIn(await readFile(path.join(modelsDir, modelFile), 'utf8')));
      for (const s of inv.sources) {
        if (!mine.has(s)) continue;
        for (const view of inv.viewsBySource[s] ?? []) {
          const r = await rt.run(`run: ${s} -> ${view}`, cap, VIEW_VALIDATION_TIMEOUT_MS);
          if (!r.ok) {
            const errText = (r.diagnostics ?? []).map((d) => d.message).join('\n');
            // Only the binder/scope class points to the join_many materialization
            // fix — other execution errors (bad function args, type mismatch, …)
            // need their own fix, so lead with the ACTUAL error and only attach the
            // join-scoping hint when the error actually looks like that class.
            const isScopeBug = /referenced table .* not found|not in scope|undefined value|candidate tables/i.test(errText);
            const hint = isScopeBug
              ? ` This is a join-scope bug: a \`join_many ... on\` predicate references attributes reached through ANOTHER join (a pass-through \`dimension: x is m.col\` is just an alias and drops out of SQL scope). FIX: MATERIALIZE those attributes as REAL columns first via a projection — \`source: enriched is base extend { join_one: m is ... } -> { select: *, attr is m.col, ... }\` — then \`join_many\` on \`enriched\`'s local columns, one level deep.`
              : '';
            return {
              ok: false,
              diag: `The view \`${s} -> ${view}\` COMPILES but FAILS TO EXECUTE — a view that cannot run is unusable. Fix the source so this query runs.${hint}\nExecution error:\n${errText}`,
            };
          }
          // Executed OK. With checkQuality, also flag DEGENERATE output (B2): a
          // view that runs but doesn't compute what its name implies (e.g. a
          // ranking where most rows tie at the max because the grain folds in
          // wildcard rows). Advisory — never fails execution; returned separately.
          if (opts.checkQuality) {
            const smells = viewQualitySmells(r.rows ?? []);
            if (smells.length) smellLines.push(smellSummary(`${s} -> ${view}`, smells));
          }
        }
      }
    }
    return { ok: true, diag: '', ...(smellLines.length ? { smellDiag: smellLines.join('\n\n') } : {}) };
  } catch (e) {
    const problems = (e as { problems?: Array<{ message: string }> })?.problems;
    return { ok: false, diag: problems ? problems.map((p) => p.message).join('\n') : e instanceof Error ? e.message : String(e) };
  } finally {
    await rt.close();
  }
}

export async function hashLayerOnDisk(modelsDir: string = MODELS_DIR, metaDir: string = META_DIR): Promise<string> {
  const h = createHash('sha256');
  // Hash BOTH the .malloy models AND their _meta/*.yaml sidecars — the sidecars
  // carry routing/provenance metadata, so a hand-edit there must change the hash too.
  const models = (await readdir(modelsDir)).filter((f) => f.endsWith('.malloy')).sort();
  for (const f of models) {
    h.update(`models/${f}`);
    h.update(await readFile(path.join(modelsDir, f), 'utf8'));
  }
  let metaFiles: string[] = [];
  try {
    metaFiles = (await readdir(metaDir)).filter((f) => f.endsWith('.yaml')).sort();
  } catch {
    /* no _meta dir */
  }
  for (const f of metaFiles) {
    h.update(`_meta/${f}`);
    h.update(await readFile(path.join(metaDir, f), 'utf8'));
  }
  return h.digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// Per-file authoring with a localized repair loop
// ---------------------------------------------------------------------------

interface StageResult {
  ok: boolean;
  diag?: string;
  cost: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
}

async function authorStage(opts: {
  label: string;
  modelFile: string; // e.g. payments_base.malloy
  metaFile: string; // e.g. payments_base.yaml
  defaultExport: { name: string; kind: string };
  defaultDomain: string;
  modelsDir: string;
  metaDir: string;
  dbPath: string;
  model: string;
  reasoningEffort?: string;
  provider?: string;
  system: string;
  user: string;
  maxRounds: number;
  maxTokens?: number;
  runId?: string; // when set, emit controllog build events (model exchanges + compile checks)
}): Promise<StageResult> {
  const agg = { cost: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cacheWriteTokens: 0 };
  let diag: string | undefined; // last compile error
  let current: string | null = null; // last-written malloy (for edit rounds)
  let metaWritten = false;
  let forceFull = false; // set when an edit round produced no applicable edits
  let smellNudged = false; // B2: a degeneracy nudge is given at most once, then accepted

  for (let round = 1; round <= opts.maxRounds; round++) {
    const editMode = round > 1 && current !== null && !forceFull;
    forceFull = false;
    const t0 = Date.now();

    let resp;
    let mode: 'full' | 'edit';
    if (editMode) {
      mode = 'edit';
      resp = await complete({
        model: opts.model,
        systemPrompt: opts.system,
        userPrompt:
          `The file ${opts.modelFile} below FAILED to compile. Make the MINIMAL edits that fix ONLY the listed errors — do NOT rewrite, reorder, or restructure anything else.\n\n` +
          `=== current ${opts.modelFile} ===\n${current}\n\n=== compiler errors ===\n${diag}\n\n` +
          `Return ONLY a JSON array of edits: [{"old":"<text copied VERBATIM from the file, unique>","new":"<replacement>"}]. ` +
          `Each "old" must appear exactly once in the file. Follow the Malloy rules above (typed raw escapes fn!returntype, \`is null\` not \`= null\`, etc.).`,
        reasoningEffort: opts.reasoningEffort,
        provider: opts.provider,
        maxTokens: 8000,
      });
    } else {
      mode = 'full';
      resp = await complete({
        model: opts.model,
        systemPrompt: opts.system,
        userPrompt: diag ? `${opts.user}\n\n## Your previous attempt failed to compile — re-emit a corrected full file:\n${diag}` : opts.user,
        reasoningEffort: opts.reasoningEffort,
        provider: opts.provider,
        maxTokens: opts.maxTokens ?? 36000,
      });
    }
    const wallMs = Date.now() - t0;
    agg.cost += resp.cost ?? 0;
    agg.promptTokens += resp.promptTokens;
    agg.completionTokens += resp.completionTokens;
    agg.cachedTokens += resp.cachedTokens;
    agg.cacheWriteTokens += resp.cacheWriteTokens;

    // Produce the candidate malloy for this round.
    let malloy: string | undefined;
    let meta: string | undefined;
    if (mode === 'edit') {
      const edits = parseEdits(resp.text);
      let patched: string = current as string;
      let applied = 0;
      for (const e of edits) {
        const i = patched.indexOf(e.old);
        if (i >= 0) {
          patched = patched.slice(0, i) + e.new + patched.slice(i + e.old.length);
          applied++;
        }
      }
      if (applied === 0) {
        console.log(`  … ${opts.label} round ${round}: no edits applied — full re-emit next round`);
        forceFull = true;
        continue; // diag unchanged; next round is full
      }
      console.log(`  … ${opts.label} round ${round}: applied ${applied}/${edits.length} edit(s)`);
      malloy = patched;
    } else {
      ({ malloy, meta } = extractBlocks(resp.text));
    }

    if (opts.runId) {
      const ex = cl.newId();
      cl.modelPrompt({ taskId: opts.label, runId: opts.runId, provider: 'openrouter', model: opts.model, promptTokens: resp.promptTokens, exchangeId: ex, role: 'builder', payload: { phase: 'build', stage: opts.label, round, mode } });
      cl.modelCompletion({ taskId: opts.label, runId: opts.runId, provider: 'openrouter', model: opts.model, completionTokens: resp.completionTokens, wallMs, exchangeId: ex, costMoney: resp.cost, role: 'builder', payload: { phase: 'build', stage: opts.label, round, mode, malloy: malloy?.slice(0, 6000) ?? null, response: resp.text.slice(0, 8000), cached_tokens: resp.cachedTokens, cache_write_tokens: resp.cacheWriteTokens } });
    }

    if (!malloy) {
      diag = 'You did not return a ```malloy fenced block. Return exactly one ```malloy block and one ```yaml block.';
      continue;
    }
    // RAW-SQL GATE (hard): the layer must be Malloy-only — `duckdb.sql(...)` is
    // prohibited. Reject BEFORE persisting (an edit can't restructure a SQL block
    // away, so force a full re-author) so a SQL-containing file is never written.
    if (detectRawSqlInMalloy(malloy)) {
      diag =
        'PROHIBITED: this file uses `duckdb.sql(...)` (raw SQL embedded in Malloy). Raw SQL is not allowed in the semantic layer. Re-express the logic in PURE Malloy: joins via `join_one`/`join_many`, a value universe via a Malloy query/source that `group_by`s (or unnests with the typed escape) the column over the base table, and individual DuckDB functions via the typed escape `fn!returntype(...)`. Remove EVERY `duckdb.sql(...)` block and re-emit the full file.';
      console.log(`  ✗ ${opts.label} round ${round} (${mode}): REJECTED — contains duckdb.sql(...) (raw SQL prohibited)`);
      forceFull = true;
      continue;
    }
    await writeFile(path.join(opts.modelsDir, opts.modelFile), malloy + '\n');
    current = malloy;
    if (!metaWritten) {
      const metaYaml =
        meta ??
        `file: ${opts.modelFile}\ndomain: ${opts.defaultDomain}\nsummary: (auto)\nexports:\n  - name: ${opts.defaultExport.name}\n    kind: ${opts.defaultExport.kind}\n    summary: (auto)\n`;
      await writeFile(path.join(opts.metaDir, opts.metaFile), metaYaml + (metaYaml.endsWith('\n') ? '' : '\n'));
      metaWritten = true;
    } else if (meta) {
      await writeFile(path.join(opts.metaDir, opts.metaFile), meta + (meta.endsWith('\n') ? '' : '\n'));
    }

    const cv0 = Date.now();
    const v = await validateModel(opts.modelFile, { modelsDir: opts.modelsDir, dbPath: opts.dbPath, checkQuality: true }); // compile + execute + degeneracy check
    if (opts.runId) {
      const callId = cl.newId();
      cl.toolCall({ taskId: opts.label, runId: opts.runId, name: 'compile_check', callId, arguments: { round, mode }, model: opts.model });
      cl.toolResult({ taskId: opts.label, runId: opts.runId, name: 'compile_check', callId, ok: v.ok, durationMs: Date.now() - cv0, model: opts.model, output: v.ok ? (v.smellDiag ? `ok (degenerate: ${v.smellDiag.slice(0, 400)})` : 'ok') : v.diag.slice(0, 1500) });
    }
    if (v.ok) {
      // B2 + 2A.3: the file executes. Run the deterministic build GATES (general
      // name/structure heuristics over the source) AND the degeneracy smells; if
      // EITHER fires, nudge the author ONCE with the combined diagnostics and force
      // a re-author — but ONLY when a re-author round remains. Both are ADVISORY: a
      // finding that first appears on the final allowed round is ACCEPTED, never
      // converted into a hard build FAILURE (which would block the whole layer
      // regeneration).
      const gateFindings = layerSourceGate(malloy);
      const gateDiag = gateFindings.length
        ? `Build-gate findings (general modeling defects — fix them):\n${gateFindings.map((f) => `  - ${f.message}`).join('\n')}`
        : '';
      const smellHint = v.smellDiag
        ? `${v.smellDiag}\n\nThis is usually a WRONG-GRAIN bug: an aggregate that folds in "applies-to-all"/wildcard rows (which are common to every group and don't discriminate) collapses the ranking. FIX generically: rank/compare by the ENTITY-SPECIFIC rows, or expose BOTH a specific-only and an effective (incl. wildcard) measure so the answer can pick. Re-author this file to fix the degenerate view(s).`
        : '';
      const qualityDiag = [smellHint, gateDiag].filter(Boolean).join('\n\n');
      if (qualityDiag && !smellNudged && round < opts.maxRounds) {
        smellNudged = true;
        forceFull = true;
        diag = qualityDiag;
        console.log(`  ⚠ ${opts.label} round ${round}: quality findings — nudging once:\n${qualityDiag.split('\n').slice(0, 5).map((l) => '      ' + l).join('\n')}`);
        continue;
      }
      console.log(`  ✓ ${opts.label} (round ${round}, ${mode}, $${agg.cost.toFixed(4)})${qualityDiag ? ' [accepted with quality findings]' : ''}`);
      return { ok: true, ...agg };
    }
    console.log(`  ✗ ${opts.label} round ${round} (${mode}) error:\n${v.diag.split('\n').slice(0, 6).map((l) => '      ' + l).join('\n')}`);
    diag = v.diag;
    // An EXECUTION/binder failure needs RESTRUCTURING (move logic across sources),
    // which atomic edits can't do — force a full re-author next round.
    if (v.diag.includes('FAILS TO EXECUTE')) forceFull = true;
  }
  return { ok: false, diag, ...agg };
}

/** Ask the model to decompose the central layer into a small set of focused
 *  source files (model-derived, dependency-first). Returns [] on parse failure
 *  (caller then authors a single top-level file). */
async function planCentral(opts: {
  model: string; reasoningEffort?: string; provider?: string; baseContents: string; context: string; qa: string;
  profiles: string; outputName: string; maxFiles: number; extraGuidance?: string; glossary?: string; runId?: string;
}): Promise<{ files: { file: string; purpose: string }[]; cost: number }> {
  const system = `You are planning the CENTRAL files of a Malloy semantic layer (the base sources, one per table, already exist). Decompose the joins and the analytical needs into a SMALL set (1–${opts.maxFiles}) of FOCUSED intermediate source files — each a \`<name>.malloy\` — so NO single file is huge (each must comfortably fit in one model response) and lineage is clean. Order them DEPENDENCY-FIRST (a later file may reference earlier ones + the bases). Do NOT include the base files. Do NOT include the top-level ${opts.outputName}.malloy (it is added automatically last). Return ONLY a JSON array: [{"file":"<name>.malloy","purpose":"<one line>"}, ...].\n\n${SEMANTIC_LAYER_POLICY}${opts.glossary ?? ''}`;
  const user = `## Base sources\n${opts.baseContents}\n\n## Column profiles (actual encodings + domains — ground truth)\n${opts.profiles}\n\n## Domain context\n${opts.context}\n\n## Example questions to COVER (generalize into reusable concepts — do NOT name files after them)\n${opts.qa}${opts.extraGuidance ? `\n\n## Domain-specific guidance (supplied context)\n${opts.extraGuidance}` : ''}\n\nPlan the intermediate source files now — make sure the decomposition COVERS every glossary concept (a source/view for each).\nJSON array only.`;
  const t0 = Date.now();
  const resp = await complete({ model: opts.model, systemPrompt: system, userPrompt: user, reasoningEffort: opts.reasoningEffort, provider: opts.provider, maxTokens: 4000 });
  if (opts.runId) {
    const ex = cl.newId();
    cl.modelPrompt({ taskId: '__plan__', runId: opts.runId, provider: 'openrouter', model: opts.model, promptTokens: resp.promptTokens, exchangeId: ex, role: 'builder', payload: { phase: 'build', stage: '__plan__', round: 1 } });
    cl.modelCompletion({ taskId: '__plan__', runId: opts.runId, provider: 'openrouter', model: opts.model, completionTokens: resp.completionTokens, wallMs: Date.now() - t0, exchangeId: ex, costMoney: resp.cost, role: 'builder', payload: { phase: 'build', stage: '__plan__', round: 1, malloy: resp.text.slice(0, 4000), cached_tokens: resp.cachedTokens, cache_write_tokens: resp.cacheWriteTokens } });
  }
  try {
    const m = resp.text.match(/\[[\s\S]*\]/);
    const arr = JSON.parse(m ? m[0] : resp.text) as Array<{ file?: string; purpose?: string }>;
    const files = arr
      .filter((x) => x && typeof x.file === 'string')
      .slice(0, opts.maxFiles)
      .map((x) => ({ file: String(x.file), purpose: String(x.purpose ?? '') }));
    return { files, cost: resp.cost ?? 0 };
  } catch {
    return { files: [], cost: resp.cost ?? 0 };
  }
}

// ---------------------------------------------------------------------------
// Orchestration — the GENERIC builder
// ---------------------------------------------------------------------------

export interface QAPair {
  question: string;
  guidelines?: string;
  answer?: string;
}

export interface GenerationPolicy {
  /** include the example answers in the prompt (coverage understanding). The
   *  SEMANTIC_LAYER_POLICY still forbids copying them into the output. Default false. */
  includeAnswers?: boolean;
  /** caller-supplied, dataset-specific modeling hints. NOT baked into the generic
   *  builder — appended verbatim as "supplied context" when present. */
  extraGuidance?: string;
  /** max model-planned intermediate source files. Default 6. */
  maxCentralFiles?: number;
  /** run the ubiquitous-language glossary pass (extract user vocabulary from the
   *  questions, ground it, thread it into authoring so surfaces are named/described
   *  in the user's words). Default true; set false for cheap/smoke builds. */
  glossary?: boolean;
}

export interface LayerBuildConfig {
  /** tables to model. A plain string is treated as both the DuckDB ref and the
   *  identifier; use { ref, name } when the physical name isn't a safe Malloy
   *  identifier (hyphens, spaces, schema-qualified, reserved words, case). */
  tables: TableInput[];
  /** local DuckDB to introspect + compile/execute-validate against. Must exist. */
  dbPath: string;
  /** domain documentation the model reads for terminology/semantics (may be ''). */
  contextMarkdown: string;
  /** example questions for coverage (examples, NOT labels — see policy). */
  qaPairs: QAPair[];
  /** stem of the thin top-level model file (e.g. 'sales' → sales.malloy). */
  outputName: string;
  /** default _meta domain for authored files. */
  domainName: string;
  docs: { primer: string; relationshipDiscovery?: string };
  generationPolicy?: GenerationPolicy;
  model: string;
  reasoningEffort?: string;
  provider?: string;
  maxRounds?: number;
  /** reuse existing *_base.malloy, only (re)author the central files. */
  centralOnly?: boolean;
  modelsDir?: string; // default MODELS_DIR
  metaDir?: string; // default META_DIR
  provenancePath?: string; // default PROVENANCE_PATH
  /** extra fields merged into the written provenance (e.g. {manual_included}). */
  provenanceFields?: Record<string, unknown>;
  runId?: string; // controllog build-run id (emits build events when set)
}

export interface LayerBuildResult {
  ok: boolean;
  malloyModelHash: string;
  files: string[];
  diagnostics?: string;
  cost: number;
}

/** Render example Q/A pairs as numbered, ID-FREE examples (so the model has no
 *  task identifier to copy into the layer — enforces the anti-benchmark policy). */
export function renderQA(pairs: QAPair[], includeAnswers: boolean): string {
  return pairs
    .map((q, i) => `- Example ${i + 1}: ${q.question}${q.guidelines ? `\n  guidelines: ${q.guidelines}` : ''}${includeAnswers && q.answer !== undefined ? `\n  expected: ${q.answer}` : ''}`)
    .join('\n');
}

export async function buildLayer(config: LayerBuildConfig): Promise<LayerBuildResult> {
  const modelsDir = config.modelsDir ?? MODELS_DIR;
  const metaDir = config.metaDir ?? META_DIR;
  const provenancePath = config.provenancePath ?? PROVENANCE_PATH;
  const policy = config.generationPolicy ?? {};
  const maxRounds = config.maxRounds ?? 3;
  const maxCentralFiles = policy.maxCentralFiles ?? 6;
  const { dbPath, outputName, domainName, model } = config;
  // Normalize the table inputs ONCE: each table's physical DuckDB `ref` (auto-
  // quoted for SQL, used verbatim in duckdb.table) is kept distinct from its safe
  // `name` (the Malloy `<name>_base` source, the file stem, and the _meta domain).
  const specs = normalizeTables(config.tables);

  if (!existsSync(dbPath)) {
    throw new Error(`buildLayer: local compile DB not found at ${dbPath} — the caller must create it first.`);
  }
  if (config.runId) {
    cl.runMetadata({
      runId: config.runId,
      resolvedConfig: { phase: 'build', model, output_name: outputName, context_included: config.contextMarkdown.length > 0, central_only: !!config.centralOnly, reasoning: config.reasoningEffort ?? null, provider: config.provider ?? null },
      agentName: 'agent:asm-malloy-builder', datasetName: outputName, datasetVersion: 'layer-build',
    });
  }

  const schema = await schemaByTable(specs, dbPath);
  const profile = await columnProfiles(config.tables, dbPath);
  const allProfiles = specs.map((s) => `### ${s.name}\n${profile[s.name]}`).join('\n\n');
  const context = config.contextMarkdown || '(no domain context supplied)';
  const qa = renderQA(config.qaPairs, policy.includeAnswers ?? false);
  const extra = policy.extraGuidance?.trim() || undefined;
  let totalCost = 0;

  // Ubiquitous-language glossary (closed-book on answers): mine the question
  // VOCABULARY → ground it against the real schema → thread it into authoring so
  // surfaces are NAMED/described in the user's words (the question→layer bridge).
  let glossaryBlock = '';
  let glossaryEntries: GlossaryEntry[] = [];
  if (policy.glossary !== false && config.qaPairs.length) {
    const gx = await extractGlossary({
      model, contextMarkdown: config.contextMarkdown, schema: allProfiles.length ? specs.map((s) => `### ${s.name}\n${schema[s.name]}`).join('\n\n') : '',
      profiles: allProfiles, questions: config.qaPairs.map((q) => q.question),
      reasoningEffort: config.reasoningEffort, provider: config.provider, runId: config.runId,
    });
    totalCost += gx.cost;
    const { grounded, dropped } = await groundGlossary(gx.entries, config.tables, dbPath);
    glossaryEntries = grounded;
    if (dropped.length) console.log(`  glossary: ${grounded.length} concepts (dropped ${dropped.length} ungrounded: ${dropped.map((d) => `"${d.term}"`).slice(0, 5).join(', ')})`);
    else console.log(`  glossary: ${grounded.length} concepts`);
    glossaryBlock = grounded.length ? `\n\n=== UBIQUITOUS-LANGUAGE GLOSSARY (name/describe surfaces in these USER terms; bind concept → grounding → pattern) ===\n${renderGlossary(grounded)}` : '';
  }

  if (config.centralOnly) {
    const missing = specs.filter((s) => !existsSync(path.join(modelsDir, `${s.name}_base.malloy`)));
    if (missing.length) throw new Error(`--central-only needs existing bases; missing: ${missing.map((s) => `${s.name}_base.malloy`).join(', ')}. Run a full layer-build first.`);
    console.log(`layer-build --central-only (model=${model}) — reusing ${specs.length} existing bases\n`);
  } else {
    await clearLayer(modelsDir, metaDir);
    console.log(`layer-build (model=${model}) — incremental, ${specs.length} bases + central\n`);
  }

  const primer = config.docs.primer;
  const discovery = config.docs.relationshipDiscovery;
  const stageDefaults = { modelsDir, metaDir, dbPath, model, reasoningEffort: config.reasoningEffort, provider: config.provider, maxRounds, runId: config.runId };

  // 1. Entity bases (independent: measures + dimensions, NO joins). The Malloy
  //    identifier/file uses the safe `name`; duckdb.table uses the physical `ref`.
  for (const { name, ref } of config.centralOnly ? [] : specs) {
    const system = `You are a Malloy expert writing ONE base source file for the DuckDB table referenced as \`duckdb.table('${ref}')\`: a source named ${name}_base with useful measures + dimensions and NO join logic.\n\n=== MALLOY PRIMER ===\n${primer}\n\n${DUCKDB_NOTES}\n\n${SEMANTIC_LAYER_POLICY}${glossaryBlock}`;
    const user = `## Table schema (DuckDB) for duckdb.table('${ref}')\n${schema[name]}\n\n## Column profile (ACTUAL values in the data — ground truth)\n${profile[name]}\n\n## Domain context (terminology + which measures matter)\n${context}\n\nWrite ${name}_base.malloy now (source named ${name}_base over duckdb.table('${ref}'), measures + dimensions, no joins).`;
    const r = await authorStage({
      ...stageDefaults, label: `${name}_base.malloy`, modelFile: `${name}_base.malloy`, metaFile: `${name}_base.yaml`,
      defaultExport: { name: `${name}_base`, kind: 'source' }, defaultDomain: name, system, user,
    });
    totalCost += r.cost;
    if (!r.ok) return { ok: false, malloyModelHash: await hashLayerOnDisk(modelsDir, metaDir), files: [], diagnostics: `${name}_base: ${r.diag}`, cost: totalCost };
  }

  // 2. Plan the central decomposition (model-derived) — a SMALL set of focused
  //    intermediate source files. Then author each one-at-a-time, then a thin top-level.
  const baseContents = (await Promise.all(specs.map(async (s) => `### ${s.name}_base.malloy\n${await readFile(path.join(modelsDir, `${s.name}_base.malloy`), 'utf8')}`))).join('\n\n');
  const sharedSystem = `You are a Malloy expert building a multi-file semantic layer over the base sources.\n\nInfer the REUSABLE semantic concepts (entities, relationships, measures, dimensions, and the analytical surfaces the examples imply) from the domain context, the SCHEMA, and the COLUMN PROFILE below. Derive join cardinality, matching predicates, and any bucketing from the ACTUAL encodings (lists vs scalars, the real categorical domains), not prose alone. Express joins and bucketing in Malloy (join_*, view:, nest:), not in SQL.\n\nDESIGN FOR THIN ANSWERS: expose results as NAMED, reusable views/measures on the central source so a question is answered by a thin filter+select on top — the answering agent should never need to restate a join or a matching predicate. Identify the hardest recurring question shape and guarantee one named, end-to-end measure/view for it. A matching/aggregating measure that returns 0 or empty over rows you know exist is a BUG (usually a wildcard-encoding or domain mismatch — recheck the profile), not an answer.\n\n=== MALLOY PRIMER ===\n${primer}${discovery ? `\n\n=== RELATIONSHIP / JOIN-CARDINALITY DISCOVERY ===\n${discovery}` : ''}\n\n${DUCKDB_NOTES}${extra ? `\n\n=== DOMAIN-SPECIFIC GUIDANCE (supplied context) ===\n${extra}` : ''}\n\n${SEMANTIC_LAYER_POLICY}${glossaryBlock}`;

  const plan = await planCentral({ model, reasoningEffort: config.reasoningEffort, provider: config.provider, baseContents, context, qa, profiles: allProfiles, outputName, maxFiles: maxCentralFiles, extraGuidance: extra, glossary: glossaryBlock, runId: config.runId });
  totalCost += plan.cost;
  console.log(`  central plan: ${plan.files.length} file(s) — ${plan.files.map((f) => f.file).join(', ') || `(none → single ${outputName}.malloy)`}`);

  // 3. Author each planned intermediate source in order.
  let authored = '';
  for (let i = 0; i < plan.files.length; i++) {
    const stem = `c${i + 1}_${plan.files[i].file.replace(/\.malloy$/, '').replace(/[^a-z0-9_]/gi, '_')}`;
    const modelFile = `${stem}.malloy`;
    const user = `## Base sources\n${baseContents}\n\n## Column profiles (actual encodings + domains — ground truth; prefer over prose)\n${allProfiles}\n\n## Intermediate sources already authored (you may reference these by name)\n${authored || '(none yet)'}\n\n## Domain context\n${context}\n\n## Example questions to COVER (generalize — do NOT cite or name after them)\n${qa}\n\nWrite ${modelFile} now — ONE focused source. Purpose: ${plan.files[i].purpose}\nIt may reference the bases and the already-authored sources by name. Keep it to this one concern.`;
    const r = await authorStage({
      ...stageDefaults, label: modelFile, modelFile, metaFile: `${stem}.yaml`,
      defaultExport: { name: stem, kind: 'source' }, defaultDomain: domainName, system: sharedSystem, user, maxTokens: 36000,
    });
    totalCost += r.cost;
    if (!r.ok) return { ok: false, malloyModelHash: await hashLayerOnDisk(modelsDir, metaDir), files: [], diagnostics: `${modelFile}: ${r.diag}`, cost: totalCost };
    authored += `### ${modelFile}\n${await readFile(path.join(modelsDir, modelFile), 'utf8')}\n\n`;
  }

  // 4. Thin top-level <outputName>.malloy: cross-cutting views/measures.
  const centralUser = `## Base sources\n${baseContents}\n\n## Column profiles (actual encodings + domains — ground truth; prefer over prose)\n${allProfiles}\n\n## Intermediate sources (reference these by name)\n${authored || '(none)'}\n\n## Domain context\n${context}\n\n## Example questions to COVER (generalize — do NOT cite or name after them)\n${qa}\n\nWrite a THIN top-level ${outputName}.malloy: named, REUSABLE views/measures so the questions are answerable by thin per-query Malloy on top of the sources above. Reuse the intermediate sources; do NOT restate their logic. Keep it small.`;
  const central = await authorStage({
    ...stageDefaults, label: `${outputName}.malloy`, modelFile: `${outputName}.malloy`, metaFile: `${outputName}.yaml`,
    defaultExport: { name: outputName, kind: 'model' }, defaultDomain: domainName, system: sharedSystem, user: centralUser, maxTokens: 36000,
  });
  totalCost += central.cost;
  if (!central.ok) return { ok: false, malloyModelHash: await hashLayerOnDisk(modelsDir, metaDir), files: [], diagnostics: `${outputName}: ${central.diag}`, cost: totalCost };

  // 4b. Persist the glossary artifact (hashed into provenance + available to the
  //     answering agent for question→surface mapping), then a SOFT coverage check:
  //     every concept should be addressable by a surface name or _meta text.
  if (glossaryEntries.length) {
    await writeFile(path.join(metaDir, '_glossary.yaml'), JSON.stringify({ glossary: glossaryEntries }, null, 2) + '\n');
    const malloyText = (await Promise.all((await readdir(modelsDir)).filter((f) => f.endsWith('.malloy')).map((f) => readFile(path.join(modelsDir, f), 'utf8')))).join('\n');
    const metaText = (await Promise.all((await readdir(metaDir)).filter((f) => f.endsWith('.yaml') && f !== '_glossary.yaml').map((f) => readFile(path.join(metaDir, f), 'utf8')))).join('\n');
    const corpus = `${malloyText}\n${metaText}`.toLowerCase();
    const tokens = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 3);
    const uncovered = glossaryEntries.filter((e) => ![e.term, ...(e.aliases ?? [])].some((t) => tokens(t).some((tok) => corpus.includes(tok))));
    console.log(uncovered.length
      ? `  glossary coverage: ${glossaryEntries.length - uncovered.length}/${glossaryEntries.length} concepts addressable (gaps: ${uncovered.map((u) => `"${u.term}"`).slice(0, 6).join(', ')})`
      : `  glossary coverage: all ${glossaryEntries.length} concepts addressable`);
  }

  // 5. Provenance marker (so only a model-authored layer can back an official run).
  // --central-only REUSES existing base files (which may have been hand-edited), so it
  // cannot honestly claim the whole layer is freshly model-authored — mark it
  // `central_only` so the official gate refuses it. Only a full build stamps model_authored.
  const hash = await hashLayerOnDisk(modelsDir, metaDir);
  const files = (await readdir(modelsDir)).filter((f) => f.endsWith('.malloy')).sort();
  await writeFile(
    provenancePath,
    JSON.stringify(
      {
        malloy_provenance: config.centralOnly ? 'central_only' : 'model_authored',
        malloy_model_hash: hash,
        context_included: config.contextMarkdown.length > 0,
        authoring_model: model,
        central_only: !!config.centralOnly,
        output_name: outputName,
        built_at: new Date().toISOString(),
        files,
        ...(config.provenanceFields ?? {}),
      },
      null,
      2,
    ) + '\n',
  );
  return { ok: true, malloyModelHash: hash, files, cost: totalCost };
}
