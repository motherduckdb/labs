/**
 * layer-improve — a targeted, model-driven loop that takes an EXISTING
 * model-authored Malloy layer plus an eval run's misses, identifies the
 * implicated layer file(s) from the failure EVIDENCE (not the gold answer),
 * makes minimal atomic edits to fix genuine STRUCTURAL defects, re-validates
 * (compile + execute every view — the P0 gate), re-stamps provenance with an
 * improve lineage, and preserves already-passing questions.
 *
 * Constitutional constraints (Phase-3 generalization depends on these):
 *  - NO LEAKAGE / task-general: a repair prompt sees only STRUCTURAL evidence —
 *    the failing Malloy, compiler/exec diagnostics, "this view returns 0/errors",
 *    the column profile, and the manual. It NEVER sees the question's gold answer
 *    and must not tune the layer to a specific train value. The fix improves the
 *    layer's GENERAL correctness (per manual + data), exactly like layer-build.
 *  - DON'T REGRESS: after editing, every view must still execute; if the final
 *    all-views gate fails and can't be repaired, ALL edits are rolled back.
 *  - HONEST / IDEMPOTENT: most current misses are answering-agent/skill issues,
 *    NOT layer bugs. When no miss is structurally layer-caused, it edits NOTHING,
 *    leaves provenance untouched, and reports where each fix belongs.
 *
 * The triage (layer defect vs. skill/answering vs. model-capability) is the hard,
 * valuable part. It is deterministic-first (classifyMiss, a pure function over
 * re-execution evidence — unit-tested), with a model verdict only on the
 * layer-SUSPECTED minority (which may downgrade to skill).
 */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { complete } from './llm-client.js';
import { MalloyRuntime } from './malloy-runtime.js';
import {
  DUCKDB_NOTES,
  MODELS_DIR,
  META_DIR,
  columnProfiles,
  hashLayerOnDisk,
  parseEdits,
  readDoc,
  sourceNamesIn,
  validateModel,
  PROVENANCE_PATH,
  DATA_DIR,
} from './layer-build.js';
import * as cl from './controllog.js';

const TABLES = ['payments', 'fees', 'merchants', 'acquirer_countries', 'merchant_category_codes'];

// ---------------------------------------------------------------------------
// Miss rows (the --from JSONL shape) — see cli.ts runEvalTask's `row`.
// ---------------------------------------------------------------------------

export interface MissRow {
  task_id: string | number;
  question?: string;
  guidelines?: string;
  is_correct?: boolean;
  correctness?: string;
  match_source?: string;
  submitted?: boolean;
  hit_limit?: boolean;
  malloy_source?: string | null;
  compiled_sql?: string | null;
  predicted_answer?: unknown;
  failure_stage?: string | null;
  failure_kind?: string | null;
  error?: string | null;
  // gold_answer IS present in the row but is DELIBERATELY never read here — no leakage.
}

/** Read a results JSONL and return only the incorrect rows (the misses). */
export async function readMisses(fromPath: string): Promise<MissRow[]> {
  const rows = (await readFile(fromPath, 'utf8'))
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as MissRow);
  return rows.filter((r) => r.is_correct === false);
}

// ---------------------------------------------------------------------------
// Layer index — map a source/view NAME to the file that defines it. Pure over
// the file bodies so the miss→file mapping is unit-testable without a runtime.
// ---------------------------------------------------------------------------

export interface LayerIndex {
  /** source OR view name -> the .malloy file that defines it. */
  fileOf: Map<string, string>;
  /** every source name defined anywhere (for "is this token a source"). */
  sources: Set<string>;
  /** every view name defined anywhere. */
  views: Set<string>;
}

const VIEW_DEF_RE = /^[ \t]*view:[ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]+is\b/gm;

/** Build the name→file index from a map of file -> body. Pure. */
export function buildLayerIndex(bodyOf: Record<string, string>): LayerIndex {
  const fileOf = new Map<string, string>();
  const sources = new Set<string>();
  const views = new Set<string>();
  for (const [file, body] of Object.entries(bodyOf)) {
    for (const s of sourceNamesIn(body)) {
      sources.add(s);
      if (!fileOf.has(s)) fileOf.set(s, file);
    }
    for (const m of body.matchAll(VIEW_DEF_RE)) {
      views.add(m[1]);
      if (!fileOf.has(m[1])) fileOf.set(m[1], file);
    }
  }
  return { fileOf, sources, views };
}

/** Read the on-disk layer and build its index. */
export async function loadLayerIndex(modelsDir = MODELS_DIR): Promise<LayerIndex> {
  const bodyOf: Record<string, string> = {};
  for (const f of (await readdir(modelsDir)).filter((f) => f.endsWith('.malloy'))) {
    bodyOf[f] = await readFile(path.join(modelsDir, f), 'utf8');
  }
  return buildLayerIndex(bodyOf);
}

const IDENT_RE = /[A-Za-z_][A-Za-z0-9_]*/g;

/** The distinct identifier tokens of a Malloy snippet (dedup, in order). Pure. */
export function identifiersIn(src: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of src.matchAll(IDENT_RE)) {
    if (!seen.has(m[0])) {
      seen.add(m[0]);
      out.push(m[0]);
    }
  }
  return out;
}

/**
 * Map a submitted Malloy snippet to the layer file(s) it implicates: the files
 * that define any source/view NAME the snippet references. Pure + testable.
 */
export function mapMalloyToFiles(src: string, index: LayerIndex): string[] {
  if (!src) return [];
  const files: string[] = [];
  for (const tok of identifiersIn(src)) {
    const f = index.fileOf.get(tok);
    if (f && !files.includes(f)) files.push(f);
  }
  return files;
}

/** Named layer views referenced in a snippet (token ∩ known view names). Pure. */
export function referencedViews(src: string, index: LayerIndex): string[] {
  return identifiersIn(src).filter((t) => index.views.has(t));
}

// ---------------------------------------------------------------------------
// Per-miss analysis (re-execution evidence) + deterministic classification.
// ---------------------------------------------------------------------------

export interface ViewProbe {
  source: string;
  view: string;
  file: string | undefined;
  ok: boolean;
  rowCount: number;
  error?: string;
}

export interface MissAnalysis {
  taskId: string;
  question?: string;
  guidelines?: string;
  correctness?: string;
  matchSource?: string;
  predictedAnswer?: unknown;
  /** whether the answering agent actually submitted a Malloy answer. */
  submitted: boolean;
  hitLimit: boolean;
  malloySource: string | null;
  /** re-running the submitted Malloy now (null when nothing was submitted). */
  reExec: { ok: boolean; rowCount: number; error?: string } | null;
  /** each named layer view the submission referenced, smoke-run on its own. */
  viewProbes: ViewProbe[];
  implicatedFiles: string[];
}

export type MissCategory =
  | 'no_submission'
  | 'query_wrong_answer'
  | 'query_compile_error'
  | 'layer_view_error'
  | 'layer_view_empty'
  | 'unknown';

export type MissOwner = 'answering' | 'skill' | 'layer' | 'model';

export interface MissClassification {
  category: MissCategory;
  /** does the EVIDENCE point at a structural layer defect worth a model verdict? */
  layerSuspected: boolean;
  /** the default fix location (a model verdict may override layerSuspected ones). */
  suggestedOwner: MissOwner;
  implicatedFiles: string[];
  note: string;
}

/**
 * Deterministically classify a miss from its re-execution evidence — the hard,
 * valuable triage, made testable by being a PURE function over MissAnalysis.
 *
 * Decision tree (the key insight: a NAMED layer surface, run on its own, is the
 * structural-defect probe — it needs no gold answer):
 *   - nothing submitted .................................. answering (turn budget)
 *   - submitted, a referenced view ERRORS on its own ..... LAYER (regression)
 *   - submitted re-runs fine, returns rows ............... skill (agent's inline logic)
 *   - submitted re-runs fine but empty, AND a referenced
 *     view is ALSO empty on its own ...................... LAYER-suspected (model confirms)
 *   - submitted re-runs fine but empty, no empty view .... skill (agent over-filtered)
 *   - submitted FAILS to re-run, referenced views clean .. skill (agent's inline Malloy)
 *   - submitted FAILS, no views referenced ............... skill (agent's inline Malloy)
 */
export function classifyMiss(a: MissAnalysis): MissClassification {
  const files = a.implicatedFiles;
  if (!a.submitted || a.hitLimit || !a.malloySource) {
    return {
      category: 'no_submission',
      layerSuspected: false,
      suggestedOwner: 'answering',
      implicatedFiles: files,
      note: 'agent never submitted a Malloy answer (hit the turn limit / thrash) — an answering-loop / turn-budget issue, not a layer defect. A layer may help only if it lacks an answer-shaped view for this question shape (soft note).',
    };
  }

  const brokenView = a.viewProbes.find((p) => !p.ok);
  const emptyView = a.viewProbes.find((p) => p.ok && p.rowCount === 0);
  const reExec = a.reExec;

  if (brokenView) {
    // A named layer view fails to EXECUTE on its own → a structural layer defect
    // (the build gate should have caught it; treat as a regression to fix).
    return {
      category: 'layer_view_error',
      layerSuspected: true,
      suggestedOwner: 'layer',
      implicatedFiles: brokenView.file ? [brokenView.file, ...files.filter((f) => f !== brokenView.file)] : files,
      note: `named layer view \`${brokenView.source} -> ${brokenView.view}\` fails to execute on its own: ${brokenView.error?.slice(0, 200)}`,
    };
  }

  if (reExec && !reExec.ok) {
    // Submitted Malloy errors, but every referenced named view runs clean → the
    // fault is in the agent's INLINE composition, not the layer.
    return {
      category: 'query_compile_error',
      layerSuspected: false,
      suggestedOwner: 'skill',
      implicatedFiles: files,
      note: `the agent's submitted Malloy fails to compile/execute, but the layer views it referenced run clean on their own — the defect is in the agent's inline query (a skill/answering issue): ${reExec.error?.slice(0, 200)}`,
    };
  }

  // From here the submitted Malloy re-ran successfully.
  if (reExec && reExec.rowCount === 0 && emptyView) {
    // The query returned nothing AND a named layer view is itself empty → suspect
    // the layer view (a matching/aggregating view that returns nothing over rows
    // that exist is usually a wildcard-encoding or domain bug). Model confirms.
    return {
      category: 'layer_view_empty',
      layerSuspected: true,
      suggestedOwner: 'layer',
      implicatedFiles: emptyView.file ? [emptyView.file, ...files.filter((f) => f !== emptyView.file)] : files,
      note: `named layer view \`${emptyView.source} -> ${emptyView.view}\` returns 0 rows on its own — a matching/aggregating view that is empty over rows that exist is usually a structural (wildcard/domain) bug.`,
    };
  }

  if (reExec && reExec.rowCount === 0) {
    return {
      category: 'query_wrong_answer',
      layerSuspected: false,
      suggestedOwner: 'skill',
      implicatedFiles: files,
      note: 'the submitted Malloy runs but returns 0 rows while the layer views it uses are non-empty — the agent likely over-filtered (a skill/answering issue).',
    };
  }

  return {
    category: 'query_wrong_answer',
    layerSuspected: false,
    suggestedOwner: 'skill',
    implicatedFiles: files,
    note: 'the submitted Malloy compiles, executes, and returns rows — the layer surfaces it used work; the wrong answer comes from the agent\'s inline logic (filter / field / grain / ranking), a skill/answering issue, not a layer defect.',
  };
}

/**
 * Gather re-execution evidence for one miss: re-run the submitted Malloy and
 * smoke each named layer view it referenced. Uses the runtime + index; the
 * derived classification (classifyMiss) is a separate pure step.
 */
export async function analyzeMiss(
  row: MissRow,
  rt: MalloyRuntime,
  index: LayerIndex,
  viewToSource: Map<string, string>,
): Promise<MissAnalysis> {
  const taskId = String(row.task_id);
  const malloySource = (row.malloy_source ?? '').trim() || null;
  const submitted = !!row.submitted && !!malloySource;
  const hitLimit = !!row.hit_limit;

  let reExec: MissAnalysis['reExec'] = null;
  const viewProbes: ViewProbe[] = [];

  if (malloySource) {
    const r = await rt.run(malloySource, 50);
    reExec = r.ok
      ? { ok: true, rowCount: r.rows?.length ?? 0 }
      : { ok: false, rowCount: 0, error: (r.diagnostics ?? []).map((d) => d.message).join('\n') };

    // Smoke each referenced named view on its own (the structural-defect probe).
    for (const view of referencedViews(malloySource, index)) {
      const source = viewToSource.get(view);
      if (!source) continue;
      const pr = await rt.run(`run: ${source} -> ${view}`, 1);
      viewProbes.push({
        source,
        view,
        file: index.fileOf.get(view),
        ok: pr.ok,
        rowCount: pr.rows?.length ?? 0,
        error: pr.ok ? undefined : (pr.diagnostics ?? []).map((d) => d.message).join('\n'),
      });
    }
  }

  return {
    taskId,
    question: row.question,
    guidelines: row.guidelines,
    correctness: row.correctness,
    matchSource: row.match_source,
    predictedAnswer: row.predicted_answer,
    submitted,
    hitLimit,
    malloySource,
    reExec,
    viewProbes,
    implicatedFiles: malloySource ? mapMalloyToFiles(malloySource, index) : [],
  };
}

// ---------------------------------------------------------------------------
// Structural evidence string (NO gold answer — leakage-free) for model prompts.
// ---------------------------------------------------------------------------

/**
 * Render the STRUCTURAL evidence for a miss into a prompt block. Deliberately
 * excludes the gold answer and any train-specific target value: only the
 * question intent, the failing Malloy, the re-execution diagnostics, and the
 * per-view probes. `predicted_answer` is the agent's OWN output (e.g. a view
 * that produced 0), which is structural evidence, not the gold.
 */
export function evidenceBlock(a: MissAnalysis, cls: MissClassification): string {
  const lines: string[] = [];
  lines.push(`Question [${a.taskId}]: ${a.question ?? '(unavailable)'}`);
  if (a.guidelines) lines.push(`Answer guidelines: ${a.guidelines}`);
  lines.push(`Scoring verdict: ${a.correctness ?? 'incorrect'} (match_source=${a.matchSource ?? 'none'})`);
  if (a.malloySource) {
    lines.push(`\nThe answering agent submitted this Malloy:\n${a.malloySource}`);
    if (a.predictedAnswer !== undefined && a.predictedAnswer !== null) {
      lines.push(`It produced (the agent's OWN output, NOT the gold answer): ${String(a.predictedAnswer).slice(0, 300)}`);
    }
    if (a.reExec) {
      lines.push(
        a.reExec.ok
          ? `Re-running it now: OK, ${a.reExec.rowCount} row(s).`
          : `Re-running it now: EXECUTION ERROR:\n${a.reExec.error}`,
      );
    }
  } else {
    lines.push(`\nThe answering agent did NOT submit a Malloy answer (hit the turn limit).`);
  }
  if (a.viewProbes.length) {
    lines.push(`\nLayer views it referenced, each run ON ITS OWN:`);
    for (const p of a.viewProbes) {
      lines.push(
        p.ok
          ? `  - ${p.source} -> ${p.view}  [${p.file ?? '?'}]: OK, ${p.rowCount} row(s)${p.rowCount === 0 ? ' (EMPTY)' : ''}`
          : `  - ${p.source} -> ${p.view}  [${p.file ?? '?'}]: ERROR: ${p.error?.slice(0, 300)}`,
      );
    }
  }
  lines.push(`\nDeterministic triage: ${cls.category} — ${cls.note}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Model triage verdict (only for layer-SUSPECTED misses) — may downgrade.
// ---------------------------------------------------------------------------

export interface TriageVerdict {
  owner: MissOwner;
  file: string | null;
  defect: string;
  rationale: string;
}

const TRIAGE_SYSTEM = `You are triaging a FAILED data question against a Malloy semantic layer. Decide WHERE the fix belongs:
- "layer": a STRUCTURAL defect in a layer source/view itself (it errors at execution, or a matching/aggregating view returns 0/empty over rows that exist, or it computes at the wrong grain). The fix is a minimal edit to the layer file, justified ONLY by the manual + the data's actual encodings — NOT by any specific answer value.
- "skill": the layer is fine; the answering agent wrote the wrong per-query Malloy (under-filtered, wrong field, wrong grain, missed a wildcard branch, bad inline syntax) or never submitted. The fix belongs in the answering SKILL / prompt, not the layer.
- "model": neither — a model-capability / reasoning gap on a hard compositional question that no layer or skill edit cleanly fixes.

You are given STRUCTURAL evidence only (failing Malloy, execution diagnostics, per-view probes, the column profile, the manual). You are NOT given the gold answer and MUST NOT ask for it or tune anything to a value. A layer verdict is justified ONLY when a NAMED layer view, exercised on its own, is itself broken (errors or is wrongly empty/at the wrong grain). If the submitted query runs and returns rows and the wrongness is in the agent's own filter/field/ranking, that is "skill", not "layer".

Return ONLY a JSON object: {"owner":"layer|skill|model","file":"<implicated .malloy file or null>","defect":"<one-sentence structural description, or empty>","rationale":"<one sentence>"}.`;

export async function triageVerdict(opts: {
  evidence: string;
  implicatedFileSrc: string;
  implicatedFile: string;
  profiles: string;
  manual: string;
  model: string;
  reasoningEffort?: string;
  provider?: string;
}): Promise<TriageVerdict & { cost: number; promptTokens: number; completionTokens: number; cachedTokens: number; cacheWriteTokens: number; raw: string }> {
  const user = `## Failure evidence (structural — NO gold answer)\n${opts.evidence}\n\n## The implicated layer file \`${opts.implicatedFile}\`\n\`\`\`malloy\n${opts.implicatedFileSrc}\n\`\`\`\n\n## Column profiles (actual encodings + domains — ground truth)\n${opts.profiles}\n\n## The Merchant Manual\n${opts.manual}\n\nReturn the triage JSON now.`;
  const resp = await complete({
    model: opts.model,
    systemPrompt: TRIAGE_SYSTEM,
    userPrompt: user,
    reasoningEffort: opts.reasoningEffort,
    provider: opts.provider,
    maxTokens: 2000,
  });
  let v: TriageVerdict = { owner: 'skill', file: opts.implicatedFile, defect: '', rationale: 'parse failure → defaulted to skill (no layer edit)' };
  try {
    const m = resp.text.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(m ? m[0] : resp.text) as Partial<TriageVerdict>;
    const owner = parsed.owner;
    if (owner === 'layer' || owner === 'skill' || owner === 'model') {
      v = {
        owner,
        file: typeof parsed.file === 'string' && parsed.file ? parsed.file : opts.implicatedFile,
        defect: String(parsed.defect ?? ''),
        rationale: String(parsed.rationale ?? ''),
      };
    }
  } catch {
    /* keep the safe skill default */
  }
  return { ...v, cost: resp.cost ?? 0, promptTokens: resp.promptTokens, completionTokens: resp.completionTokens, cachedTokens: resp.cachedTokens, cacheWriteTokens: resp.cacheWriteTokens, raw: resp.text };
}

// ---------------------------------------------------------------------------
// Repair a single layer file with minimal atomic edits (mirrors layer-build's
// edit-mode authorStage), then re-validate (compile + execute the file's views).
// ---------------------------------------------------------------------------

const REPAIR_SYSTEM_HEADER = `You are a Malloy expert REPAIRING one file of an existing semantic layer. A view/source in this file has a STRUCTURAL defect (it errors at execution, or returns 0/empty over rows that exist, or computes at the wrong grain). Fix the DEFECT generically — make the layer correct per the manual + the data's actual encodings (the column profile).

ABSOLUTE RULE: do NOT tune anything to a specific answer value. You are given NO gold answers. A correct fix is one that makes the view structurally sound for ANY input (correct join scope, correct wildcard/domain handling, correct grain), not one that nudges a number. Make the MINIMAL edits that fix ONLY the described defect — do not rewrite, reorder, or restructure anything else, and do not change views that already work.`;

export interface RepairResult {
  ok: boolean;
  file: string;
  rounds: number;
  applied: number;
  diag?: string;
  cost: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
}

export async function repairFileStage(opts: {
  file: string; // e.g. c3_fee_assignment.malloy
  defects: string; // merged structural evidence + defect descriptions for this file
  profiles: string;
  manual: string;
  primer: string;
  model: string;
  reasoningEffort?: string;
  provider?: string;
  maxRounds: number;
  runId?: string;
}): Promise<RepairResult> {
  const agg = { cost: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cacheWriteTokens: 0 };
  const modelPath = path.join(MODELS_DIR, opts.file);
  let current = await readFile(modelPath, 'utf8');
  let diag = '';
  let totalApplied = 0;
  const system = `${REPAIR_SYSTEM_HEADER}\n\n=== MALLOY PRIMER ===\n${opts.primer}\n\n${DUCKDB_NOTES}`;

  for (let round = 1; round <= opts.maxRounds; round++) {
    const t0 = Date.now();
    const errSuffix = diag ? `\n\n## Your previous edits still left this failing — fix it:\n${diag}` : '';
    const resp = await complete({
      model: opts.model,
      systemPrompt: system,
      userPrompt:
        `## Structural defect(s) to fix in ${opts.file}\n${opts.defects}\n\n` +
        `## Column profiles (actual encodings + domains — ground truth; prefer over prose)\n${opts.profiles}\n\n` +
        `## The Merchant Manual\n${opts.manual}\n\n` +
        `=== current ${opts.file} ===\n${current}\n\n` +
        `Return ONLY a JSON array of minimal edits: [{"old":"<text copied VERBATIM from the file, unique>","new":"<replacement>"}]. ` +
        `Each "old" must appear exactly once in the file. Fix ONLY the described structural defect (typed raw escapes fn!returntype, wildcard branch on every match field, materialize join attributes as real columns before a join_many, qualify join keys).${errSuffix}`,
      reasoningEffort: opts.reasoningEffort,
      provider: opts.provider,
      maxTokens: 12000,
    });
    const wallMs = Date.now() - t0;
    agg.cost += resp.cost ?? 0;
    agg.promptTokens += resp.promptTokens;
    agg.completionTokens += resp.completionTokens;
    agg.cachedTokens += resp.cachedTokens;
    agg.cacheWriteTokens += resp.cacheWriteTokens;

    const edits = parseEdits(resp.text);
    let patched = current;
    let applied = 0;
    for (const e of edits) {
      const i = patched.indexOf(e.old);
      if (i >= 0) {
        patched = patched.slice(0, i) + e.new + patched.slice(i + e.old.length);
        applied++;
      }
    }

    if (opts.runId) {
      const ex = cl.newId();
      cl.modelPrompt({ taskId: opts.file, runId: opts.runId, provider: 'openrouter', model: opts.model, promptTokens: resp.promptTokens, exchangeId: ex, role: 'builder', payload: { phase: 'build', stage: `improve:${opts.file}`, round, mode: 'edit' } });
      cl.modelCompletion({ taskId: opts.file, runId: opts.runId, provider: 'openrouter', model: opts.model, completionTokens: resp.completionTokens, wallMs, exchangeId: ex, costMoney: resp.cost, role: 'builder', payload: { phase: 'build', stage: `improve:${opts.file}`, round, mode: 'edit', applied, response: resp.text.slice(0, 8000), cached_tokens: resp.cachedTokens, cache_write_tokens: resp.cacheWriteTokens } });
    }

    if (applied === 0) {
      console.log(`  … improve ${opts.file} round ${round}: no edits applied`);
      // No applicable edit: if we already have a failing diag, keep trying; else give up.
      if (round === opts.maxRounds) return { ok: false, file: opts.file, rounds: round, applied: totalApplied, diag: diag || 'model returned no applicable edits', ...agg };
      continue;
    }
    totalApplied += applied;
    await writeFile(modelPath, patched + (patched.endsWith('\n') ? '' : '\n'));
    current = patched;
    console.log(`  … improve ${opts.file} round ${round}: applied ${applied}/${edits.length} edit(s)`);

    const cv0 = Date.now();
    const v = await validateModel(opts.file); // compile whole model + execute this file's views
    if (opts.runId) {
      const callId = cl.newId();
      cl.toolCall({ taskId: opts.file, runId: opts.runId, name: 'compile_check', callId, arguments: { round, mode: 'edit' }, model: opts.model });
      cl.toolResult({ taskId: opts.file, runId: opts.runId, name: 'compile_check', callId, ok: v.ok, durationMs: Date.now() - cv0, model: opts.model, output: v.ok ? 'ok' : v.diag.slice(0, 1500) });
    }
    if (v.ok) {
      console.log(`  ✓ improve ${opts.file} (round ${round}, $${agg.cost.toFixed(4)})`);
      return { ok: true, file: opts.file, rounds: round, applied: totalApplied, ...agg };
    }
    console.log(`  ✗ improve ${opts.file} round ${round}:\n${v.diag.split('\n').slice(0, 6).map((l) => '      ' + l).join('\n')}`);
    diag = v.diag;
  }
  return { ok: false, file: opts.file, rounds: opts.maxRounds, applied: totalApplied, diag, ...agg };
}

// ---------------------------------------------------------------------------
// Full all-views gate (the strongest no-regression check) + layer snapshot.
// ---------------------------------------------------------------------------

/** Execute EVERY view of EVERY source against the runtime; return the first
 *  failure. Catches edits that ripple beyond the edited file. */
export async function executeAllViews(rt: MalloyRuntime): Promise<{ ok: boolean; diag: string }> {
  const inv = await rt.describe(); // compile check (throws on compile error → caller catches)
  for (const s of inv.sources) {
    for (const view of inv.viewsBySource[s] ?? []) {
      const r = await rt.run(`run: ${s} -> ${view}`, 1);
      if (!r.ok) {
        return { ok: false, diag: `\`${s} -> ${view}\` fails to execute:\n${(r.diagnostics ?? []).map((d) => d.message).join('\n')}` };
      }
    }
  }
  return { ok: true, diag: '' };
}

type Snapshot = { models: Record<string, string>; meta: Record<string, string> };

async function snapshotLayer(): Promise<Snapshot> {
  const models: Record<string, string> = {};
  for (const f of (await readdir(MODELS_DIR)).filter((f) => f.endsWith('.malloy'))) {
    models[f] = await readFile(path.join(MODELS_DIR, f), 'utf8');
  }
  const meta: Record<string, string> = {};
  try {
    for (const f of (await readdir(META_DIR)).filter((f) => f.endsWith('.yaml'))) {
      meta[f] = await readFile(path.join(META_DIR, f), 'utf8');
    }
  } catch {
    /* no _meta */
  }
  return { models, meta };
}

async function restoreLayer(snap: Snapshot): Promise<void> {
  for (const [f, body] of Object.entries(snap.models)) await writeFile(path.join(MODELS_DIR, f), body);
  for (const [f, body] of Object.entries(snap.meta)) await writeFile(path.join(META_DIR, f), body);
}

// ---------------------------------------------------------------------------
// Provenance re-stamp (preserve model_authored + manual_included; add lineage).
// ---------------------------------------------------------------------------

interface ProvenanceFile {
  malloy_provenance?: string;
  malloy_model_hash?: string;
  manual_included?: boolean | null;
  authoring_model?: string | null;
  improve_round?: number;
  improve_lineage?: Array<Record<string, unknown>>;
  [k: string]: unknown;
}

async function restampProvenance(opts: { fromHash: string; toHash: string; model: string; editedFiles: string[]; fromRun: string }): Promise<void> {
  let prev: ProvenanceFile = {};
  try {
    prev = JSON.parse(await readFile(PROVENANCE_PATH, 'utf8')) as ProvenanceFile;
  } catch {
    /* none */
  }
  const round = (prev.improve_round ?? 0) + 1;
  const lineage = Array.isArray(prev.improve_lineage) ? prev.improve_lineage.slice() : [];
  lineage.push({
    from_hash: opts.fromHash,
    to_hash: opts.toHash,
    round,
    improve_model: opts.model,
    edited_files: opts.editedFiles,
    from_run: path.basename(opts.fromRun),
    at: new Date().toISOString(),
  });
  const next: ProvenanceFile = {
    ...prev,
    // model_authored is PRESERVED — the edits are model-made, atomic, and
    // execution-gated (same discipline as layer-build); no human touched the layer.
    malloy_provenance: 'model_authored',
    malloy_model_hash: opts.toHash,
    // manual_included + authoring_model carry forward so the official gate still passes.
    manual_included: prev.manual_included ?? null,
    authoring_model: prev.authoring_model ?? null,
    improve_round: round,
    improve_lineage: lineage,
  };
  await writeFile(PROVENANCE_PATH, JSON.stringify(next, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface MissReport {
  taskId: string;
  category: MissCategory;
  owner: MissOwner;
  implicatedFiles: string[];
  note: string;
  /** model triage rationale (layer-suspected misses only). */
  verdict?: TriageVerdict;
}

export interface ImproveResult {
  ok: boolean;
  editsApplied: boolean;
  fromHash: string;
  toHash: string;
  editedFiles: string[];
  misses: MissReport[];
  cost: number;
  /** human-readable summary of where each miss belongs. */
  summary: string;
  diagnostics?: string;
}

export async function improveLayer(opts: {
  fromPath: string;
  model: string;
  reasoningEffort?: string;
  provider?: string;
  maxRounds?: number;
  /** connect the runtime to MotherDuck (md:<db>) instead of the local compile DB. */
  motherduckDb?: string;
  runId?: string;
}): Promise<ImproveResult> {
  const maxRounds = opts.maxRounds ?? 4;
  const fromHash = await hashLayerOnDisk();
  const databasePath = opts.motherduckDb ? `md:${opts.motherduckDb}` : undefined;

  if (opts.runId) {
    cl.runMetadata({
      runId: opts.runId,
      resolvedConfig: { phase: 'improve', model: opts.model, from: path.basename(opts.fromPath), from_hash: fromHash, provider: opts.provider ?? null, reasoning: opts.reasoningEffort ?? null, substrate: opts.motherduckDb ? 'motherduck' : 'local' },
      agentName: 'agent:asm-malloy-builder', datasetName: 'agentic_malloy', datasetVersion: 'layer-improve',
    });
  }

  const misses = await readMisses(opts.fromPath);
  if (!misses.length) {
    return { ok: true, editsApplied: false, fromHash, toHash: fromHash, editedFiles: [], misses: [], cost: 0, summary: 'No incorrect rows in the run — nothing to improve.' };
  }

  // Build the index + view→source map (needs one compiled describe()).
  const index = await loadLayerIndex();
  const rt = new MalloyRuntime(databasePath ? { databasePath } : {});
  let totalCost = 0;
  const reports: MissReport[] = [];
  const editedFiles: string[] = [];
  let diagnostics: string | undefined;

  try {
    const inv = await rt.describe();
    const viewToSource = new Map<string, string>();
    for (const s of inv.sources) for (const v of inv.viewsBySource[s] ?? []) if (!viewToSource.has(v)) viewToSource.set(v, s);

    // 1. Analyze + deterministically classify every miss.
    const analyses: { a: MissAnalysis; cls: MissClassification }[] = [];
    for (const row of misses) {
      const a = await analyzeMiss(row, rt, index, viewToSource);
      const cls = classifyMiss(a);
      analyses.push({ a, cls });
      console.log(`  miss ${a.taskId}: ${cls.category} → ${cls.suggestedOwner}${cls.layerSuspected ? ' (layer-suspected)' : ''}`);
    }

    // 2. Model verdict ONLY on layer-suspected misses; collect confirmed-layer
    //    defects grouped by file. Everything else is reported, never edited.
    const profile = await columnProfiles();
    const profiles = TABLES.map((t) => `### ${t}\n${profile[t]}`).join('\n\n');
    const manual = existsSync(path.join(DATA_DIR, 'dabstep', 'context', 'manual.md'))
      ? await readFile(path.join(DATA_DIR, 'dabstep', 'context', 'manual.md'), 'utf8')
      : '(manual unavailable)';
    const primer = await readDoc('malloy-primer.md');

    const defectsByFile = new Map<string, string[]>();
    for (const { a, cls } of analyses) {
      let verdict: TriageVerdict | undefined;
      let owner: MissOwner = cls.suggestedOwner;
      let file = cls.implicatedFiles[0] ?? null;

      if (cls.layerSuspected && file && existsSync(path.join(MODELS_DIR, file))) {
        const v = await triageVerdict({
          evidence: evidenceBlock(a, cls),
          implicatedFileSrc: await readFile(path.join(MODELS_DIR, file), 'utf8'),
          implicatedFile: file,
          profiles,
          manual,
          model: opts.model,
          reasoningEffort: opts.reasoningEffort,
          provider: opts.provider,
        });
        totalCost += v.cost;
        verdict = { owner: v.owner, file: v.file, defect: v.defect, rationale: v.rationale };
        owner = v.owner;
        if (v.owner === 'layer' && v.file && existsSync(path.join(MODELS_DIR, v.file))) file = v.file;
        console.log(`    triage ${a.taskId}: model says ${v.owner}${v.owner === 'layer' ? ` (${file})` : ''} — ${v.rationale}`);
        if (v.owner === 'layer' && file) {
          const list = defectsByFile.get(file) ?? [];
          list.push(`### Miss ${a.taskId}\n${evidenceBlock(a, cls)}\nModel-confirmed defect: ${v.defect}`);
          defectsByFile.set(file, list);
        }
      }
      reports.push({ taskId: a.taskId, category: cls.category, owner, implicatedFiles: cls.implicatedFiles, note: cls.note, verdict });
    }

    // 3. Repair each implicated file (one coherent pass per file), behind a
    //    snapshot so we can roll back if the final all-views gate regresses.
    if (defectsByFile.size > 0) {
      const snap = await snapshotLayer();
      let allOk = true;
      for (const [file, defects] of defectsByFile) {
        const r = await repairFileStage({
          file,
          defects: defects.join('\n\n'),
          profiles,
          manual,
          primer,
          model: opts.model,
          reasoningEffort: opts.reasoningEffort,
          provider: opts.provider,
          maxRounds,
          runId: opts.runId,
        });
        totalCost += r.cost;
        if (r.ok && r.applied > 0) editedFiles.push(file);
        else {
          allOk = false;
          diagnostics = `repair of ${file} failed: ${r.diag}`;
          break;
        }
      }

      // Final P0 gate: every view of every source must still execute. Use a
      // FRESH runtime (the analysis `rt` cached the pre-edit model text); this
      // mirrors validateModel's credential-free local compile+execute gate.
      if (allOk) {
        const gateRt = new MalloyRuntime();
        try {
          const gate = await executeAllViews(gateRt);
          if (!gate.ok) {
            allOk = false;
            diagnostics = `post-edit all-views gate failed: ${gate.diag}`;
          }
        } catch (e) {
          allOk = false;
          diagnostics = `post-edit compile failed: ${e instanceof Error ? e.message : String(e)}`;
        } finally {
          await gateRt.close();
        }
      }

      if (!allOk) {
        console.log(`  ✗ edits did not pass the no-regression gate — rolling back all changes.`);
        await restoreLayer(snap);
        editedFiles.length = 0;
      }
    }

    const editsApplied = editedFiles.length > 0;
    const toHash = editsApplied ? await hashLayerOnDisk() : fromHash;
    if (editsApplied) {
      await restampProvenance({ fromHash, toHash, model: opts.model, editedFiles, fromRun: opts.fromPath });
    }

    return {
      ok: editsApplied || !diagnostics,
      editsApplied,
      fromHash,
      toHash,
      editedFiles,
      misses: reports,
      cost: totalCost,
      summary: renderSummary(reports, editedFiles, fromHash, toHash, diagnostics),
      diagnostics,
    };
  } finally {
    await rt.close();
  }
}

function renderSummary(reports: MissReport[], editedFiles: string[], fromHash: string, toHash: string, diagnostics?: string): string {
  const lines: string[] = [];
  const byOwner = (o: MissOwner) => reports.filter((r) => r.owner === o);
  lines.push(`Triaged ${reports.length} miss(es):`);
  for (const o of ['layer', 'skill', 'answering', 'model'] as MissOwner[]) {
    const rs = byOwner(o);
    if (!rs.length) continue;
    lines.push(`  ${o}: ${rs.map((r) => r.taskId).join(', ')}`);
    for (const r of rs) {
      const where = r.implicatedFiles.length ? ` [${r.implicatedFiles.join(', ')}]` : '';
      lines.push(`    - ${r.taskId} (${r.category})${where}: ${r.verdict?.rationale || r.note}`);
    }
  }
  if (editedFiles.length) {
    lines.push(`\nEdited (model_authored preserved): ${editedFiles.join(', ')}`);
    lines.push(`Layer hash ${fromHash} → ${toHash}. Re-run evaluate to measure.`);
  } else {
    lines.push(`\nNo layer files edited — no miss was a structural layer defect.`);
    if (diagnostics) lines.push(`(attempt blocked: ${diagnostics})`);
    lines.push(`The fixes above belong in the answering skill/prompt or are model-capability limits, not the layer.`);
  }
  return lines.join('\n');
}
