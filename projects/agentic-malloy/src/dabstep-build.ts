/**
 * dabstep-build — the DABstep-SPECIFIC configuration for the generic Malloy
 * layer builder (layer-build.ts). Everything that ties a build to DABstep lives
 * here, NOT in the generic builder: the table list, the Merchant Manual as the
 * domain context, the train-split Q/A as coverage examples, the fee-model /
 * wildcard-matching domain guidance (supplied as context, not baked into the
 * builder), the docs, the output name `dabstep`, and ensuring the local DuckDB.
 *
 * `buildDabstepLayer()` assembles a `LayerBuildConfig` and calls `buildLayer()`.
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { buildLayer, readDoc, DATA_DIR, type LayerBuildResult, type QAPair } from './layer-build.js';
import { LOCAL_DB_PATH, buildLocalDuckDB } from './load.js';

export const DABSTEP_TABLES = ['payments', 'fees', 'merchants', 'acquirer_countries', 'merchant_category_codes'];

/** DABstep-specific modeling hints (the fee-model / wildcard-matching shape).
 *  These are SUPPLIED CONTEXT for DABstep — they are deliberately NOT part of the
 *  generic builder's prompts. They describe a general fact-row × rule-row matching
 *  pattern without citing any task or gold answer. */
const DABSTEP_DOMAIN_GUIDANCE = `This dataset's hardest questions need a fact-row × rule-row match with multi-rule fan-out (each fact row can match several rule rows, and the applicable rules are summed/aggregated). DERIVE that model from the domain context + the SCHEMA + the COLUMN PROFILE — the matching predicates, the formula, and any dynamic bucketing follow from the actual encodings (lists vs scalars, the real categorical domains), not the prose alone. Several match fields use wildcard encodings (an empty list or NULL = "applies to all"); every match field needs a wildcard branch. Expose the per-fact and aggregated results as reusable named views/measures so questions are a thin filter+select on top.`;

/** The DABstep manual (domain context), or '' for an ablation run. */
export async function loadDabstepContext(includeManual: boolean): Promise<string> {
  if (!includeManual) return '';
  return readFile(path.join(DATA_DIR, 'dabstep', 'context', 'manual.md'), 'utf8');
}

/** The train-split Q/A as coverage examples (NO task ids/answers leak into the
 *  layer — the generic builder renders these ID-free and the policy forbids
 *  copying them). `answer` is carried so a caller MAY include it for coverage. */
export async function loadDabstepTrainQA(): Promise<QAPair[]> {
  const trainIds: string[] = JSON.parse(await readFile(path.join(DATA_DIR, 'split.json'), 'utf8')).train_ids;
  const ids = new Set(trainIds.map(String));
  const all = (await readFile(path.join(DATA_DIR, 'dabstep', 'tasks', 'all.jsonl'), 'utf8'))
    .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  return all
    .filter((q) => ids.has(String(q.task_id)))
    .map((q) => ({ question: String(q.question), guidelines: q.guidelines ? String(q.guidelines) : undefined, answer: q.answer !== undefined ? String(q.answer) : undefined }));
}

export async function buildDabstepLayer(opts: {
  model: string;
  includeManual?: boolean;
  includeAnswers?: boolean;
  maxRounds?: number;
  reasoningEffort?: string;
  centralOnly?: boolean;
  provider?: string;
  runId?: string;
}): Promise<LayerBuildResult> {
  if (!existsSync(LOCAL_DB_PATH)) {
    console.log('local compile DB missing — building data/dabstep.duckdb …');
    await buildLocalDuckDB();
  }
  const includeManual = opts.includeManual !== false;
  const [contextMarkdown, qaPairs, primer, relationshipDiscovery] = await Promise.all([
    loadDabstepContext(includeManual),
    loadDabstepTrainQA(),
    readDoc('malloy-primer.md'),
    readDoc('relationship-discovery.md'),
  ]);

  return buildLayer({
    tables: DABSTEP_TABLES,
    dbPath: LOCAL_DB_PATH,
    contextMarkdown,
    qaPairs,
    outputName: 'dabstep',
    domainName: 'dabstep',
    docs: { primer, relationshipDiscovery },
    generationPolicy: {
      // Phase-1 DABstep builds include the train answers for coverage; the layer
      // must still NOT copy them (enforced by SEMANTIC_LAYER_POLICY).
      includeAnswers: opts.includeAnswers ?? true,
      extraGuidance: DABSTEP_DOMAIN_GUIDANCE,
      maxCentralFiles: 6,
    },
    model: opts.model,
    reasoningEffort: opts.reasoningEffort,
    provider: opts.provider,
    maxRounds: opts.maxRounds,
    centralOnly: opts.centralOnly,
    // The official gate reads `manual_included`; carry it forward for back-compat.
    provenanceFields: { manual_included: includeManual },
    runId: opts.runId,
  });
}
