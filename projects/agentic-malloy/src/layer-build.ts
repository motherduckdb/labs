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

const MALLOY_RULES = `CRITICAL Malloy-on-DuckDB rules:
- Reference a table with duckdb.table('payments') — by NAME, never a file path.
- DuckDB list/SQL functions need a TYPED raw escape or Malloy infers the array type and errors: use len!number(fees.aci) = 0 and list_contains!boolean(fees.aci, aci). Plain len()/list_contains() will NOT compile.
- All files are compiled as ONE unit (concatenated), so do NOT use import statements — every source is visible to every other file.
- You MAY use a duckdb.sql("...") source block for enrichment that is awkward in pure Malloy.

Output EXACTLY two fenced blocks and nothing else:
1. A \`\`\`malloy block: the file contents.
2. A \`\`\`yaml block: the _meta sidecar with keys: file, domain, summary, exports (list of {name, kind, summary}), provides_for (list of strings).`;

// ---------------------------------------------------------------------------
// Parsing + filesystem
// ---------------------------------------------------------------------------

function extractBlocks(text: string): { malloy?: string; meta?: string } {
  const malloy = text.match(/```malloy\s*\n([\s\S]*?)```/);
  const meta = text.match(/```ya?ml\s*\n([\s\S]*?)```/);
  return { malloy: malloy?.[1]?.trim(), meta: meta?.[1]?.trim() };
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
  const files = (await readdir(MODELS_DIR)).filter((f) => f.endsWith('.malloy')).sort();
  const h = createHash('sha256');
  for (const f of files) {
    h.update(f);
    h.update(await readFile(path.join(MODELS_DIR, f), 'utf8'));
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
}): Promise<StageResult> {
  const agg = { cost: 0, promptTokens: 0, completionTokens: 0 };
  let repair: string | undefined;
  for (let round = 1; round <= opts.maxRounds; round++) {
    const resp = await complete({
      model: opts.model,
      systemPrompt: opts.system,
      userPrompt: repair ? `${opts.user}\n\n## Your previous attempt failed — FIX and re-emit the full file:\n${repair}` : opts.user,
      reasoningEffort: opts.reasoningEffort,
      maxTokens: 12000,
    });
    agg.cost += resp.cost ?? 0;
    agg.promptTokens += resp.promptTokens;
    agg.completionTokens += resp.completionTokens;

    const { malloy, meta } = extractBlocks(resp.text);
    if (!malloy) {
      repair = 'You did not return a ```malloy fenced block. Return exactly one ```malloy block and one ```yaml block.';
      continue;
    }
    await writeFile(path.join(MODELS_DIR, opts.modelFile), malloy + '\n');
    const metaYaml =
      meta ??
      `file: ${opts.modelFile}\ndomain: ${opts.modelFile.replace(/_base\.malloy$|\.malloy$/, '')}\nsummary: (auto)\nexports:\n  - name: ${opts.defaultExport.name}\n    kind: ${opts.defaultExport.kind}\n    summary: (auto)\n`;
    await writeFile(path.join(META_DIR, opts.metaFile), metaYaml + (metaYaml.endsWith('\n') ? '' : '\n'));

    const { ok, diag } = await validateModel();
    if (ok) {
      console.log(`  ✓ ${opts.label} (round ${round}, $${agg.cost.toFixed(4)})`);
      return { ok: true, ...agg };
    }
    console.log(`  ✗ ${opts.label} round ${round} compile error:\n${diag.split('\n').map((l) => '      ' + l).join('\n')}`);
    repair = diag;
  }
  return { ok: false, diag: repair, ...agg };
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
}): Promise<LayerBuildResult> {
  if (!existsSync(LOCAL_DB_PATH)) {
    console.log('local compile DB missing — building data/dabstep.duckdb …');
    await buildLocalDuckDB();
  }
  const schema = await schemaByTable();
  const manual = opts.includeManual === false ? '(omitted — manual-ablation run)' : await readFile(path.join(DATA_DIR, 'dabstep', 'context', 'manual.md'), 'utf8');
  const qa = await trainQA(opts.includeAnswers ?? true);
  const maxRounds = opts.maxRounds ?? 3;
  let totalCost = 0;

  await clearLayer();
  console.log(`layer-build (model=${opts.model}) — incremental, ${TABLES.length} bases + central\n`);

  // 1. Entity bases (independent: measures + dimensions, NO joins).
  for (const t of TABLES) {
    const system = `You are a Malloy expert writing ONE base source file for the DuckDB table "${t}", per Lloyd Tabb's convention: a source named ${t}_base over duckdb.table('${t}') with useful measures + dimensions and NO join logic.\n\n${MALLOY_RULES}`;
    const user = `## Table "${t}" schema (DuckDB)\n${schema[t]}\n\n## The Merchant Manual (for terminology + which measures matter)\n${manual}\n\nWrite ${t}_base.malloy now (source named ${t}_base, measures + dimensions, no joins).`;
    const r = await authorStage({
      label: `${t}_base.malloy`, modelFile: `${t}_base.malloy`, metaFile: `${t}_base.yaml`,
      defaultExport: { name: `${t}_base`, kind: 'source' },
      model: opts.model, reasoningEffort: opts.reasoningEffort, system, user, maxRounds,
    });
    totalCost += r.cost;
    if (!r.ok) return { ok: false, malloyModelHash: await hashLayerOnDisk(), files: [], diagnostics: `${t}_base: ${r.diag}`, cost: totalCost };
  }

  // 2. Central model: joins (directionality from cardinality) + views for the question shapes.
  const baseContents = (await Promise.all(TABLES.map(async (t) => `### ${t}_base.malloy\n${await readFile(path.join(MODELS_DIR, `${t}_base.malloy`), 'utf8')}`))).join('\n\n');
  const centralSystem = `You are a Malloy expert writing the CENTRAL model dabstep.malloy: it extends the base sources with joins (directionality inferred from cardinality) and named views/measures for the common analytical questions. Reuse the base sources' measures; keep per-query Malloy thin.\n\nFee matching is the hard part: a transaction matches MANY fee rules across 9 dimensions and ALL matching fees SUM (no most-specific-wins); an empty list / NULL in a fee dimension matches anything. fee = fixed_amount + rate/10000 * eur_amount. The 9 dims: card_scheme, account_type, aci, is_credit, intracountry, merchant_category_code, capture_delay, monthly_volume, monthly_fraud_level. Bucket monthly_volume/monthly_fraud_level per merchant per calendar month and capture_delay per the manual.\n\n${MALLOY_RULES}`;
  const centralUser = `## The base sources already authored (visible to your file)\n${baseContents}\n\n## The Merchant Manual\n${manual}\n\n## Train questions the layer must support\n${qa}\n\nWrite dabstep.malloy now: joins + views/measures so the questions above are answerable by thin per-query Malloy on top of this layer.`;
  const central = await authorStage({
    label: 'dabstep.malloy', modelFile: 'dabstep.malloy', metaFile: 'dabstep.yaml',
    defaultExport: { name: 'dabstep', kind: 'model' },
    model: opts.model, reasoningEffort: opts.reasoningEffort, system: centralSystem, user: centralUser, maxRounds,
  });
  totalCost += central.cost;
  if (!central.ok) return { ok: false, malloyModelHash: await hashLayerOnDisk(), files: [], diagnostics: `dabstep: ${central.diag}`, cost: totalCost };

  // 3. Provenance marker (so only a model-authored layer can back an official run).
  const hash = await hashLayerOnDisk();
  const files = (await readdir(MODELS_DIR)).filter((f) => f.endsWith('.malloy')).sort();
  await writeFile(
    PROVENANCE_PATH,
    JSON.stringify(
      {
        malloy_provenance: 'model_authored',
        malloy_model_hash: hash,
        manual_included: opts.includeManual !== false,
        authoring_model: opts.model,
        built_at: new Date().toISOString(),
        files,
      },
      null,
      2,
    ) + '\n',
  );
  return { ok: true, malloyModelHash: hash, files, cost: totalCost };
}
