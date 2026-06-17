/**
 * layer-build — the MODEL-AUTHORED Malloy layer pass. An expensive-tier model
 * reads the DABstep manual + the 26 train Q/A + table schema and WRITES the
 * semantic layer (malloy/models/*.malloy + malloy/_meta/*.yaml) from scratch.
 * Humans only edit this prompt / skill / code, never the emitted layer — that's
 * what makes the official 26/26 `malloy_provenance: model_authored`.
 *
 * INCREMENTAL: one file per LLM call (per Lloyd's source-per-entity convention),
 * each compiled+validated as it's written, with a localized repair loop. The
 * five `<table>_base.malloy` sources are authored first (independent, no joins),
 * then the central `dabstep.malloy` (joins + views). Each call returns two small
 * fenced blocks (```malloy + ```yaml) — far more robust than one giant JSON.
 */
import { readFile, readdir, writeFile, rm, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DuckDBInstance } from '@duckdb/node-api';
import { complete } from './llm-client.js';
import { MalloyRuntime } from './malloy-runtime.js';
import { LOCAL_DB_PATH, buildLocalDuckDB } from './load.js';
import * as cl from './controllog.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(REPO_ROOT, 'data');
const MALLOY_DIR = path.join(REPO_ROOT, 'malloy');
const MODELS_DIR = path.join(MALLOY_DIR, 'models');
const META_DIR = path.join(MALLOY_DIR, '_meta');
export const PROVENANCE_PATH = path.join(MALLOY_DIR, '.provenance.json');
const TABLES = ['payments', 'fees', 'merchants', 'acquirer_countries', 'merchant_category_codes'];

// ---------------------------------------------------------------------------
// Context gathering
// ---------------------------------------------------------------------------

async function schemaByTable(): Promise<Record<string, string>> {
  const instance = await DuckDBInstance.create(LOCAL_DB_PATH);
  const conn = await instance.connect();
  const out: Record<string, string> = {};
  try {
    for (const t of TABLES) {
      const r = await conn.runAndReadAll(`DESCRIBE ${t}`);
      out[t] = r.getRowObjects().map((row) => `  ${row.column_name} ${row.column_type}`).join('\n');
    }
  } finally {
    conn.closeSync();
  }
  return out;
}

/**
 * Dataset-agnostic COLUMN PROFILE: for every column of every table, report the
 * facts a modeler must verify before writing joins/filters — the truth the
 * build model otherwise can't see (it gets only schema + prose docs). For each
 * column: data type, NULL count, and either its full DISTINCT domain (when
 * low-cardinality — the values a categorical match must reproduce exactly), or
 * a numeric range, or a few samples. For LIST/ARRAY columns, the NULL-vs-empty
 * split — because "applies to all" is usually the empty list, not NULL, and that
 * distinction silently breaks wildcard predicates. Nothing here is task- or
 * DABstep-specific; it's a generic data dictionary computed from the data.
 */
const LOWCARD_MAX = 40; // ≤ this many distinct → enumerate the full domain
const NUMERIC_TYPES = /^(BIGINT|HUGEINT|INTEGER|SMALLINT|TINYINT|UBIGINT|UINTEGER|USMALLINT|UTINYINT|DOUBLE|FLOAT|REAL|DECIMAL|NUMERIC)/i;
function fmtVal(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'string') return `'${v}'`;
  return String(v);
}
export async function columnProfiles(tables: string[] = TABLES, dbPath: string = LOCAL_DB_PATH): Promise<Record<string, string>> {
  const instance = await DuckDBInstance.create(dbPath);
  const conn = await instance.connect();
  const num = (v: unknown) => Number(v as number | bigint);
  const out: Record<string, string> = {};
  try {
    for (const t of tables) {
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
      out[t] = `(${total.toLocaleString()} rows)\n${lines.join('\n')}`;
    }
  } finally {
    conn.closeSync();
  }
  return out;
}

async function trainQA(includeAnswers: boolean): Promise<string> {
  const trainIds: string[] = JSON.parse(await readFile(path.join(DATA_DIR, 'split.json'), 'utf8')).train_ids;
  const ids = new Set(trainIds.map(String));
  const all = (await readFile(path.join(DATA_DIR, 'dabstep', 'tasks', 'all.jsonl'), 'utf8'))
    .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  return all
    .filter((q) => ids.has(String(q.task_id)))
    .map((q) => `- [${q.task_id}] ${q.question}${q.guidelines ? `\n  guidelines: ${q.guidelines}` : ''}${includeAnswers ? `\n  answer: ${q.answer}` : ''}`)
    .join('\n');
}

const DOCS_DIR = path.join(REPO_ROOT, 'docs', 'malloy');
async function readDoc(name: string): Promise<string> {
  return readFile(path.join(DOCS_DIR, name), 'utf8');
}

// DuckDB-specifics the primer doesn't cover + the Malloy-first rule + output format.
const DUCKDB_NOTES = `Malloy-on-DuckDB specifics (in addition to the primer above):
- Reference a table by NAME: \`duckdb.table('payments')\` — never a file path. The model files compile as ONE unit (concatenated), so do NOT use \`import\`; every source sees every other.
- Do NOT redefine an existing table column as a dimension/measure (e.g. \`dimension: merchant is ...\` when a \`merchant\` column exists → "Cannot redefine"). Only ADD derived fields with NEW names.
- ANY DuckDB SQL function the primer doesn't list needs the TYPED raw escape \`fn!returntype(args)\` — e.g. \`list_contains!boolean(fees.aci, aci)\`, \`len!number(fees.aci)\`, \`lpad!string(x, 3, '0')\`, \`strftime!string(d, '%Y')\`, \`make_date!date(y, m, d)\`. Plain \`lpad(...)\`/\`strftime(...)\` fail with "Unknown function". There is no native list-membership operator — use \`list_contains!boolean\` for list columns. Prefer Malloy-native date ops (\`@2023\`, \`.month\`, \`::date\`) over SQL date formatting where possible.
- MALLOY-FIRST (important): express joins, group-bys, filters, and aggregates in MALLOY — \`join_one\`/\`join_many\`, \`view:\`, \`nest:\`, filtered aggregates. Do NOT write joins or group-bys inside \`duckdb.sql(...)\`. Use a \`duckdb.sql("...")\` source ONLY for logic Malloy genuinely cannot express, and keep it minimal.

MODELING DISCIPLINE — verify against the data, never trust prose alone (these are general principles; apply them to ANY dataset):
- A COLUMN PROFILE (per-column type, NULL count, and either the full DISTINCT domain, a numeric range, or samples; for list columns the NULL-vs-empty split) is given for every table below. It is GROUND TRUTH — when the prose docs and the profile disagree about encoding or domain, the profile wins.
- WILDCARD / "applies to all" is a PHYSICAL-ENCODING question, not a prose one. Check the profile: a list/array column almost always encodes "all" as the EMPTY list (\`len!number(col)=0\`), NOT null; a scalar uses NULL. Write the wildcard branch to match what the data actually stores — \`len!number(col)=0 or list_contains!boolean(col, x)\` for a list field, \`col is null or col = x\` for a scalar — and put a wildcard branch on EVERY match field (one unguarded equality silently drops all wildcard rows for that field).
- CATEGORICAL MATCH BY EQUALITY: when you derive/bucket a value to compare (string-equality) against a categorical column, your output labels MUST be EXACTLY that column's distinct values from the profile. NEVER infer the set of buckets from a single documented example — reproduce the full observed domain. If a fact column's raw domain differs from the rule column's domain (the profile shows two different sets), you must transform/bucket the fact value to the rule's exact strings before matching.
- QUALIFY JOIN KEYS: if more than one joined table exposes the same column name, reference it qualified (\`some_source.col\`, not bare \`col\`) or you get a binder/scope error that only surfaces at EXECUTION, not at compile. After authoring a source with joins, mentally run a query THROUGH the join, not just a compile check.
- JOIN_MANY DOUBLE-COUNTS: a \`join_many\` multiplies each base row by the number of matched rows on the other side. Define the per-match measure at the joined grain — \`joined.sum(<expr combining joined columns and base columns>)\` — and NEVER re-aggregate a base-grain column (a volume, a count, an amount) after a join_many, or it is multiplied by the match count. State in the source's _meta which measures are base-grain vs match-grain.
- JOIN_MANY ON-CLAUSE SCOPE (critical, causes execution-only failures): a \`join_many ... on\` predicate must reference ONLY columns physically present on the two sources being joined. Do NOT reference a column reached through ANOTHER join — including a pass-through \`dimension: x is other_join.col\`. A pass-through dimension is just an ALIAS for the joined column, NOT a real column; it often COMPILES but the generated SQL references an out-of-scope alias and FAILS AT EXECUTION ("Referenced table … not found"). FIX (use this exact shape for fact×rule matching): (1) build an enriched fact source with a PROJECTION that turns the needed joined attributes into REAL local columns — \`source: enriched is fact_base extend { join_one: m is dim ... } -> { select: *, acct_type is m.account_type, mcc is m.merchant_category_code, ... }\`; (2) then \`source: matched is enriched extend { join_many: rules on (len!number(rules.x)=0 or list_contains!boolean(rules.x, acct_type)) and ... }\` referencing ONLY \`enriched\`'s local columns. Keep the fan-out exactly ONE join level deep.
- A VIEW THAT COMPILES IS NOT DONE — IT MUST EXECUTE. Every view/measure you author will be run end-to-end at build time; one that compiles but errors at execution (binder/scope) is a FAILED build and will be sent back to you to fix. Author each source so a query through its joins actually returns rows.

Output EXACTLY two fenced blocks and nothing else:
1. A \`\`\`malloy block: the file contents.
2. A \`\`\`yaml block: the _meta sidecar with TOP-LEVEL keys (do NOT nest under a \`_meta:\` key): file, domain, summary, exports (list of {name, kind, summary}), provides_for (list of strings).`;

// ---------------------------------------------------------------------------
// Parsing + filesystem
// ---------------------------------------------------------------------------

/** Parse a JSON array of {old,new} search/replace edits from a repair response. */
function parseEdits(text: string): Array<{ old: string; new: string }> {
  const m = text.match(/\[[\s\S]*\]/);
  try {
    const arr = JSON.parse(m ? m[0] : text) as Array<{ old?: unknown; new?: unknown }>;
    return arr
      .filter((e) => e && typeof e.old === 'string' && typeof e.new === 'string')
      .map((e) => ({ old: e.old as string, new: e.new as string }));
  } catch {
    return [];
  }
}

function extractBlocks(text: string): { malloy?: string; meta?: string } {
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

async function clearLayer(): Promise<void> {
  await mkdir(MODELS_DIR, { recursive: true });
  await mkdir(META_DIR, { recursive: true });
  for (const dir of [MODELS_DIR, META_DIR]) {
    for (const f of await readdir(dir)) await rm(path.join(dir, f));
  }
}

/** Source names declared in a model file — targets the execution smoke test at
 *  the sources this file actually introduces (not inherited ones). */
function sourceNamesIn(src: string): string[] {
  return [...src.matchAll(/^[ \t]*source:[ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]+is\b/gm)].map((m) => m[1]);
}

/**
 * Compile-check the whole model (describe), AND — when a just-authored file is
 * given — EXECUTE every view of the source(s) that file introduces. A view can
 * COMPILE but fail at execution (e.g. a `join_many ... on` predicate that
 * references another join's alias compiles to SQL with an out-of-scope table →
 * DuckDB "Referenced table not found"). Compile-only validation shipped exactly
 * that class of bug, leaving every fee view unusable at answer time. The first
 * execution failure is returned as a diagnostic so the repair loop fixes it.
 */
async function validateModel(modelFile?: string): Promise<{ ok: boolean; diag: string }> {
  const rt = new MalloyRuntime();
  try {
    const inv = await rt.describe(); // compile check (throws on compile error)
    if (modelFile && existsSync(path.join(MODELS_DIR, modelFile))) {
      const mine = new Set(sourceNamesIn(await readFile(path.join(MODELS_DIR, modelFile), 'utf8')));
      for (const s of inv.sources) {
        if (!mine.has(s)) continue;
        for (const view of inv.viewsBySource[s] ?? []) {
          const r = await rt.run(`run: ${s} -> ${view}`, 1);
          if (!r.ok) {
            const errText = (r.diagnostics ?? []).map((d) => d.message).join('\n');
            // Only the binder/scope class points to the join_many materialization
            // fix — other execution errors (bad function args, type mismatch, …)
            // need their own fix, so lead with the ACTUAL error and only attach the
            // join-scoping hint when the error actually looks like that class.
            const isScopeBug = /referenced table .* not found|not in scope|undefined value|candidate tables/i.test(errText);
            const hint = isScopeBug
              ? ` This is a join-scope bug: a \`join_many ... on\` predicate references attributes reached through ANOTHER join (a pass-through \`dimension: x is m.col\` is just an alias and drops out of SQL scope). FIX: MATERIALIZE those attributes as REAL columns first via a projection — \`source: enriched is base extend { join_one: m is ... } -> { select: *, acct is m.account_type, ... }\` — then \`join_many\` on \`enriched\`'s local columns, one level deep.`
              : '';
            return {
              ok: false,
              diag: `The view \`${s} -> ${view}\` COMPILES but FAILS TO EXECUTE — a view that cannot run is unusable. Fix the source so this query runs.${hint}\nExecution error:\n${errText}`,
            };
          }
        }
      }
    }
    return { ok: true, diag: '' };
  } catch (e) {
    const problems = (e as { problems?: Array<{ message: string }> })?.problems;
    return { ok: false, diag: problems ? problems.map((p) => p.message).join('\n') : e instanceof Error ? e.message : String(e) };
  } finally {
    await rt.close();
  }
}

export async function hashLayerOnDisk(): Promise<string> {
  const h = createHash('sha256');
  // Hash BOTH the .malloy models AND their _meta/*.yaml sidecars — the sidecars
  // carry routing/provenance metadata, so a hand-edit there must change the hash too.
  const models = (await readdir(MODELS_DIR)).filter((f) => f.endsWith('.malloy')).sort();
  for (const f of models) {
    h.update(`models/${f}`);
    h.update(await readFile(path.join(MODELS_DIR, f), 'utf8'));
  }
  let metaFiles: string[] = [];
  try {
    metaFiles = (await readdir(META_DIR)).filter((f) => f.endsWith('.yaml')).sort();
  } catch {
    /* no _meta dir */
  }
  for (const f of metaFiles) {
    h.update(`_meta/${f}`);
    h.update(await readFile(path.join(META_DIR, f), 'utf8'));
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
      cl.modelCompletion({ taskId: opts.label, runId: opts.runId, provider: 'openrouter', model: opts.model, completionTokens: resp.completionTokens, wallMs, exchangeId: ex, costMoney: resp.cost, role: 'builder', payload: { phase: 'build', stage: opts.label, round, mode, malloy: malloy?.slice(0, 6000) ?? null, cached_tokens: resp.cachedTokens, cache_write_tokens: resp.cacheWriteTokens } });
    }

    if (!malloy) {
      diag = 'You did not return a ```malloy fenced block. Return exactly one ```malloy block and one ```yaml block.';
      continue;
    }
    await writeFile(path.join(MODELS_DIR, opts.modelFile), malloy + '\n');
    current = malloy;
    if (!metaWritten) {
      const metaYaml =
        meta ??
        `file: ${opts.modelFile}\ndomain: ${opts.modelFile.replace(/_base\.malloy$|\.malloy$/, '')}\nsummary: (auto)\nexports:\n  - name: ${opts.defaultExport.name}\n    kind: ${opts.defaultExport.kind}\n    summary: (auto)\n`;
      await writeFile(path.join(META_DIR, opts.metaFile), metaYaml + (metaYaml.endsWith('\n') ? '' : '\n'));
      metaWritten = true;
    } else if (meta) {
      await writeFile(path.join(META_DIR, opts.metaFile), meta + (meta.endsWith('\n') ? '' : '\n'));
    }

    const cv0 = Date.now();
    const v = await validateModel(opts.modelFile); // compile + execute the file's views
    if (opts.runId) {
      const callId = cl.newId();
      cl.toolCall({ taskId: opts.label, runId: opts.runId, name: 'compile_check', callId, arguments: { round, mode }, model: opts.model });
      cl.toolResult({ taskId: opts.label, runId: opts.runId, name: 'compile_check', callId, ok: v.ok, durationMs: Date.now() - cv0, model: opts.model, output: v.ok ? 'ok' : v.diag.slice(0, 1500) });
    }
    if (v.ok) {
      console.log(`  ✓ ${opts.label} (round ${round}, ${mode}, $${agg.cost.toFixed(4)})`);
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
 *  (caller then authors a single dabstep.malloy). */
async function planCentral(opts: {
  model: string; reasoningEffort?: string; provider?: string; baseContents: string; manual: string; qa: string; profiles: string; runId?: string;
}): Promise<{ files: { file: string; purpose: string }[]; cost: number }> {
  const system = `You are planning the CENTRAL files of a Malloy semantic layer (the base sources, one per table, already exist). Decompose the joins, the fee model, and the analytical needs into a SMALL set (1–5) of FOCUSED intermediate source files — each a \`<name>.malloy\` — so NO single file is huge (each must comfortably fit in one model response) and lineage is clean. Order them DEPENDENCY-FIRST (a later file may reference earlier ones + the bases). Do NOT include the base files. Do NOT include the top-level dabstep.malloy (it is added automatically last). Return ONLY a JSON array: [{"file":"<name>.malloy","purpose":"<one line>"}, ...].`;
  const user = `## Base sources\n${opts.baseContents}\n\n## Column profiles (actual encodings + domains — ground truth)\n${opts.profiles}\n\n## The Merchant Manual\n${opts.manual}\n\n## Train questions the layer must support\n${opts.qa}\n\nPlan the intermediate source files now (JSON array only).`;
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
      .slice(0, 6)
      .map((x) => ({ file: String(x.file), purpose: String(x.purpose ?? '') }));
    return { files, cost: resp.cost ?? 0 };
  } catch {
    return { files: [], cost: resp.cost ?? 0 };
  }
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface LayerBuildResult {
  ok: boolean;
  malloyModelHash: string;
  files: string[];
  diagnostics?: string;
  cost: number;
}

export async function buildLayer(opts: {
  model: string;
  includeManual?: boolean;
  includeAnswers?: boolean;
  maxRounds?: number;
  reasoningEffort?: string;
  centralOnly?: boolean; // reuse existing *_base.malloy, only (re)author dabstep.malloy
  provider?: string; // pin OpenRouter to a single upstream provider
  runId?: string; // controllog build-run id (emits build events when set)
}): Promise<LayerBuildResult> {
  if (!existsSync(LOCAL_DB_PATH)) {
    console.log('local compile DB missing — building data/dabstep.duckdb …');
    await buildLocalDuckDB();
  }
  if (opts.runId) {
    cl.runMetadata({
      runId: opts.runId,
      resolvedConfig: { phase: 'build', model: opts.model, include_manual: opts.includeManual !== false, central_only: !!opts.centralOnly, reasoning: opts.reasoningEffort ?? null, provider: opts.provider ?? null },
      agentName: 'agent:asm-malloy-builder', datasetName: 'agentic_malloy', datasetVersion: 'layer-build',
    });
  }
  const schema = await schemaByTable();
  const profile = await columnProfiles();
  const allProfiles = TABLES.map((t) => `### ${t}\n${profile[t]}`).join('\n\n');
  const manual = opts.includeManual === false ? '(omitted — manual-ablation run)' : await readFile(path.join(DATA_DIR, 'dabstep', 'context', 'manual.md'), 'utf8');
  const qa = await trainQA(opts.includeAnswers ?? true);
  const maxRounds = opts.maxRounds ?? 3;
  let totalCost = 0;

  if (opts.centralOnly) {
    const missing = TABLES.filter((t) => !existsSync(path.join(MODELS_DIR, `${t}_base.malloy`)));
    if (missing.length) throw new Error(`--central-only needs existing bases; missing: ${missing.join(', ')}. Run a full layer-build first.`);
    console.log(`layer-build --central-only (model=${opts.model}) — reusing ${TABLES.length} existing bases\n`);
  } else {
    await clearLayer();
    console.log(`layer-build (model=${opts.model}) — incremental, ${TABLES.length} bases + central\n`);
  }

  const primer = await readDoc('malloy-primer.md');
  const discovery = await readDoc('relationship-discovery.md');

  // 1. Entity bases (independent: measures + dimensions, NO joins).
  for (const t of opts.centralOnly ? [] : TABLES) {
    const system = `You are a Malloy expert writing ONE base source file for the DuckDB table "${t}": a source named ${t}_base over duckdb.table('${t}') with useful measures + dimensions and NO join logic.\n\n=== MALLOY PRIMER ===\n${primer}\n\n${DUCKDB_NOTES}`;
    const user = `## Table "${t}" schema (DuckDB)\n${schema[t]}\n\n## Column profile for "${t}" (ACTUAL values in the data — ground truth)\n${profile[t]}\n\n## The Merchant Manual (for terminology + which measures matter)\n${manual}\n\nWrite ${t}_base.malloy now (source named ${t}_base, measures + dimensions, no joins).`;
    const r = await authorStage({
      label: `${t}_base.malloy`, modelFile: `${t}_base.malloy`, metaFile: `${t}_base.yaml`,
      defaultExport: { name: `${t}_base`, kind: 'source' },
      model: opts.model, reasoningEffort: opts.reasoningEffort, provider: opts.provider, system, user, maxRounds, runId: opts.runId,
    });
    totalCost += r.cost;
    if (!r.ok) return { ok: false, malloyModelHash: await hashLayerOnDisk(), files: [], diagnostics: `${t}_base: ${r.diag}`, cost: totalCost };
  }

  // 2. Plan the central decomposition (model-derived) — a SMALL set of focused
  //    intermediate source files so no single file blows past the output-token cap
  //    (and lineage stays clean). Then author each one-at-a-time, then a thin top-level.
  const baseContents = (await Promise.all(TABLES.map(async (t) => `### ${t}_base.malloy\n${await readFile(path.join(MODELS_DIR, `${t}_base.malloy`), 'utf8')}`))).join('\n\n');
  const sharedSystem = `You are a Malloy expert building a multi-file semantic layer over the base sources.\n\nThe hardest questions need a fact-row × rule-row match with multi-rule fan-out. DERIVE that model yourself from the manual + the SCHEMA + the COLUMN PROFILE below — matching predicates, formula, and any dynamic bucketing follow from the actual encodings (lists vs scalars, the real categorical domains), not the prose alone. Express joins and bucketing in Malloy (join_*, view:, nest:), not in SQL.\n\nDESIGN FOR THIN ANSWERS: expose the analytical results as NAMED views/measures on the central source so each question is answered by a thin filter+select on top — the answering agent should never need to restate a join or a matching predicate. Identify the hardest recurring question shape and guarantee one named, end-to-end measure/view that answers it directly. A matching/aggregating measure that returns 0 or empty over rows you know exist is a BUG (usually a wildcard-encoding or domain mismatch — recheck against the profile), not an answer.\n\n=== MALLOY PRIMER ===\n${primer}\n\n=== RELATIONSHIP / JOIN-CARDINALITY DISCOVERY ===\n${discovery}\n\n${DUCKDB_NOTES}`;

  const plan = await planCentral({ model: opts.model, reasoningEffort: opts.reasoningEffort, provider: opts.provider, baseContents, manual, qa, profiles: allProfiles, runId: opts.runId });
  totalCost += plan.cost;
  console.log(`  central plan: ${plan.files.length} file(s) — ${plan.files.map((f) => f.file).join(', ') || '(none → single dabstep.malloy)'}`);

  // 3. Author each planned intermediate source in order (numeric prefix → the runtime
  //    concatenates them after the bases in dependency order).
  let authored = '';
  for (let i = 0; i < plan.files.length; i++) {
    const stem = `c${i + 1}_${plan.files[i].file.replace(/\.malloy$/, '').replace(/[^a-z0-9_]/gi, '_')}`;
    const modelFile = `${stem}.malloy`;
    const user = `## Base sources\n${baseContents}\n\n## Column profiles (actual encodings + domains — ground truth; prefer over prose)\n${allProfiles}\n\n## Intermediate sources already authored (you may reference these by name)\n${authored || '(none yet)'}\n\n## The Merchant Manual\n${manual}\n\n## Train questions the layer must support\n${qa}\n\nWrite ${modelFile} now — ONE focused source. Purpose: ${plan.files[i].purpose}\nIt may reference the bases and the already-authored sources by name. Keep it to this one concern.`;
    const r = await authorStage({
      label: modelFile, modelFile, metaFile: `${stem}.yaml`, defaultExport: { name: stem, kind: 'source' },
      model: opts.model, reasoningEffort: opts.reasoningEffort, provider: opts.provider, system: sharedSystem, user, maxRounds, maxTokens: 36000, runId: opts.runId,
    });
    totalCost += r.cost;
    if (!r.ok) return { ok: false, malloyModelHash: await hashLayerOnDisk(), files: [], diagnostics: `${modelFile}: ${r.diag}`, cost: totalCost };
    authored += `### ${modelFile}\n${await readFile(path.join(MODELS_DIR, modelFile), 'utf8')}\n\n`;
  }

  // 4. Thin top-level dabstep.malloy: cross-cutting views/measures over the sources above.
  const centralUser = `## Base sources\n${baseContents}\n\n## Column profiles (actual encodings + domains — ground truth; prefer over prose)\n${allProfiles}\n\n## Intermediate sources (reference these by name)\n${authored || '(none)'}\n\n## The Merchant Manual\n${manual}\n\n## Train questions the layer must support\n${qa}\n\nWrite a THIN top-level dabstep.malloy: named views/measures so the questions are answerable by thin per-query Malloy on top of the sources above. Reuse the intermediate sources; do NOT restate their logic. Keep it small.`;
  const central = await authorStage({
    label: 'dabstep.malloy', modelFile: 'dabstep.malloy', metaFile: 'dabstep.yaml',
    defaultExport: { name: 'dabstep', kind: 'model' },
    model: opts.model, reasoningEffort: opts.reasoningEffort, provider: opts.provider, system: sharedSystem, user: centralUser, maxRounds,
    maxTokens: 36000, runId: opts.runId,
  });
  totalCost += central.cost;
  if (!central.ok) return { ok: false, malloyModelHash: await hashLayerOnDisk(), files: [], diagnostics: `dabstep: ${central.diag}`, cost: totalCost };

  // 3. Provenance marker (so only a model-authored layer can back an official run).
  // --central-only REUSES existing base files (which may have been hand-edited), so it
  // cannot honestly claim the whole layer is freshly model-authored — mark it
  // `central_only` so the official gate refuses it. Only a full build stamps model_authored.
  const hash = await hashLayerOnDisk();
  const files = (await readdir(MODELS_DIR)).filter((f) => f.endsWith('.malloy')).sort();
  await writeFile(
    PROVENANCE_PATH,
    JSON.stringify(
      {
        malloy_provenance: opts.centralOnly ? 'central_only' : 'model_authored',
        malloy_model_hash: hash,
        manual_included: opts.includeManual !== false,
        authoring_model: opts.model,
        central_only: !!opts.centralOnly,
        built_at: new Date().toISOString(),
        files,
      },
      null,
      2,
    ) + '\n',
  );
  return { ok: true, malloyModelHash: hash, files, cost: totalCost };
}
