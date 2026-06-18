/**
 * layer-improve — orchestrates a targeted, model-driven repair loop over an
 * EXISTING model-authored Malloy layer using an eval run's misses. It triages
 * each miss (miss-analysis + miss-verdict), runs a run-level tool-error
 * meta-analysis, edits the layer ONLY for genuine structural defects
 * (layer-repair), re-validates with the P0 all-views gate, and re-stamps
 * provenance — preserving already-passing questions.
 *
 * Constitutional constraints (Phase-3 generalization depends on these):
 *  - NO LEAKAGE / task-general: prompts see only STRUCTURAL evidence + the
 *    agent's own trace — never the gold answer, never tuned to a train value.
 *  - TRAIN-ONLY EDITS: a layer edit (and a skill-fix application) is REFUSED when
 *    the --from run includes any held-out/test task, so test traces can never
 *    tune the layer and still pass the official gate.
 *  - DON'T REGRESS: minimal atomic edits, re-validated by the all-views gate;
 *    a post-edit failure rolls back ALL edits and leaves provenance untouched.
 *  - HONEST / IDEMPOTENT: when no miss is a structural defect, it edits nothing,
 *    leaves provenance untouched, and reports where each fix belongs.
 *
 * The heavy lifting lives in focused modules: miss-analysis (parse/index/classify),
 * miss-verdict (model manner+owner+fix, tool diagnosis), layer-repair (edit/gate/
 * rollback/provenance), run-log (controllog correlation + traces).
 */
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { columnProfiles, hashLayerOnDisk, readDoc, validateModel, MODELS_DIR, DATA_DIR } from './layer-build.js';
import { LOCAL_DB_PATH } from './load.js';
import * as cl from './controllog.js';
import { MalloyRuntime } from './malloy-runtime.js';
import {
  loadLayerIndex,
  analyzeMiss,
  classifyMiss,
  evidenceBlock,
  referencedViews,
  loadTrainIds,
  nonTrainTaskIds,
  type MissRow,
  type MissCategory,
  type MissOwner,
  type MissClassification,
} from './miss-analysis.js';
import { missVerdict, traceBlock, diagnoseToolError, type FailureManner, type ToolDiagnosis } from './miss-verdict.js';
import { repairFileStage, executeAllViews, snapshotLayer, restoreLayer, restampProvenance } from './layer-repair.js';
import { loadControllog, correlateRun, taskTrace, toolErrorStats, DEFAULT_CONTROLLOG_DIR, type ToolErrorStat } from './run-log.js';

const TABLES = ['payments', 'fees', 'merchants', 'acquirer_countries', 'merchant_category_codes'];
const SKILL_PATH = path.join(MODELS_DIR, '..', '..', 'src', 'skill.md');

export interface MissReport {
  taskId: string;
  category: MissCategory;
  owner: MissOwner;
  /** the MANNER of failure (over/under-specified, hallucination, layer-not-used, …). */
  manner: FailureManner;
  implicatedFiles: string[];
  note: string;
  rationale: string;
  /** the model's recommended fix (kind + a general rule). */
  fix?: { kind: 'skill' | 'linter' | 'layer' | 'model'; detail: string };
  /** trace-derived signals (when a controllog trace was correlated). */
  trace?: { exploredLayer: boolean; usedNamedView: boolean; runMalloyErrors: number; toolCalls: number };
}

export interface ToolHealthFinding extends ToolErrorStat {
  diagnosis?: ToolDiagnosis;
  /** how the finding was acted on. */
  action: 'routed_to_layer_repair' | 'recommended_skill_fix' | 'applied_skill_fix' | 'recommended_linter_fix' | 'reported_only';
}

export interface ImproveResult {
  ok: boolean;
  editsApplied: boolean;
  /** false when the --from run includes held-out tasks → edits + skill-fixes refused. */
  trainOnly: boolean;
  nonTrainTaskIds: string[];
  fromHash: string;
  toHash: string;
  editedFiles: string[];
  misses: MissReport[];
  /** run-level tool-error meta-analysis (flagged tools first). */
  toolHealth: ToolHealthFinding[];
  /** controllog correlation: how many of the run's rows we could trace. */
  trace: { runId: string | null; matched: number; total: number };
  /** any skill.md rule appended. */
  skillFixesApplied: string[];
  cost: number;
  /** human-readable summary of where each miss belongs. */
  summary: string;
  diagnostics?: string;
}

/** Deterministic manner when no model verdict is taken (e.g. --no-manner on a
 *  clearly-skill miss). Coarser than the model's label, but honest. */
function deterministicManner(cls: MissClassification): FailureManner {
  switch (cls.category) {
    case 'no_submission':
      return 'gave_up';
    case 'layer_view_error':
    case 'layer_view_empty':
    case 'layer_view_degenerate':
    case 'query_compile_error':
    case 'query_wrong_answer':
      return 'wrong_logic';
    default:
      return 'other';
  }
}

export async function improveLayer(opts: {
  fromPath: string;
  model: string;
  reasoningEffort?: string;
  provider?: string;
  maxRounds?: number;
  /** connect the runtime to MotherDuck (md:<db>) instead of the local compile DB. */
  motherduckDb?: string;
  /** analyze the MANNER of every miss via the trace (default true). Off → model
   *  call only for layer-suspected misses (the cheap deterministic-only path). */
  manner?: boolean;
  /** append general robustness rules diagnosed from tool errors to src/skill.md
   *  (only honored for train-only runs). */
  applySkillFixes?: boolean;
  /** flag a tool when its error rate exceeds this (default 0.15). */
  toolErrorThreshold?: number;
  controllogDir?: string;
  runId?: string;
}): Promise<ImproveResult> {
  const maxRounds = opts.maxRounds ?? 4;
  const mannerEnabled = opts.manner !== false;
  const fromHash = await hashLayerOnDisk();
  const databasePath = opts.motherduckDb ? `md:${opts.motherduckDb}` : undefined;

  // Read the FULL run (passers + misses). The train-only guard MUST consider
  // every task_id, not just the misses: the tool-error meta-analysis spans the
  // whole run, so a held-out PASSER's trace could otherwise influence a
  // skill/layer write even when all the misses happen to be train.
  const allRows = (await readFile(opts.fromPath, 'utf8')).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as MissRow);
  const misses = allRows.filter((r) => r.is_correct === false);

  // P1 guard: a layer edit (or skill-fix application) must NEVER be driven by a
  // run that includes held-out/test tasks — that would tune the layer/skill on
  // the generalization set while still passing the official gate. Checked over
  // the WHOLE run against the train split.
  const trainIds = await loadTrainIds();
  const nonTrain = nonTrainTaskIds(allRows.map((r) => r.task_id), trainIds);
  const trainOnly = nonTrain.length === 0;

  if (opts.runId) {
    cl.runMetadata({
      runId: opts.runId,
      resolvedConfig: { phase: 'improve', model: opts.model, from: path.basename(opts.fromPath), from_hash: fromHash, provider: opts.provider ?? null, reasoning: opts.reasoningEffort ?? null, substrate: opts.motherduckDb ? 'motherduck' : 'local', manner: mannerEnabled, apply_skill_fixes: !!opts.applySkillFixes, train_only: trainOnly },
      agentName: 'agent:asm-malloy-builder', datasetName: 'agentic_malloy', datasetVersion: 'layer-improve',
    });
  }

  const emptyResult = (summary: string): ImproveResult => ({ ok: true, editsApplied: false, trainOnly, nonTrainTaskIds: nonTrain, fromHash, toHash: fromHash, editedFiles: [], misses: [], toolHealth: [], trace: { runId: null, matched: 0, total: misses.length }, skillFixesApplied: [], cost: 0, summary });
  if (!misses.length) return emptyResult('No incorrect rows in the run — nothing to improve.');

  if (!trainOnly) {
    console.log(`  ⚠️  run includes ${nonTrain.length} held-out/non-train task(s) (${nonTrain.slice(0, 8).join(', ')}${nonTrain.length > 8 ? ', …' : ''}) — layer edits AND skill-fix application are DISABLED (tuning on held-out traces would leak into Phase-3). Triage is report-only.`);
  }

  // Correlate the run to its controllog so we can read the per-task tool TRACE
  // (the manner-of-failure evidence) + the run-level tool-error rates. Best
  // effort: a low match → trace is omitted and we judge from the JSONL alone.
  const events = await loadControllog(opts.controllogDir ?? DEFAULT_CONTROLLOG_DIR);
  const corr = correlateRun(events, allRows);
  const runId = corr.runId;
  console.log(`  trace: ${runId ? `run ${runId.slice(0, 13)} (${corr.matched}/${corr.total} rows matched)` : 'no matching controllog run — JSONL-only evidence'}`);

  const index = await loadLayerIndex();
  const rt = new MalloyRuntime(databasePath ? { databasePath } : {});
  let totalCost = 0;
  const reports: MissReport[] = [];
  const editedFiles: string[] = [];
  const skillFixesApplied: string[] = [];
  let toolHealth: ToolHealthFinding[] = [];
  let diagnostics: string | undefined;

  try {
    const profile = await columnProfiles(TABLES, LOCAL_DB_PATH);
    const profiles = TABLES.map((t) => `### ${t}\n${profile[t]}`).join('\n\n');
    const manual = existsSync(path.join(DATA_DIR, 'dabstep', 'context', 'manual.md'))
      ? await readFile(path.join(DATA_DIR, 'dabstep', 'context', 'manual.md'), 'utf8')
      : '(manual unavailable)';
    const primer = await readDoc('malloy-primer.md');

    // 1. Per miss: deterministic classify + (model) MANNER/owner/fix verdict.
    //    A layer EDIT is gated on (a) train-only run, (b) the deterministic
    //    structural probe (layerSuspected: a named view broke/empty) AND (c) the
    //    model owner==='layer' — the model cannot conjure a defect the data
    //    doesn't show, and held-out runs never edit.
    const defectsByFile = new Map<string, string[]>();
    for (const row of misses) {
      const a = await analyzeMiss(row, rt, index);
      const cls = classifyMiss(a);
      const trace = runId ? taskTrace(events, runId, a.taskId) : null;
      const usedNamedView = a.malloySource ? referencedViews(a.malloySource, index).length > 0 : false;
      console.log(`  miss ${a.taskId}: ${cls.category} → ${cls.suggestedOwner}${cls.layerSuspected ? ' (layer-suspected)' : ''}`);

      let owner: MissOwner = cls.suggestedOwner;
      let manner: FailureManner = deterministicManner(cls);
      let rationale = cls.note;
      let fix: MissReport['fix'];
      let file = cls.implicatedFiles[0] ?? null;

      if (mannerEnabled || cls.layerSuspected) {
        const v = await missVerdict({
          evidence: evidenceBlock(a, cls),
          trace: traceBlock(trace, a.predictedAnswer, usedNamedView),
          implicatedFile: file,
          implicatedFileSrc: file && existsSync(path.join(MODELS_DIR, file)) ? await readFile(path.join(MODELS_DIR, file), 'utf8') : null,
          profiles,
          manual,
          model: opts.model,
          reasoningEffort: opts.reasoningEffort,
          provider: opts.provider,
        });
        totalCost += v.cost;
        owner = v.owner;
        manner = v.manner;
        rationale = v.rationale || cls.note;
        fix = v.fix;
        if (v.owner === 'layer' && v.file && existsSync(path.join(MODELS_DIR, v.file))) file = v.file;
        console.log(`    verdict ${a.taskId}: manner=${v.manner} owner=${v.owner}${v.owner === 'layer' ? ` (${file})` : ''} — ${v.rationale}`);

        // Layer edit only when train-only AND the deterministic probe AND the model agree.
        if (trainOnly && cls.layerSuspected && v.owner === 'layer' && file) {
          const list = defectsByFile.get(file) ?? [];
          list.push(`### Miss ${a.taskId}\n${evidenceBlock(a, cls)}\nModel-confirmed defect: ${v.defect}`);
          defectsByFile.set(file, list);
        }
        if (opts.runId && fix && fix.kind !== 'layer') {
          cl.event({ kind: 'improvement_recommendation', taskId: a.taskId, agentId: 'agent:asm-malloy-builder', runId: opts.runId, payload: { source: 'miss', manner, owner, fix_kind: fix.kind, detail: fix.detail, rationale } });
        }
      }

      reports.push({
        taskId: a.taskId, category: cls.category, owner, manner, implicatedFiles: cls.implicatedFiles, note: cls.note, rationale, fix,
        trace: trace ? { exploredLayer: trace.exploredLayer, usedNamedView, runMalloyErrors: trace.runMalloyErrors, toolCalls: trace.toolCalls } : undefined,
      });
    }

    // 2. Tool-error META-ANALYSIS: any tool failing > threshold gets a model
    //    diagnosis. A layer-cause (a broken view) routes into the repair path;
    //    skill/linter causes become recommendations (applied to skill.md when
    //    train-only + applySkillFixes).
    if (runId) {
      const stats = toolErrorStats(events, runId, { threshold: opts.toolErrorThreshold ?? 0.15 });
      const flagged = stats.filter((s) => s.flagged);
      console.log(`  tool-error meta-analysis (run ${runId.slice(0, 13)}): ${flagged.length} tool(s) over ${(100 * (opts.toolErrorThreshold ?? 0.15)).toFixed(0)}% error rate${flagged.length ? ': ' + flagged.map((s) => `${s.tool} ${(s.rate * 100).toFixed(0)}%`).join(', ') : ''}`);
      toolHealth = stats.map((s) => ({ ...s, action: 'reported_only' as ToolHealthFinding['action'] }));
      for (const finding of toolHealth) {
        if (!finding.flagged) continue;
        const d = await diagnoseToolError({ stat: finding, manual, model: opts.model, reasoningEffort: opts.reasoningEffort, provider: opts.provider });
        totalCost += d.cost;
        finding.diagnosis = { cause: d.cause, fixKind: d.fixKind, detail: d.detail, file: d.file };
        console.log(`    diagnose ${finding.tool}: ${d.fixKind} — ${d.cause}`);

        // Route a LAYER cause into repair only when train-only AND the named file
        // actually has a currently-broken view (structural corroboration) — never
        // edit a clean file on a tool-error guess, never from a held-out run.
        if (trainOnly && d.fixKind === 'layer' && d.file && existsSync(path.join(MODELS_DIR, d.file)) && (await layerFileBroken(d.file))) {
          const list = defectsByFile.get(d.file) ?? [];
          list.push(`### Recurring tool error (${finding.tool}, ${(finding.rate * 100).toFixed(0)}% of calls)\nCause: ${d.cause}\nSample errors:\n${finding.samples.map((x) => '  - ' + x).join('\n')}`);
          defectsByFile.set(d.file, list);
          finding.action = 'routed_to_layer_repair';
        } else if (d.fixKind === 'skill' && opts.applySkillFixes && trainOnly && d.detail) {
          await appendSkillRule(d.detail, `${finding.tool} errored ${(finding.rate * 100).toFixed(0)}% of the time: ${d.cause}`);
          skillFixesApplied.push(d.detail);
          finding.action = 'applied_skill_fix';
        } else if (d.fixKind === 'skill') {
          finding.action = 'recommended_skill_fix';
        } else if (d.fixKind === 'linter') {
          finding.action = 'recommended_linter_fix';
        }
        if (opts.runId) {
          cl.event({ kind: 'improvement_recommendation', taskId: finding.tool, agentId: 'agent:asm-malloy-builder', runId: opts.runId, payload: { source: 'tool', tool: finding.tool, error_rate: finding.rate, calls: finding.calls, errors: finding.errors, fix_kind: d.fixKind, cause: d.cause, detail: d.detail, action: finding.action } });
        }
      }
      if (opts.runId) cl.event({ kind: 'tool_health', agentId: 'agent:asm-malloy-builder', runId: opts.runId, payload: { stats: toolHealth.map((s) => ({ tool: s.tool, calls: s.calls, errors: s.errors, rate: s.rate, flagged: s.flagged, action: s.action })) } });
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
      await restampProvenance({ fromHash, toHash, model: opts.model, editedFiles, fromRun: opts.fromPath, fromSplits: ['train'] });
    }

    return {
      ok: editsApplied || !diagnostics,
      editsApplied,
      trainOnly,
      nonTrainTaskIds: nonTrain,
      fromHash,
      toHash,
      editedFiles,
      misses: reports,
      toolHealth,
      trace: corr,
      skillFixesApplied,
      cost: totalCost,
      summary: renderSummary({ reports, toolHealth, editedFiles, skillFixesApplied, fromHash, toHash, trainOnly, nonTrain, diagnostics }),
      diagnostics,
    };
  } finally {
    await rt.close();
  }
}

/** True if the named layer file currently has a view that fails to execute —
 *  structural corroboration before routing a tool-error diagnosis into repair. */
async function layerFileBroken(file: string): Promise<boolean> {
  return !(await validateModel(file)).ok;
}

/** Append a GENERAL robustness rule (diagnosed from a recurring tool error) to a
 *  clearly-marked section of src/skill.md. The skill is a tunable prompt, NOT the
 *  layer — editing it does not affect malloy_provenance. Deduped by rule text. */
async function appendSkillRule(rule: string, because: string): Promise<void> {
  let skill = '';
  try {
    skill = await readFile(SKILL_PATH, 'utf8');
  } catch {
    return; // no skill.md → nothing to append to
  }
  if (skill.includes(rule.trim())) return; // already present
  const HEADER = '## Auto-added robustness rules (layer-improve)';
  const bullet = `- ${rule.trim()}  _(why: ${because})_`;
  const next = skill.includes(HEADER) ? `${skill.trimEnd()}\n${bullet}\n` : `${skill.trimEnd()}\n\n${HEADER}\n${bullet}\n`;
  await writeFile(SKILL_PATH, next);
}

const MANNER_LABEL: Record<FailureManner, string> = {
  overspecified: 'over-specified', underspecified: 'under-specified', hallucination: 'hallucination',
  layer_not_used: 'layer-not-used', wrong_logic: 'wrong-logic', gave_up: 'gave-up', other: 'other',
};

function renderSummary(o: {
  reports: MissReport[];
  toolHealth: ToolHealthFinding[];
  editedFiles: string[];
  skillFixesApplied: string[];
  fromHash: string;
  toHash: string;
  trainOnly: boolean;
  nonTrain: string[];
  diagnostics?: string;
}): string {
  const lines: string[] = [];
  const byOwner = (owner: MissOwner) => o.reports.filter((r) => r.owner === owner);
  lines.push(`Triaged ${o.reports.length} miss(es) — owner · manner:`);
  for (const owner of ['layer', 'skill', 'answering', 'model'] as MissOwner[]) {
    const rs = byOwner(owner);
    if (!rs.length) continue;
    lines.push(`  ${owner}: ${rs.map((r) => r.taskId).join(', ')}`);
    for (const r of rs) {
      const where = r.implicatedFiles.length ? ` [${r.implicatedFiles.join(', ')}]` : '';
      const fix = r.fix && r.fix.kind !== 'layer' && r.fix.detail ? `  → ${r.fix.kind}: ${r.fix.detail}` : '';
      lines.push(`    - ${r.taskId} · ${MANNER_LABEL[r.manner]} (${r.category})${where}: ${r.rationale}${fix}`);
    }
  }

  const flagged = o.toolHealth.filter((s) => s.flagged);
  if (flagged.length) {
    lines.push(`\nTool-error meta-analysis — ${flagged.length} tool(s) over the error-rate threshold:`);
    for (const s of flagged) {
      lines.push(`  ${s.tool}: ${(s.rate * 100).toFixed(0)}% (${s.errors}/${s.calls})${s.diagnosis ? ` — ${s.diagnosis.fixKind}: ${s.diagnosis.cause}` : ''} [${s.action}]`);
      if (s.diagnosis?.detail) lines.push(`     fix: ${s.diagnosis.detail}`);
    }
  } else if (o.toolHealth.length) {
    lines.push(`\nTool-error meta-analysis: no tool over the error-rate threshold.`);
  }
  if (o.skillFixesApplied.length) lines.push(`\nApplied ${o.skillFixesApplied.length} robustness rule(s) to src/skill.md.`);

  if (!o.trainOnly) {
    lines.push(`\n⚠️  Layer edits + skill-fixes REFUSED: the run includes ${o.nonTrain.length} held-out/non-train task(s) (${o.nonTrain.slice(0, 8).join(', ')}${o.nonTrain.length > 8 ? ', …' : ''}). Tuning on held-out traces would leak into Phase-3. Re-run with a train-only results file to edit.`);
  }

  if (o.editedFiles.length) {
    lines.push(`\nEdited (model_authored preserved): ${o.editedFiles.join(', ')}`);
    lines.push(`Layer hash ${o.fromHash} → ${o.toHash}. Re-run evaluate to measure.`);
  } else {
    lines.push(`\nNo layer files edited — ${o.trainOnly ? 'no miss was a structural layer defect' : 'edits refused (non-train run)'}.`);
    if (o.diagnostics) lines.push(`(attempt blocked: ${o.diagnostics})`);
    lines.push(`The fixes above belong in the answering skill/prompt or are model-capability limits, not the layer.`);
  }
  return lines.join('\n');
}
