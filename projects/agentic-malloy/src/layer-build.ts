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
- DuckDB list/array functions need a TYPED raw escape (Malloy can't type them): \`len!number(fees.aci) = 0\`, \`list_contains!boolean(fees.aci, aci)\`. There is no native list-membership operator — use these for list-typed columns.
- MALLOY-FIRST (important): express joins, group-bys, filters, and aggregates in MALLOY — \`join_one\`/\`join_many\`, \`view:\`, \`nest:\`, filtered aggregates. Do NOT write joins or group-bys inside \`duckdb.sql(...)\`. Use a \`duckdb.sql("...")\` source ONLY for logic Malloy genuinely cannot express, and keep it minimal.

Output EXACTLY two fenced blocks and nothing else:
1. A \`\`\`malloy block: the file contents.
2. A \`\`\`yaml block: the _meta sidecar with TOP-LEVEL keys (do NOT nest under a \`_meta:\` key): file, domain, summary, exports (list of {name, kind, summary}), provides_for (list of strings).`;

// ---------------------------------------------------------------------------
// Parsing + filesystem
// ---------------------------------------------------------------------------

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

async function validateModel(): Promise<{ ok: boolean; diag: string }> {
  const rt = new MalloyRuntime();
  try {
    await rt.describe();
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
}

async function authorStage(opts: {
  label: string;
  modelFile: string; // e.g. payments_base.malloy
  metaFile: string; // e.g. payments_base.yaml
  defaultExport: { name: string; kind: string };
  model: string;
  reasoningEffort?: string;
  system: string;
  user: string;
  maxRounds: number;
  maxTokens?: number;
  runId?: string; // when set, emit controllog build events (model exchanges + compile checks)
}): Promise<StageResult> {
  const agg = { cost: 0, promptTokens: 0, completionTokens: 0 };
  let repair: string | undefined;
  for (let round = 1; round <= opts.maxRounds; round++) {
    const t0 = Date.now();
    const resp = await complete({
      model: opts.model,
      systemPrompt: opts.system,
      userPrompt: repair ? `${opts.user}\n\n## Your previous attempt failed — FIX and re-emit the full file:\n${repair}` : opts.user,
      reasoningEffort: opts.reasoningEffort,
      maxTokens: opts.maxTokens ?? 36000,
    });
    const wallMs = Date.now() - t0;
    agg.cost += resp.cost ?? 0;
    agg.promptTokens += resp.promptTokens;
    agg.completionTokens += resp.completionTokens;

    const { malloy, meta } = extractBlocks(resp.text);
    if (opts.runId) {
      const ex = cl.newId();
      cl.modelPrompt({ taskId: opts.label, runId: opts.runId, provider: 'openrouter', model: opts.model, promptTokens: resp.promptTokens, exchangeId: ex, role: 'builder', payload: { phase: 'build', stage: opts.label, round } });
      cl.modelCompletion({ taskId: opts.label, runId: opts.runId, provider: 'openrouter', model: opts.model, completionTokens: resp.completionTokens, wallMs, exchangeId: ex, costMoney: resp.cost, role: 'builder', payload: { phase: 'build', stage: opts.label, round, malloy: malloy?.slice(0, 6000) ?? null } });
    }
    if (!malloy) {
      repair = 'You did not return a ```malloy fenced block. Return exactly one ```malloy block and one ```yaml block.';
      continue;
    }
    await writeFile(path.join(MODELS_DIR, opts.modelFile), malloy + '\n');
    const metaYaml =
      meta ??
      `file: ${opts.modelFile}\ndomain: ${opts.modelFile.replace(/_base\.malloy$|\.malloy$/, '')}\nsummary: (auto)\nexports:\n  - name: ${opts.defaultExport.name}\n    kind: ${opts.defaultExport.kind}\n    summary: (auto)\n`;
    await writeFile(path.join(META_DIR, opts.metaFile), metaYaml + (metaYaml.endsWith('\n') ? '' : '\n'));

    const cv0 = Date.now();
    const { ok, diag } = await validateModel();
    if (opts.runId) {
      const callId = cl.newId();
      cl.toolCall({ taskId: opts.label, runId: opts.runId, name: 'compile_check', callId, arguments: { round }, model: opts.model });
      cl.toolResult({ taskId: opts.label, runId: opts.runId, name: 'compile_check', callId, ok, durationMs: Date.now() - cv0, model: opts.model, output: ok ? 'ok' : diag.slice(0, 1500) });
    }
    if (ok) {
      console.log(`  ✓ ${opts.label} (round ${round}, $${agg.cost.toFixed(4)})`);
      return { ok: true, ...agg };
    }
    console.log(`  ✗ ${opts.label} round ${round} compile error:\n${diag.split('\n').map((l) => '      ' + l).join('\n')}`);
    repair = diag;
  }
  return { ok: false, diag: repair, ...agg };
}

/** Ask the model to decompose the central layer into a small set of focused
 *  source files (model-derived, dependency-first). Returns [] on parse failure
 *  (caller then authors a single dabstep.malloy). */
async function planCentral(opts: {
  model: string; reasoningEffort?: string; baseContents: string; manual: string; qa: string; runId?: string;
}): Promise<{ files: { file: string; purpose: string }[]; cost: number }> {
  const system = `You are planning the CENTRAL files of a Malloy semantic layer (the base sources, one per table, already exist). Decompose the joins, the fee model, and the analytical needs into a SMALL set (1–5) of FOCUSED intermediate source files — each a \`<name>.malloy\` — so NO single file is huge (each must comfortably fit in one model response) and lineage is clean. Order them DEPENDENCY-FIRST (a later file may reference earlier ones + the bases). Do NOT include the base files. Do NOT include the top-level dabstep.malloy (it is added automatically last). Return ONLY a JSON array: [{"file":"<name>.malloy","purpose":"<one line>"}, ...].`;
  const user = `## Base sources\n${opts.baseContents}\n\n## The Merchant Manual\n${opts.manual}\n\n## Train questions the layer must support\n${opts.qa}\n\nPlan the intermediate source files now (JSON array only).`;
  const t0 = Date.now();
  const resp = await complete({ model: opts.model, systemPrompt: system, userPrompt: user, reasoningEffort: opts.reasoningEffort, maxTokens: 4000 });
  if (opts.runId) {
    const ex = cl.newId();
    cl.modelPrompt({ taskId: '__plan__', runId: opts.runId, provider: 'openrouter', model: opts.model, promptTokens: resp.promptTokens, exchangeId: ex, role: 'builder', payload: { phase: 'build', stage: '__plan__', round: 1 } });
    cl.modelCompletion({ taskId: '__plan__', runId: opts.runId, provider: 'openrouter', model: opts.model, completionTokens: resp.completionTokens, wallMs: Date.now() - t0, exchangeId: ex, costMoney: resp.cost, role: 'builder', payload: { phase: 'build', stage: '__plan__', round: 1, malloy: resp.text.slice(0, 4000) } });
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
  runId?: string; // controllog build-run id (emits build events when set)
}): Promise<LayerBuildResult> {
  if (!existsSync(LOCAL_DB_PATH)) {
    console.log('local compile DB missing — building data/dabstep.duckdb …');
    await buildLocalDuckDB();
  }
  if (opts.runId) {
    cl.runMetadata({
      runId: opts.runId,
      resolvedConfig: { phase: 'build', model: opts.model, include_manual: opts.includeManual !== false, central_only: !!opts.centralOnly, reasoning: opts.reasoningEffort ?? null },
      agentName: 'agent:asm-malloy-builder', datasetName: 'agentic_malloy', datasetVersion: 'layer-build',
    });
  }
  const schema = await schemaByTable();
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
    const user = `## Table "${t}" schema (DuckDB)\n${schema[t]}\n\n## The Merchant Manual (for terminology + which measures matter)\n${manual}\n\nWrite ${t}_base.malloy now (source named ${t}_base, measures + dimensions, no joins).`;
    const r = await authorStage({
      label: `${t}_base.malloy`, modelFile: `${t}_base.malloy`, metaFile: `${t}_base.yaml`,
      defaultExport: { name: `${t}_base`, kind: 'source' },
      model: opts.model, reasoningEffort: opts.reasoningEffort, system, user, maxRounds, runId: opts.runId,
    });
    totalCost += r.cost;
    if (!r.ok) return { ok: false, malloyModelHash: await hashLayerOnDisk(), files: [], diagnostics: `${t}_base: ${r.diag}`, cost: totalCost };
  }

  // 2. Plan the central decomposition (model-derived) — a SMALL set of focused
  //    intermediate source files so no single file blows past the output-token cap
  //    (and lineage stays clean). Then author each one-at-a-time, then a thin top-level.
  const baseContents = (await Promise.all(TABLES.map(async (t) => `### ${t}_base.malloy\n${await readFile(path.join(MODELS_DIR, `${t}_base.malloy`), 'utf8')}`))).join('\n\n');
  const sharedSystem = `You are a Malloy expert building a multi-file semantic layer over the base sources.\n\nThe fee questions are the hardest. DERIVE the fee model yourself from the manual's fee section + the schema — matching, formula, and dynamic-dimension bucketing are all defined there. Express joins and per-merchant/per-month bucketing in Malloy (join_*, view:, nest:), not in SQL.\n\n=== MALLOY PRIMER ===\n${primer}\n\n=== RELATIONSHIP / JOIN-CARDINALITY DISCOVERY ===\n${discovery}\n\n${DUCKDB_NOTES}`;

  const plan = await planCentral({ model: opts.model, reasoningEffort: opts.reasoningEffort, baseContents, manual, qa, runId: opts.runId });
  totalCost += plan.cost;
  console.log(`  central plan: ${plan.files.length} file(s) — ${plan.files.map((f) => f.file).join(', ') || '(none → single dabstep.malloy)'}`);

  // 3. Author each planned intermediate source in order (numeric prefix → the runtime
  //    concatenates them after the bases in dependency order).
  let authored = '';
  for (let i = 0; i < plan.files.length; i++) {
    const stem = `c${i + 1}_${plan.files[i].file.replace(/\.malloy$/, '').replace(/[^a-z0-9_]/gi, '_')}`;
    const modelFile = `${stem}.malloy`;
    const user = `## Base sources\n${baseContents}\n\n## Intermediate sources already authored (you may reference these by name)\n${authored || '(none yet)'}\n\n## The Merchant Manual\n${manual}\n\n## Train questions the layer must support\n${qa}\n\nWrite ${modelFile} now — ONE focused source. Purpose: ${plan.files[i].purpose}\nIt may reference the bases and the already-authored sources by name. Keep it to this one concern.`;
    const r = await authorStage({
      label: modelFile, modelFile, metaFile: `${stem}.yaml`, defaultExport: { name: stem, kind: 'source' },
      model: opts.model, reasoningEffort: opts.reasoningEffort, system: sharedSystem, user, maxRounds, maxTokens: 36000, runId: opts.runId,
    });
    totalCost += r.cost;
    if (!r.ok) return { ok: false, malloyModelHash: await hashLayerOnDisk(), files: [], diagnostics: `${modelFile}: ${r.diag}`, cost: totalCost };
    authored += `### ${modelFile}\n${await readFile(path.join(MODELS_DIR, modelFile), 'utf8')}\n\n`;
  }

  // 4. Thin top-level dabstep.malloy: cross-cutting views/measures over the sources above.
  const centralUser = `## Base sources\n${baseContents}\n\n## Intermediate sources (reference these by name)\n${authored || '(none)'}\n\n## The Merchant Manual\n${manual}\n\n## Train questions the layer must support\n${qa}\n\nWrite a THIN top-level dabstep.malloy: named views/measures so the questions are answerable by thin per-query Malloy on top of the sources above. Reuse the intermediate sources; do NOT restate their logic. Keep it small.`;
  const central = await authorStage({
    label: 'dabstep.malloy', modelFile: 'dabstep.malloy', metaFile: 'dabstep.yaml',
    defaultExport: { name: 'dabstep', kind: 'model' },
    model: opts.model, reasoningEffort: opts.reasoningEffort, system: sharedSystem, user: centralUser, maxRounds,
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
