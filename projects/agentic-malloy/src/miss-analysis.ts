/**
 * miss-analysis — parse an eval run's misses, map each to the layer file(s) it
 * implicates, gather re-execution EVIDENCE (re-run the submitted Malloy + smoke
 * each named layer view it used), and deterministically classify the miss
 * (layer defect vs. skill vs. answering). Everything model-free here; the pure
 * pieces (index, mapping, classification) are unit-tested.
 *
 * NO LEAKAGE: nothing here reads the gold answer. `trainOnly` (below) is the
 * guard that keeps held-out/test runs from ever driving a layer edit.
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { MalloyRuntime } from './malloy-runtime.js';
import { MODELS_DIR, sourceNamesIn, DATA_DIR } from './layer-build.js';
import { viewQualitySmells, type Smell } from './view-quality.js';

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
// Train-split guard (P1): a layer edit must NEVER be driven by held-out/test
// traces — that would tune the layer on the generalization set while still
// passing the official gate. We check actual task_ids against split.json's
// train_ids (robust; doesn't trust the row's recorded `split` field).
// ---------------------------------------------------------------------------

/** The train task ids from data/split.json. */
export async function loadTrainIds(dataDir = DATA_DIR): Promise<Set<string>> {
  const ids: string[] = JSON.parse(await readFile(path.join(dataDir, 'split.json'), 'utf8')).train_ids;
  return new Set(ids.map(String));
}

/** Task ids that are NOT in the train set — if non-empty, the run includes
 *  held-out questions and must not drive layer edits. Pure + testable. */
export function nonTrainTaskIds(taskIds: Array<string | number>, trainIds: Set<string>): string[] {
  return taskIds.map(String).filter((id) => !trainIds.has(id));
}

// ---------------------------------------------------------------------------
// Layer index — source/view → file. Malloy views are SOURCE-SCOPED (and this
// layer reuses view names across sources, e.g. by_account_type / by_mcc /
// listing), so a global view→file map probes the WRONG file. Source NAMES are
// globally unique (one compilation unit) and a view is colocated with the source
// that defines it, so we resolve everything through the source. Pure over the
// file bodies → unit-testable without a runtime.
// ---------------------------------------------------------------------------

export interface LayerIndex {
  /** source name -> the .malloy file that defines it (unambiguous). */
  fileOfSource: Map<string, string>;
  /** source name -> the view names defined directly on it (source-scoped). */
  viewsBySource: Map<string, Set<string>>;
  /** every source name defined anywhere. */
  sources: Set<string>;
  /** sources implementing a COUNTERFACTUAL / steering pattern — they enumerate a
   *  candidate set and re-evaluate as if a dimension were changed (CROSS JOIN over
   *  `candidate_<dim>`, or a `*_steering`/`*_counterfactual` source name) → the
   *  dimension(s) they enumerate + the file. This is the structural signal that
   *  the layer KNOWS HOW to express counterfactuals; the pattern-gap detector uses
   *  it to spot a steering question answered with a non-counterfactual surface. */
  counterfactualSources: Map<string, { file: string; dims: string[] }>;
}

const SOURCE_DEF_RE = /^[ \t]*source:[ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]+is\b/gm;
const VIEW_DEF_RE = /^[ \t]*view:[ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]+is\b/gm;
const CANDIDATE_RE = /\bcandidate_([A-Za-z][A-Za-z0-9_]*)/g;

/**
 * Does a source BODY (its definition span) implement a counterfactual/steering
 * pattern? The robust structural tell is a CROSS JOIN against an enumerated set of
 * `candidate_<dim>` values (the "re-price as if dim were each candidate" shape);
 * a `*_steering`/`*_counterfactual` source name is a softer fallback. Returns the
 * enumerated dimension token(s), or null when it's an ordinary source. Pure.
 */
export function detectCounterfactualSource(name: string, body: string): string[] | null {
  const dims = new Set<string>();
  for (const m of body.matchAll(CANDIDATE_RE)) dims.add(m[1].toLowerCase());
  const hasCrossJoinCandidates = /\bcross\s+join\b/i.test(body) && dims.size > 0;
  const byName = /(steering|counterfactual)/i.test(name);
  if (hasCrossJoinCandidates || byName) return dims.size ? [...dims] : ['(unspecified)'];
  return null;
}

/**
 * Build the source-scoped index from a map of file -> body. Views are attributed
 * to the source whose `extend { … }` block they fall in (by source-definition
 * order within the file), so duplicate view names across sources stay distinct.
 * Each source's body SPAN (def → next def / EOF) is also scanned for the
 * counterfactual/steering pattern.
 */
export function buildLayerIndex(bodyOf: Record<string, string>): LayerIndex {
  const fileOfSource = new Map<string, string>();
  const viewsBySource = new Map<string, Set<string>>();
  const sources = new Set<string>();
  const counterfactualSources = new Map<string, { file: string; dims: string[] }>();
  for (const [file, body] of Object.entries(bodyOf)) {
    // Find each source definition and where it starts, in order.
    const defs: Array<{ name: string; at: number }> = [];
    for (const m of body.matchAll(SOURCE_DEF_RE)) defs.push({ name: m[1], at: m.index ?? 0 });
    for (let i = 0; i < defs.length; i++) {
      const { name, at } = defs[i];
      sources.add(name);
      if (!fileOfSource.has(name)) fileOfSource.set(name, file);
      if (!viewsBySource.has(name)) viewsBySource.set(name, new Set());
      // Scan only THIS source's span so `candidate_*` in a sibling source below it
      // is not mis-attributed.
      const end = i + 1 < defs.length ? defs[i + 1].at : body.length;
      const cf = detectCounterfactualSource(name, body.slice(at, end));
      if (cf && !counterfactualSources.has(name)) counterfactualSources.set(name, { file, dims: cf });
    }
    // Attribute each view to the nearest preceding source definition in the file.
    for (const vm of body.matchAll(VIEW_DEF_RE)) {
      const at = vm.index ?? 0;
      let owner: string | null = null;
      for (const d of defs) if (d.at < at) owner = d.name;
        else break;
      if (owner) viewsBySource.get(owner)!.add(vm[1]);
    }
  }
  return { fileOfSource, viewsBySource, sources, counterfactualSources };
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

/** The head source of a query — the identifier right after `run:`/`query: … is`,
 *  else a bare leading `SRC ->`. This is the source the answer is computed from,
 *  and (with source-scoping) disambiguates which view was used. Pure. */
export function parseHeadSource(src: string): string | null {
  const m =
    src.match(/\brun:\s*([A-Za-z_][A-Za-z0-9_]*)/) ??
    src.match(/\bquery:\s*[A-Za-z_][A-Za-z0-9_]*\s+is\s+([A-Za-z_][A-Za-z0-9_]*)/) ??
    src.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*->/);
  return m ? m[1] : null;
}

/**
 * Map a submitted Malloy snippet to the layer file(s) it implicates: the files
 * that define any SOURCE the snippet references (a view lives in its source's
 * file, so source resolution covers views too). Source-keyed → unambiguous. Pure.
 */
export function mapMalloyToFiles(src: string, index: LayerIndex): string[] {
  if (!src) return [];
  const files: string[] = [];
  for (const tok of identifiersIn(src)) {
    if (!index.sources.has(tok)) continue;
    const f = index.fileOfSource.get(tok);
    if (f && !files.includes(f)) files.push(f);
  }
  return files;
}

/**
 * Named layer views referenced in a snippet, resolved against the HEAD SOURCE
 * (source-scoped) so a view name shared by several sources resolves to the right
 * one. Returns {source, view} pairs. Pure.
 */
export function referencedViews(src: string, index: LayerIndex): Array<{ source: string; view: string }> {
  const head = parseHeadSource(src);
  if (!head) return [];
  const views = index.viewsBySource.get(head);
  if (!views || views.size === 0) return [];
  const toks = new Set(identifiersIn(src));
  return [...views].filter((v) => toks.has(v)).map((v) => ({ source: head, view: v }));
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
  /** degeneracy smells from the view's OWN output (it runs but is meaningless —
   *  e.g. a "ranking" where most rows tie at the max). Closed-book; see I1. */
  smells?: Smell[];
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
  | 'layer_view_degenerate'
  | 'layer_pattern_gap'
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
  const degenerateView = a.viewProbes.find((p) => p.ok && (p.smells?.length ?? 0) > 0);
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
    // Submitted Malloy ERRORS. The agent's own inline query is broken — that's a
    // skill/answering issue regardless of any referenced view's quality, so this
    // is checked BEFORE the degeneracy branch (a degenerate view must not steal
    // the blame for the agent's broken query and misroute it to layer repair).
    return {
      category: 'query_compile_error',
      layerSuspected: false,
      suggestedOwner: 'skill',
      implicatedFiles: files,
      note: `the agent's submitted Malloy fails to compile/execute, but the layer views it referenced run clean on their own — the defect is in the agent's inline query (a skill/answering issue): ${reExec.error?.slice(0, 200)}`,
    };
  }

  // From here the submitted Malloy re-ran successfully (so any defect is in the
  // LAYER it built on, not the agent's query).
  if (degenerateView) {
    // A named layer view RUNS but is DEGENERATE on its own (e.g. a "ranking" where
    // most groups tie at the max because the grain folds in wildcard rows — the
    // 1442 case). It executes, so the binary error/empty probes miss it; the
    // smells catch it. This is a wrong-GRAIN layer defect, not the agent's logic.
    return {
      category: 'layer_view_degenerate',
      layerSuspected: true,
      suggestedOwner: 'layer',
      implicatedFiles: degenerateView.file ? [degenerateView.file, ...files.filter((f) => f !== degenerateView.file)] : files,
      note: `named layer view \`${degenerateView.source} -> ${degenerateView.view}\` runs but is DEGENERATE — ${degenerateView.smells?.[0]?.message ?? 'no discriminating output'}. Likely a wrong-grain layer defect, not the agent's query.`,
    };
  }

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

// ---------------------------------------------------------------------------
// Pattern-consistency gate (closed-book). A view can run clean and return
// healthy, well-varied rows yet still be the WRONG MODEL for the question —
// e.g. "to which scheme should the merchant steer traffic to pay min fees?"
// answered by ranking the fees ACTUALLY paid per scheme (partition-by-actual)
// instead of re-pricing ALL traffic onto each candidate scheme (counterfactual).
// The binary error/empty/degeneracy probes can't see this; the structural tell
// is an ASYMMETRY — the layer already implements the counterfactual pattern for
// SIBLING dimensions but is MISSING it for this question's dimension.
// ---------------------------------------------------------------------------

const STEER_RE: RegExp[] = [
  /\bsteer(s|ed|ing)?\b/i,
  /\bmove[\s\S]{0,40}?\bto\b[\s\S]{0,25}?\bdifferent\b/i,
  /\bswitch(es|ed|ing)?[\s\S]{0,40}?\bto\b[\s\S]{0,25}?\bdifferent\b/i,
  /\breassign(s|ed|ing)?\b/i,
  /\bto which\b[\s\S]{0,60}?\bshould\b/i,
];

// A glossary term/alias only counts as steering vocabulary if it itself names a
// steering ACTION — so a bare dimension noun ("ACI") can't smuggle in via a
// DIMENSION entry whose description happens to mention counterfactual steering.
const STEER_TERM_RE = /\bsteer|\bre-?price|\breassign|\bmove\b[\s\S]{0,30}?\bto\b|\bswitch\b[\s\S]{0,30}?\bto\b/i;

/**
 * The steering/counterfactual PHRASES drawn from a glossary: only SCENARIO entries'
 * terms/aliases that themselves name a steering action. Augments the generic
 * STEER_RE lexicon for domain phrasings without admitting dimension nouns. Pure.
 */
export function steeringVocabulary(entries: Array<{ kind?: string; term?: string; aliases?: string[] }>): string[] {
  return entries
    .filter((e) => e.kind === 'scenario')
    .flatMap((e) => [e.term ?? '', ...(e.aliases ?? [])])
    .filter((t) => !!t && STEER_TERM_RE.test(t));
}

/**
 * Is this a counterfactual STEERING question — one that asks what WOULD happen if
 * some dimension were changed ("steer/move … to a different X", "to which X
 * should …")? Generic lexicon (no dataset facts); `extraTerms` lets the caller add
 * the glossary's own scenario aliases (see steeringVocabulary). Pure.
 */
export function isSteeringQuestion(question: string, extraTerms: string[] = []): boolean {
  if (!question) return false;
  if (STEER_RE.some((re) => re.test(question))) return true;
  const q = question.toLowerCase();
  return extraTerms.some((t) => t && t.length >= 4 && q.includes(t.toLowerCase()));
}

/**
 * The pattern-consistency gate: when a CLEAN-running steering miss was answered
 * with a NON-counterfactual surface while the layer DOES implement counterfactual
 * re-pricing for sibling dimensions, that asymmetry is a layer COVERAGE GAP (a
 * missing counterfactual sibling source) — repairable by analogy. Returns a
 * layer-suspected classification, or null when it doesn't apply (caller keeps the
 * original skill classification).
 *
 * NEVER speculative: requires (a) the query ran clean AND returned rows (no
 * structural probe owns it), (b) every referenced view is itself healthy, AND
 * (c) the layer ALREADY contains ≥1 counterfactual source (the capability + the
 * template). If the agent's head source is itself counterfactual, there's no gap.
 * Closed-book: keys off the question intent + the layer's OWN structure, never gold.
 */
export function detectPatternGap(a: MissAnalysis, index: LayerIndex, opts: { isSteering: boolean }): MissClassification | null {
  if (!opts.isSteering || !a.malloySource) return null;
  if (!a.reExec || !a.reExec.ok || a.reExec.rowCount === 0) return null; // only the wrong-but-HEALTHY case
  if (a.viewProbes.some((p) => !p.ok || p.rowCount === 0 || (p.smells?.length ?? 0) > 0)) return null;
  const cf = index.counterfactualSources;
  if (cf.size === 0) return null; // no sibling template/capability → don't conjure one
  const head = parseHeadSource(a.malloySource);
  if (head && cf.has(head)) return null; // already answered with a counterfactual source
  // Land the new sibling in the file that holds the existing counterfactual
  // sources (prefer the head source's own file when it co-locates them).
  const cfFiles = [...cf.values()].map((v) => v.file);
  const headFile = head ? index.fileOfSource.get(head) : undefined;
  const file = headFile && cfFiles.includes(headFile) ? headFile : cfFiles[0];
  const siblings = [...cf.keys()];
  return {
    category: 'layer_pattern_gap',
    layerSuspected: true,
    suggestedOwner: 'layer',
    implicatedFiles: [file, ...a.implicatedFiles.filter((f) => f !== file)],
    note:
      `this is a counterfactual/steering question, but it was answered with \`${head ?? '?'}\` — a NON-counterfactual surface that ranks ACTUAL (observed) values rather than re-pricing all traffic onto each candidate. ` +
      `The layer DOES implement the counterfactual pattern for sibling dimensions (${siblings.join(', ')}), so a counterfactual source for THIS question's dimension appears to be MISSING. ` +
      `Adding it by analogy to the sibling source(s) is a layer fix, not a skill fix (the agent cannot rebuild the wildcard-aware re-matching inline).`,
  };
}

/**
 * Gather re-execution evidence for one miss: re-run the submitted Malloy and
 * smoke each named layer view it referenced (resolved source-scoped via the head
 * source, so the probe hits the right source/file). The derived classification
 * (classifyMiss) is a separate pure step.
 */
export async function analyzeMiss(row: MissRow, rt: MalloyRuntime, index: LayerIndex): Promise<MissAnalysis> {
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

    // Smoke each referenced named view on its own (the structural-defect probe),
    // source-scoped so a shared view name hits the source actually queried. Pull
    // enough rows (not just 1) so the degeneracy detector can judge the view's
    // output distribution — a view that runs but doesn't discriminate is a
    // wrong-grain LAYER defect the error/empty probes can't see (I1).
    for (const { source, view } of referencedViews(malloySource, index)) {
      const pr = await rt.run(`run: ${source} -> ${view}`, 500);
      viewProbes.push({
        source,
        view,
        file: index.fileOfSource.get(source),
        ok: pr.ok,
        rowCount: pr.rows?.length ?? 0,
        error: pr.ok ? undefined : (pr.diagnostics ?? []).map((d) => d.message).join('\n'),
        smells: pr.ok ? viewQualitySmells(pr.rows ?? []) : undefined,
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
      for (const s of p.smells ?? []) lines.push(`      ⚠ DEGENERATE: ${s.message}`);
    }
  }
  lines.push(`\nDeterministic triage: ${cls.category} — ${cls.note}`);
  return lines.join('\n');
}
