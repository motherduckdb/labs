/**
 * layer-repair — the WRITE side of layer-improve. Apply minimal atomic {old,new}
 * edits to one layer file (mirrors layer-build's edit-mode authorStage), the
 * full all-views no-regression gate, a snapshot/restore for rollback, and the
 * provenance re-stamp.
 *
 * Provenance is re-stamped `model_authored` (model-made, atomic, execution-gated
 * edits — no human touched the layer), but ONLY the orchestrator drives this and
 * ONLY for train-driven edits (held-out runs never reach here — see the P1 guard
 * in layer-improve). The lineage records the splits the edit was driven by.
 */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { complete } from './llm-client.js';
import { MalloyRuntime } from './malloy-runtime.js';
import { DUCKDB_NOTES, MODELS_DIR, META_DIR, parseEdits, extractBlocks, validateModel, PROVENANCE_PATH, VIEW_VALIDATION_TIMEOUT_MS } from './layer-build.js';
import { countRawSqlInMalloy } from './linter.js';
import * as cl from './controllog.js';

const REPAIR_SYSTEM_HEADER = `You are a Malloy expert REPAIRING one file of an existing semantic layer. A view/source in this file has a STRUCTURAL defect (it errors at execution, or returns 0/empty over rows that exist, or computes at the wrong grain). Fix the DEFECT generically — make the layer correct per the manual + the data's actual encodings (the column profile).

ABSOLUTE RULE: do NOT tune anything to a specific answer value. You are given NO gold answers. A correct fix is one that makes the view structurally sound for ANY input (correct join scope, correct wildcard/domain handling, correct grain), not one that nudges a number. Make the MINIMAL edits that fix ONLY the described defect — do not rewrite, reorder, or restructure anything else, and do not change views that already work.`;

// Appended when the defect is a COVERAGE GAP (a missing source/view this file
// should provide by analogy to siblings already in it) rather than a broken view.
const ADDITIVE_NOTE = `

ADDITIVE REPAIR IS IN SCOPE HERE: the defect describes a source/view that is MISSING from this file — a coverage gap relative to SIBLING sources already present. You SHOULD ADD it, authored by CLOSE ANALOGY to the named sibling(s): copy their exact matching / wildcard / re-pricing structure verbatim and change ONLY the steered dimension (the column the candidate set enumerates and the equality it drives in the re-match). Expose the same shape of ranking view(s) the siblings expose. Express the addition as ONE atomic edit whose "old" is a UNIQUE snippet copied verbatim from the file (e.g. its final non-empty lines) and whose "new" is that exact snippet followed by the new source/view. Do NOT alter the sibling sources or any view that already works.`;

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
  /** the defect is a COVERAGE GAP (a missing source to add by analogy), not a
   *  broken view — permit an additive edit + use the additive instructions. */
  allowAdditive?: boolean;
}): Promise<RepairResult> {
  const agg = { cost: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cacheWriteTokens: 0 };
  const modelPath = path.join(MODELS_DIR, opts.file);
  let current = await readFile(modelPath, 'utf8');
  let diag = '';
  let totalApplied = 0;
  const system = `${REPAIR_SYSTEM_HEADER}${opts.allowAdditive ? ADDITIVE_NOTE : ''}\n\n=== MALLOY PRIMER ===\n${opts.primer}\n\n${DUCKDB_NOTES}`;

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
        `Each "old" must appear exactly once in the file. ` +
        (opts.allowAdditive
          ? `ADD the missing source/view by analogy to the named sibling(s) — emit ONE edit whose "old" is a unique verbatim snippet (e.g. the file's final lines) and whose "new" repeats it then appends the new source, reusing the siblings' exact wildcard-aware re-matching and changing only the steered dimension.`
          : `Fix ONLY the described structural defect (typed raw escapes fn!returntype, wildcard branch on every match field, materialize join attributes as real columns before a join_many, qualify join keys).`) +
        errSuffix,
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

    // Additive fallback: Opus often ignores the JSON {old,new} protocol and returns the
    // new sibling source as a ```malloy block (prose + code) instead — parseEdits then
    // finds nothing and the additive repair silently no-ops. In ADDITIVE mode, appending
    // that block IS the intended repair; the raw-SQL gate + full compile/all-views
    // validation below reject a broken/incomplete/duplicate block and roll back, so this
    // can only help. (Non-additive fixes still require verbatim {old,new} edits.)
    if (applied === 0 && opts.allowAdditive) {
      const block = extractBlocks(resp.text).malloy;
      if (block && block.trim() && !current.includes(block.trim())) {
        patched = `${current.replace(/\s*$/, '')}\n\n${block.trim()}\n`;
        applied = 1;
        console.log(`  … improve ${opts.file} round ${round}: appended a fenced malloy block (model returned code, not JSON edits)`);
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
    // RAW-SQL GATE (hard): the layer must stay Malloy-only. An edit may NOT introduce
    // a NEW `duckdb.sql(...)` block (pre-existing blocks are grandfathered — an edit
    // elsewhere isn't blocked by them, but the count must not grow). Reject WITHOUT
    // writing so the bad edit never persists, and force a retry.
    if (countRawSqlInMalloy(patched) > countRawSqlInMalloy(current)) {
      diag =
        'PROHIBITED: your edit introduces a NEW `duckdb.sql(...)` raw-SQL block. Raw SQL is not allowed in the semantic layer. Re-do the fix in PURE Malloy (joins via join_one/join_many, value universes via a Malloy query/group_by or the typed unnest escape over the base table, individual functions via `fn!returntype(...)`). Return edits with no `duckdb.sql(...)`.';
      console.log(`  ✗ improve ${opts.file} round ${round}: REJECTED — edit adds duckdb.sql(...) (raw SQL prohibited)`);
      if (round === opts.maxRounds) return { ok: false, file: opts.file, rounds: round, applied: totalApplied, diag, ...agg };
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
      const r = await rt.run(`run: ${s} -> ${view}`, 1, VIEW_VALIDATION_TIMEOUT_MS);
      if (!r.ok) {
        return { ok: false, diag: `\`${s} -> ${view}\` fails to execute:\n${(r.diagnostics ?? []).map((d) => d.message).join('\n')}` };
      }
    }
  }
  return { ok: true, diag: '' };
}

export type Snapshot = { models: Record<string, string>; meta: Record<string, string> };

export async function snapshotLayer(): Promise<Snapshot> {
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

export async function restoreLayer(snap: Snapshot): Promise<void> {
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

export async function restampProvenance(opts: {
  fromHash: string;
  toHash: string;
  model: string;
  editedFiles: string[];
  fromRun: string;
  /** the task-id splits the edit was driven by — always train-only (the P1 guard
   *  refuses edits otherwise); recorded for auditability. */
  fromSplits?: string[];
}): Promise<void> {
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
    from_splits: opts.fromSplits ?? ['train'],
    train_only: true,
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
