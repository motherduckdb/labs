/**
 * layer-build — the MODEL-AUTHORED Malloy layer pass. An expensive-tier model
 * reads the DABstep manual + the 26 train Q/A + the table schema and WRITES the
 * semantic layer (malloy/models/*.malloy + malloy/_meta/*.yaml) from scratch.
 * Humans only edit the build prompt / skill, never the emitted layer — that's
 * what makes the official 26/26 `malloy_provenance: model_authored`.
 *
 * Generate -> write -> compile-validate -> repair (a few rounds on compiler
 * diagnostics). Compilation is local (MalloyRuntime); no MotherDuck needed here.
 */
import { readFile, readdir, writeFile, rm, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DuckDBInstance } from '@duckdb/node-api';
import { complete } from './llm-client.js';
import { MalloyRuntime } from './malloy-runtime.js';
import { LOCAL_DB_PATH } from './load.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(REPO_ROOT, 'data');
const MALLOY_DIR = path.join(REPO_ROOT, 'malloy');
const MODELS_DIR = path.join(MALLOY_DIR, 'models');
const META_DIR = path.join(MALLOY_DIR, '_meta');
export const PROVENANCE_PATH = path.join(MALLOY_DIR, '.provenance.json');
const TABLES = ['payments', 'fees', 'merchants', 'acquirer_countries', 'merchant_category_codes'];

interface LayerFiles {
  models: Record<string, string>; // filename -> .malloy content
  meta: Record<string, string>; // filename -> .yaml content
}

async function tableSchemas(): Promise<string> {
  const instance = await DuckDBInstance.create(LOCAL_DB_PATH);
  const conn = await instance.connect();
  const parts: string[] = [];
  try {
    for (const t of TABLES) {
      const r = await conn.runAndReadAll(`DESCRIBE ${t}`);
      const cols = r.getRowObjects().map((row) => `${row.column_name} ${row.column_type}`);
      parts.push(`${t}:\n  ${cols.join('\n  ')}`);
    }
  } finally {
    conn.closeSync();
  }
  return parts.join('\n\n');
}

async function trainQA(includeAnswers: boolean): Promise<string> {
  const trainIds: string[] = JSON.parse(await readFile(path.join(DATA_DIR, 'split.json'), 'utf8')).train_ids;
  const ids = new Set(trainIds.map(String));
  const all = (await readFile(path.join(DATA_DIR, 'dabstep', 'tasks', 'all.jsonl'), 'utf8'))
    .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  const qs = all.filter((q) => ids.has(String(q.task_id)));
  return qs
    .map((q) => `- [${q.task_id}] ${q.question}${q.guidelines ? `\n  guidelines: ${q.guidelines}` : ''}${includeAnswers ? `\n  answer: ${q.answer}` : ''}`)
    .join('\n');
}

const SYSTEM = `You are a Malloy expert building a reusable semantic layer over a payments dataset (DuckDB).
Follow Lloyd Tabb's convention: one file per table named <table>_base.malloy containing a source of the same name with measures + dimensions and NO join logic; then a central dabstep.malloy that adds joins (directionality inferred from cardinality) and views for common queries.

CRITICAL Malloy-on-DuckDB notes:
- Reference a table with duckdb.table('payments') — by NAME, never a file path.
- DuckDB list/SQL functions need a TYPED raw escape or Malloy infers the array type and errors: use len!number(fees.aci) = 0 and list_contains!boolean(fees.aci, aci). Plain len()/list_contains() will NOT compile.
- The files are compiled as ONE unit (concatenated), so do NOT use import statements — every source is visible to every file.
- Fee matching: a transaction matches MANY fee rules across 9 dimensions; ALL matching fees SUM (no most-specific-wins). An empty list / NULL in a fee dimension matches anything. fee = fixed_amount + rate/10000 * eur_amount. The 9 dims: card_scheme, account_type, aci, is_credit, intracountry, merchant_category_code, capture_delay, monthly_volume, monthly_fraud_level. Bucket monthly_volume/monthly_fraud_level per merchant per calendar month and capture_delay per the manual. You MAY use a duckdb.sql("...") source block for enrichment that is awkward in pure Malloy.

Return ONLY a single fenced \`\`\`json block with this exact shape:
{"models": {"payments_base.malloy": "<content>", ...}, "meta": {"payments_base.yaml": "<content>", ...}}
Each _meta/<file>.yaml must have: file, domain, summary, exports (list of {name, kind, summary}), provides_for (list).`;

function buildUserPrompt(schema: string, manual: string, qa: string, repair?: string): string {
  let p = `## Table schema (DuckDB)\n${schema}\n\n## The Merchant Manual\n${manual}\n\n## Train questions to support (author the layer so these are answerable)\n${qa}\n\nAuthor the full layer now.`;
  if (repair) p += `\n\n## Your previous attempt had compile errors — fix them and re-emit the FULL layer:\n${repair}`;
  return p;
}

function parseLayerJson(text: string): LayerFiles {
  const fence = text.match(/```(?:json)?\s*\n([\s\S]*?)```/);
  const raw = fence ? fence[1] : text;
  const obj = JSON.parse(raw) as Partial<LayerFiles>;
  if (!obj.models || typeof obj.models !== 'object') throw new Error('layer JSON missing "models"');
  return { models: obj.models, meta: obj.meta ?? {} };
}

async function writeLayer(files: LayerFiles): Promise<void> {
  // Clear existing model + meta files so the layer is exactly what the model authored.
  await mkdir(MODELS_DIR, { recursive: true });
  await mkdir(META_DIR, { recursive: true });
  for (const dir of [MODELS_DIR, META_DIR]) {
    for (const f of await readdir(dir)) await rm(path.join(dir, f));
  }
  for (const [name, content] of Object.entries(files.models)) await writeFile(path.join(MODELS_DIR, name), content);
  for (const [name, content] of Object.entries(files.meta)) await writeFile(path.join(META_DIR, name), content);
}

function layerHash(files: LayerFiles): string {
  const h = createHash('sha256');
  for (const name of Object.keys(files.models).sort()) h.update(name).update(files.models[name]);
  return h.digest('hex').slice(0, 16);
}

/** Hash the on-disk layer the same way layerHash() does — to detect hand-edits. */
export async function hashLayerOnDisk(): Promise<string> {
  const files = (await readdir(MODELS_DIR)).filter((f) => f.endsWith('.malloy')).sort();
  const h = createHash('sha256');
  for (const f of files) {
    h.update(f);
    h.update(await readFile(path.join(MODELS_DIR, f), 'utf8'));
  }
  return h.digest('hex').slice(0, 16);
}

export interface LayerBuildResult {
  ok: boolean;
  rounds: number;
  malloyModelHash: string;
  diagnostics?: string;
  files: string[];
}

export async function buildLayer(opts: {
  model: string;
  includeManual?: boolean;
  includeAnswers?: boolean;
  maxRounds?: number;
  reasoningEffort?: string;
}): Promise<LayerBuildResult> {
  const schema = await tableSchemas();
  const manual = opts.includeManual === false ? '(omitted — manual-ablation run)' : await readFile(path.join(DATA_DIR, 'dabstep', 'context', 'manual.md'), 'utf8');
  const qa = await trainQA(opts.includeAnswers ?? true);
  const maxRounds = opts.maxRounds ?? 3;

  let repair: string | undefined;
  let lastFiles: LayerFiles | null = null;
  for (let round = 1; round <= maxRounds; round++) {
    console.log(`layer-build round ${round}/${maxRounds} (model=${opts.model}) …`);
    const resp = await complete({
      model: opts.model,
      systemPrompt: SYSTEM,
      userPrompt: buildUserPrompt(schema, manual, qa, repair),
      reasoningEffort: opts.reasoningEffort,
    });
    let files: LayerFiles;
    try {
      files = parseLayerJson(resp.text);
    } catch (e) {
      repair = `Your output did not parse as the required JSON: ${e instanceof Error ? e.message : String(e)}`;
      continue;
    }
    await writeLayer(files);
    lastFiles = files;

    // Validate: the whole concatenated model must compile + bind all sources.
    const rt = new MalloyRuntime();
    let ok = false;
    let diag = '';
    try {
      await rt.describe();
      ok = true;
    } catch (e) {
      const problems = (e as { problems?: Array<{ message: string }> })?.problems;
      diag = problems ? problems.map((p) => p.message).join('\n') : e instanceof Error ? e.message : String(e);
    }
    await rt.close();

    if (ok) {
      const hash = layerHash(files);
      // Provenance marker: this layer was model-authored. `evaluate` reads it so
      // only a model-authored layer can back an official run (a hand-edit that
      // doesn't rewrite this marker still leaves the recorded hash stale, which
      // is detectable). Written next to the layer; gitignored is NOT desired —
      // it travels with the layer.
      await writeFile(
        PROVENANCE_PATH,
        JSON.stringify(
          {
            provenance: 'model_authored',
            malloy_model_hash: hash,
            model: opts.model,
            manual_included: opts.includeManual !== false,
            files: Object.keys(files.models),
            built_at: new Date().toISOString(),
          },
          null,
          2,
        ) + '\n',
      );
      return { ok: true, rounds: round, malloyModelHash: hash, files: Object.keys(files.models) };
    }
    console.log(`  compile failed:\n${diag.split('\n').map((l) => '    ' + l).join('\n')}`);
    repair = diag;
  }
  return {
    ok: false,
    rounds: maxRounds,
    malloyModelHash: lastFiles ? layerHash(lastFiles) : 'none',
    diagnostics: repair,
    files: lastFiles ? Object.keys(lastFiles.models) : [],
  };
}
