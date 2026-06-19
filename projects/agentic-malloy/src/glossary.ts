/**
 * glossary — the "ubiquitous-language" pass. A closed-book bridge between three
 * languages: USER words (mined from the example questions) ↔ MANUAL concepts
 * (semantics) ↔ PHYSICAL grounding (columns/derivations). It's how question
 * vocabulary makes its way into the built layer so the answering agent can map a
 * question to the right surface — WITHOUT cheating (no "for Q1234 use view X";
 * concept-level only, never answers or task ids).
 *
 * Pipeline: EXTRACT (model, from manual+schema+profile+question TEXT — never
 * answers) → GROUND (deterministic: every concept must bind to a real
 * column/table or it's a hallucination → dropped) → [bind/cover/surface wired
 * into buildLayer in a later step]. This file is the extract + ground core.
 *
 * Anti-cheat boundary — the decisive test: *would this entry be identical if we'd
 * been handed a different question set using the same vocabulary?* If yes →
 * general (keep). If it encodes a specific question's params/answer → overfit.
 * Enforced by: concept-level prompt, the grounding gate, and "parameterize don't
 * specialize" (a "fee at €50k" concept becomes fee_at_notional(amount)).
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { complete } from './llm-client.js';
import { normalizeTables, type TableInput } from './table-spec.js';
import * as cl from './controllog.js';

/** The on-disk glossary artifact filename (under the layer's _meta dir). */
export const GLOSSARY_FILE = '_glossary.yaml';

export type ConceptKind = 'entity' | 'measure' | 'dimension' | 'filter' | 'scenario' | 'operation';

export interface GlossaryEntry {
  /** the canonical user phrasing (from the questions). */
  term: string;
  /** other phrasings users employ for the same concept. */
  aliases?: string[];
  kind: ConceptKind;
  /** what it means, grounded in the manual. */
  definition: string;
  grounding: {
    /** physical tables involved (DuckDB names). */
    tables?: string[];
    /** physical columns, "table.column" or bare "column". */
    columns?: string[];
    /** how the concept is computed from those columns (prose, parameterized). */
    derivation?: string;
  };
  /** the generalizable "how" — the modeling pattern (counterfactual override,
   *  wildcard-strata, notional parameter). This is what makes a scenario concept
   *  reusable instead of one-off. */
  modeling_pattern?: string;
  /** the granularities users slice it at (e.g. "per-MCC", "scheme × is_credit"). */
  user_granularity?: string[];
}

// ---------------------------------------------------------------------------
// EXTRACT
// ---------------------------------------------------------------------------

const GLOSSARY_SYSTEM = `You are building the UBIQUITOUS-LANGUAGE GLOSSARY for a semantic data layer: the bridge between how USERS talk (the example questions) and the underlying data (schema + manual). Extract the reusable domain CONCEPTS the questions reference and how users NAME them.

For each concept return: the canonical user term, aliases (other phrasings), a kind (entity|measure|dimension|filter|scenario|operation), a definition grounded in the manual, the physical grounding (tables + columns + a parameterized derivation), an optional modeling_pattern (the reusable "how" — e.g. "counterfactual override join", "wildcard rows are common to all groups; expose specific + effective grains", "fee at a parameterizable notional"), and the user_granularity (how users slice it).

HARD RULES:
- CONCEPT-LEVEL ONLY. Never reference a specific question, a task id, or any answer value. You are NOT given answers and must not infer them.
- PARAMETERIZE, DON'T SPECIALIZE. A concept like "fee at €50,000" is "fee at a notional amount (parameter)", never a 50000 constant. Specific values in questions are example inputs, not concepts.
- GROUND EVERYTHING. Every concept must bind to real schema columns/tables (or a derivation over them). Do not invent concepts with no physical basis.
- Prefer concepts that recur across multiple questions (core vocabulary) but include important singletons generalized.

Return ONLY a JSON array of concept objects with keys: term, aliases, kind, definition, grounding {tables, columns, derivation}, modeling_pattern, user_granularity.`;

export async function extractGlossary(opts: {
  model: string;
  contextMarkdown: string;
  schema: string; // rendered table schemas
  profiles: string; // rendered column profiles
  questions: string[]; // question TEXT ONLY — never answers
  reasoningEffort?: string;
  provider?: string;
  runId?: string;
}): Promise<{ entries: GlossaryEntry[]; cost: number; raw: string }> {
  const qBlock = opts.questions.map((q, i) => `- Example ${i + 1}: ${q}`).join('\n');
  const user = `## Domain context (manual)\n${opts.contextMarkdown || '(none)'}\n\n## Table schemas\n${opts.schema}\n\n## Column profiles (actual encodings/domains — ground truth)\n${opts.profiles}\n\n## Example questions (USER LANGUAGE — mine the vocabulary; do NOT cite or specialize to any one)\n${qBlock}\n\nReturn the glossary JSON array now.`;
  const t0 = Date.now();
  const resp = await complete({ model: opts.model, systemPrompt: GLOSSARY_SYSTEM, userPrompt: user, reasoningEffort: opts.reasoningEffort, provider: opts.provider, maxTokens: 20000 });
  if (opts.runId) {
    const ex = cl.newId();
    cl.modelPrompt({ taskId: '__glossary__', runId: opts.runId, provider: 'openrouter', model: opts.model, promptTokens: resp.promptTokens, exchangeId: ex, role: 'builder', payload: { phase: 'build', stage: '__glossary__', round: 1 } });
    cl.modelCompletion({ taskId: '__glossary__', runId: opts.runId, provider: 'openrouter', model: opts.model, completionTokens: resp.completionTokens, wallMs: Date.now() - t0, exchangeId: ex, costMoney: resp.cost, role: 'builder', payload: { phase: 'build', stage: '__glossary__', round: 1, malloy: resp.text.slice(0, 6000), cached_tokens: resp.cachedTokens, cache_write_tokens: resp.cacheWriteTokens } });
  }
  return { entries: parseGlossary(resp.text), cost: resp.cost ?? 0, raw: resp.text };
}

/** Salvage complete top-level `{...}` objects from an array body — brace-matched
 *  and string-aware, so a TRUNCATED response (hit the token cap mid-array, no
 *  closing `]`) still yields every complete entry, dropping only the partial tail. */
function salvageObjects(s: string): unknown[] {
  const out: unknown[] = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{') { if (depth === 0) start = i; depth++; }
    else if (ch === '}') { depth--; if (depth === 0 && start >= 0) { try { out.push(JSON.parse(s.slice(start, i + 1))); } catch { /* skip */ } start = -1; } }
  }
  return out;
}

/** Parse + sanitize the model's JSON glossary. Tolerant of a leading ```json
 *  fence and of TRUNCATION (a verbose glossary that overflows the token cap) —
 *  falls back to salvaging the complete objects. Drops malformed entries. Pure. */
export function parseGlossary(text: string): GlossaryEntry[] {
  // Strip a leading code fence so the array index is found cleanly.
  const fenced = text.match(/```[a-zA-Z]*\r?\n([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('[');
  const arrText = start >= 0 ? body.slice(start) : body;
  let arr: unknown;
  try {
    arr = JSON.parse(arrText);
  } catch {
    arr = null; // likely truncated (no closing ]) — salvage below
  }
  if (!Array.isArray(arr)) arr = salvageObjects(arrText);
  const kinds: ConceptKind[] = ['entity', 'measure', 'dimension', 'filter', 'scenario', 'operation'];
  const out: GlossaryEntry[] = [];
  for (const e of arr as Array<Record<string, unknown>>) {
    if (!e || typeof e.term !== 'string' || !e.term.trim()) continue;
    const g = (e.grounding ?? {}) as Record<string, unknown>;
    const strArr = (v: unknown): string[] | undefined =>
      Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => (x as string).trim()) : undefined;
    out.push({
      term: e.term.trim(),
      aliases: strArr(e.aliases),
      kind: kinds.includes(e.kind as ConceptKind) ? (e.kind as ConceptKind) : 'entity',
      definition: typeof e.definition === 'string' ? e.definition.trim() : '',
      grounding: { tables: strArr(g.tables), columns: strArr(g.columns), derivation: typeof g.derivation === 'string' ? g.derivation.trim() : undefined },
      modeling_pattern: typeof e.modeling_pattern === 'string' ? e.modeling_pattern.trim() : undefined,
      user_granularity: strArr(e.user_granularity),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// GROUND — the honesty gate: an entry must bind to a real column/table.
// ---------------------------------------------------------------------------

export interface KnownSchema {
  /** lowercased "table.column" AND bare "column" forms. */
  columns: Set<string>;
  /** lowercased table names. */
  tables: Set<string>;
}

/** Does an entry's grounding resolve against the real schema? An entry must name
 *  at least one real column or table — otherwise it's a hallucinated concept.
 *  Pure + case-insensitive. */
export function groundingResolves(entry: GlossaryEntry, known: KnownSchema): boolean {
  const norm = (s: string) => s.trim().toLowerCase();
  const cols = entry.grounding.columns ?? [];
  // known.columns holds BOTH qualified "table.col" AND bare "col" forms. A
  // QUALIFIED ref must match the exact "table.col" (so a wrong qualifier like
  // orders.amount can't pass off a bare amount elsewhere); an UNQUALIFIED ref
  // matches the bare form. A single membership check does both.
  if (cols.length) {
    // Columns WERE supplied → at least one must be real. A real TABLE name does
    // NOT rescue fake columns (a concept claiming fees.loyalty_tier is
    // hallucinated even though `fees` exists).
    return cols.some((c) => known.columns.has(norm(c)));
  }
  // No columns supplied → an entity-level concept grounded by a real table is OK.
  return (entry.grounding.tables ?? []).some((t) => known.tables.has(norm(t)));
}

/** Introspect the DB to build the KnownSchema (table + column names). */
export async function knownSchemaOf(tables: TableInput[], dbPath: string): Promise<KnownSchema> {
  const specs = normalizeTables(tables);
  const instance = await DuckDBInstance.create(dbPath);
  const conn = await instance.connect();
  const columns = new Set<string>();
  const tableSet = new Set<string>();
  try {
    for (const { name, quoted } of specs) {
      tableSet.add(name.toLowerCase());
      const cols = (await conn.runAndReadAll(`DESCRIBE ${quoted}`)).getRowObjects();
      for (const c of cols) {
        const col = String(c.column_name).toLowerCase();
        columns.add(col);
        columns.add(`${name.toLowerCase()}.${col}`);
      }
    }
  } finally {
    conn.closeSync();
  }
  return { columns, tables: tableSet };
}

/** Keep only entries that ground; return them plus the dropped (hallucinated) ones. */
export async function groundGlossary(
  entries: GlossaryEntry[],
  tables: TableInput[],
  dbPath: string,
): Promise<{ grounded: GlossaryEntry[]; dropped: GlossaryEntry[] }> {
  const known = await knownSchemaOf(tables, dbPath);
  const grounded: GlossaryEntry[] = [];
  const dropped: GlossaryEntry[] = [];
  for (const e of entries) (groundingResolves(e, known) ? grounded : dropped).push(e);
  return { grounded, dropped };
}

// ---------------------------------------------------------------------------
// RENDER — for threading into authoring prompts + (later) the _glossary artifact.
// ---------------------------------------------------------------------------

/** A compact prompt block binding user terms → concept → grounding → pattern, so
 *  the author NAMES/describes surfaces in the user's language. */
export function renderGlossary(entries: GlossaryEntry[]): string {
  if (!entries.length) return '(no glossary)';
  return entries
    .map((e) => {
      const aliases = e.aliases?.length ? ` (aka ${e.aliases.join(', ')})` : '';
      const cols = e.grounding.columns?.length ? ` cols: ${e.grounding.columns.join(', ')}.` : '';
      const der = e.grounding.derivation ? ` derivation: ${e.grounding.derivation}.` : '';
      const pat = e.modeling_pattern ? ` PATTERN: ${e.modeling_pattern}.` : '';
      const gran = e.user_granularity?.length ? ` granularity: ${e.user_granularity.join('; ')}.` : '';
      return `- "${e.term}"${aliases} [${e.kind}] — ${e.definition}${cols}${der}${pat}${gran}`;
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// LOAD / SURFACE — the artifact the answering agent reads to map a question's
// vocabulary to the right layer concept + modeling pattern.
// ---------------------------------------------------------------------------

/** Read the persisted glossary artifact (written by buildLayer). Tolerant: the
 *  file is JSON-in-`.yaml` under a `glossary:` key; returns [] if absent/unreadable. */
export async function loadGlossaryArtifact(metaDir: string): Promise<GlossaryEntry[]> {
  const p = path.join(metaDir, GLOSSARY_FILE);
  if (!existsSync(p)) return [];
  try {
    const obj = JSON.parse(await readFile(p, 'utf8')) as { glossary?: unknown };
    return Array.isArray(obj.glossary) ? parseGlossary(JSON.stringify(obj.glossary)) : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// VOCABULARY GAP — closed-book: does the layer SPEAK a question's language? A
// question content-word that appears in neither the glossary nor any surface name
// is a coverage gap (the layer doesn't model that concept in the user's words).
// Used by layer-improve to distinguish "agent fumbled" from "layer can't be found
// in these words." Uses question text + the layer's OWN vocabulary, never gold.
// ---------------------------------------------------------------------------

// Generic English + question/aggregation function words — NOT domain nouns (those
// are concepts: present in the glossary → covered, absent → a real gap).
const VOCAB_STOPWORDS = new Set([
  'what', 'whats', 'which', 'how', 'many', 'much', 'list', 'show', 'give', 'find', 'tell', 'name', 'names',
  'the', 'and', 'are', 'for', 'with', 'from', 'that', 'this', 'these', 'those', 'was', 'were', 'has', 'have', 'had', 'does', 'did',
  'average', 'avg', 'total', 'sum', 'count', 'number', 'value', 'values', 'amount', 'most', 'least', 'highest', 'lowest',
  'top', 'bottom', 'maximum', 'minimum', 'more', 'less', 'than', 'over', 'under', 'between', 'each', 'per', 'all', 'any',
  'only', 'same', 'different', 'across', 'during', 'within', 'about', 'into', 'would', 'should', 'could', 'will', 'their', 'there',
]);

/** Significant content tokens of a string (lowercased, length ≥ 3, non-stopword,
 *  deduped) — keeps short domain codes like "aci"/"mcc". Pure. */
export function contentTokens(s: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of s.toLowerCase().matchAll(/[a-z0-9]+/g)) {
    const t = m[0];
    if (t.length < 3 || VOCAB_STOPWORDS.has(t) || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/** The layer's known vocabulary: tokens from glossary terms/aliases + surface
 *  (source/view/measure) names. Pure. */
export function buildLayerVocabulary(entries: GlossaryEntry[], surfaceNames: string[] = []): Set<string> {
  const vocab = new Set<string>();
  const add = (s: string) => { for (const t of contentTokens(s)) vocab.add(t); };
  for (const e of entries) { add(e.term); (e.aliases ?? []).forEach(add); }
  for (const n of surfaceNames) add(n);
  return vocab;
}

/** Question content-words absent from the layer's vocabulary (a coverage gap),
 *  plus the coverage fraction. Pure. */
export function questionVocabularyGap(question: string, vocab: Set<string>): { uncovered: string[]; coverage: number } {
  const toks = contentTokens(question);
  if (!toks.length) return { uncovered: [], coverage: 1 };
  const uncovered = toks.filter((t) => !vocab.has(t));
  return { uncovered, coverage: (toks.length - uncovered.length) / toks.length };
}

/** A concise answering-side block: question terms → concept + the surface-finding
 *  hint, so the agent maps a question to the right view via shared vocabulary. */
export function renderGlossaryForAnswering(entries: GlossaryEntry[]): string {
  if (!entries.length) return '';
  const lines = entries.map((e) => {
    const aliases = e.aliases?.length ? ` / ${e.aliases.join(' / ')}` : '';
    const pat = e.modeling_pattern ? ` — ${e.modeling_pattern}` : '';
    return `- "${e.term}"${aliases} [${e.kind}]: ${e.definition}${pat}`;
  });
  return `When a question uses one of these terms, it refers to the matching CONCEPT — find the layer source/view/measure that models it (its _meta describes it in these words) and reuse it; don't re-derive. For a 'scenario' concept, follow its modeling pattern.\n${lines.join('\n')}`;
}
