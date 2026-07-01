/**
 * miss-verdict — the MODEL layer of triage. Per miss: a verdict labeling the
 * MANNER of failure (over/under-specified, hallucination, layer-not-used,
 * wrong-logic, gave-up), WHERE the fix belongs (owner), and a recommended fix.
 * Plus the run-level tool-error diagnosis. All prompts are fed STRUCTURAL
 * evidence + the agent's own trace ONLY — never the gold answer.
 */
import { complete } from './llm-client.js';
import { answerShape, type TaskTrace, type ToolErrorStat } from './run-log.js';
import type { MissOwner } from './miss-analysis.js';

/** Robustly pull the intended JSON object out of a model response that may wrap it
 *  in reasoning prose, a ```json fence, or Malloy snippets with stray `{ }`. The
 *  old greedy `/\{[\s\S]*\}/` spanned the FIRST `{` to the LAST `}`, so any brace
 *  outside the JSON (a `{ where: … }` in the model's rationale) made JSON.parse
 *  throw — silently defaulting the verdict to skill/no-edit. Strategy: prefer a
 *  fenced block, else collect every BALANCED-brace `{…}` span and try them
 *  LAST-first (the intended JSON is emitted last, after any reasoning). Returns the
 *  first candidate that parses to an object, else null. */
function extractJsonObject(text: string): Record<string, unknown> | null {
  const candidates: string[] = [];
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) candidates.push(fence[1].trim());
  const spans: string[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === '}' && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        spans.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  candidates.push(...spans.reverse()); // the intended JSON comes last → try last-first
  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      /* not this candidate — try the next */
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Trace evidence (the MANNER-of-failure inputs) — structural-only, NO gold.
// ---------------------------------------------------------------------------

/** Summarize one task's tool trace for a model prompt — the agent's OWN actions
 *  (tool calls, args, ok/error), how it explored the layer, and its answer shape.
 *  No gold answer; the predicted answer feeds only the coarse answer-shape. */
export function traceBlock(trace: TaskTrace | null, predicted: unknown, usedNamedView: boolean, namedViews: string[] = []): string {
  const shape = answerShape(predicted);
  const lines: string[] = [];
  if (trace) {
    lines.push(`Tool-call trace (the agent's own actions, in order):`);
    for (const s of trace.steps) {
      const a = s.args !== undefined ? ` ${JSON.stringify(s.args).slice(0, 120)}` : '';
      const out = !s.ok ? `: ${(s.output ?? '').slice(0, 160)}` : '';
      lines.push(`  ${s.name}${a} -> ${s.ok ? 'ok' : 'ERROR'}${out}`);
    }
    lines.push(`Explored the layer (list_malloy_files/get_file): ${trace.exploredLayer ? 'yes' : 'NO'}. run_malloy errors: ${trace.runMalloyErrors}. submit errors: ${trace.submitErrors}.`);
  } else {
    lines.push(`(no tool trace available for this task — judging from the submitted Malloy + answer shape only)`);
  }
  // 2B.2 — distinguish a FAITHFUL REUSE of a named layer view (the wrong
  // computation may be baked into the VIEW → owner can be 'layer') from the
  // agent's OWN inline query (wrongness there → 'skill'). Structural only; no gold.
  if (usedNamedView) {
    const list = namedViews.length ? ` (${namedViews.join(', ')})` : '';
    lines.push(
      `Reused a NAMED layer view/measure in the final answer: yes${list}. This is a FAITHFUL REUSE — a thin where/order_by/limit refinement of a PRE-BUILT layer view, NOT the agent's own inline group_by/aggregate/order_by. If the wrong ranking/aggregation/grain is BAKED INTO that named view, the agent cannot fix it from its query → the defect is the LAYER's.`,
    );
  } else {
    lines.push(`Reused a NAMED layer view/measure in the final answer: NO — the agent wrote its OWN inline query (any wrongness in its filter/field/ranking is a skill issue).`);
  }
  lines.push(`Submitted answer shape: ${shape.kind}${shape.count > 1 ? ` (${shape.count} items)` : ''}.`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Per-miss model verdict: manner + owner + recommended fix.
// ---------------------------------------------------------------------------

export type FailureManner =
  | 'overspecified' // answer too broad/precise vs. the question (extra rows/columns/precision)
  | 'underspecified' // answer too narrow vs. the question (missing rows/dimensions)
  | 'hallucination' // invented entities/fields/values not in the data or layer
  | 'layer_not_used' // the layer had an answer-shaped view but the agent wrote raw/inline instead
  | 'wrong_logic' // correct shape, wrong computation (filter/grain/ranking/missed wildcard)
  | 'gave_up' // never submitted (turn budget / thrash)
  | 'other';

export const FAILURE_MANNERS: FailureManner[] = ['overspecified', 'underspecified', 'hallucination', 'layer_not_used', 'wrong_logic', 'gave_up', 'other'];

export interface MissVerdict {
  owner: MissOwner;
  manner: FailureManner;
  file: string | null;
  defect: string; // one-line STRUCTURAL defect, only when owner==='layer'
  fix: { kind: 'skill' | 'linter' | 'layer' | 'model'; detail: string };
  rationale: string;
}

export interface ModelCallMeta {
  cost: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  raw: string;
}

export const MISS_SYSTEM = `You are triaging a FAILED data question answered against a Malloy semantic layer. You must report (a) the MANNER of failure, (b) WHERE the fix belongs, and (c) the fix.

(a) manner — exactly one of:
- "overspecified": the answer is broader / more precise than asked (extra rows, extra columns, too many decimals, a list where one value was wanted).
- "underspecified": the answer is narrower than asked (missing rows/dimensions, one value where a list was wanted, dropped a category).
- "hallucination": the answer (or the Malloy) references entities, fields, columns, or values that do not exist in the data or the layer.
- "layer_not_used": the layer already exposes an answer-shaped view/measure for this question, but the agent ignored it and hand-wrote raw/inline logic (or never opened the right file).
- "wrong_logic": right shape, wrong computation — a wrong filter, wrong grain, wrong ranking, or a missed wildcard/NULL branch in the agent's OWN inline query.
- "gave_up": the agent never submitted (ran out of turns / thrashed).
- "other".

(b) owner — where the fix belongs:
- "layer": EITHER (i) a STRUCTURAL defect in a layer source/view itself (errors at execution, or a matching/aggregating view is wrongly empty over rows that exist, or wrong grain, or an ENUMERATION/listing surface emits a phantom NULL key — an unmatched outer-join row — that leaks into a list answer and should be excluded) — justified ONLY when a NAMED layer view (or the source the agent enumerated), shown by the evidence, exhibits it; OR (ii) a COVERAGE / PATTERN gap: the question needs a modeling pattern (e.g. COUNTERFACTUAL re-pricing — re-evaluate ALL traffic as if a dimension were changed, vs. ranking the ACTUAL observed values) that the layer ALREADY applies to SIBLING dimensions but is MISSING for this question's dimension, so the agent had to fall back to a non-counterfactual surface and cannot rebuild the wildcard-aware re-matching inline. Adding the missing sibling source IS a layer fix. Case (ii) is justified ONLY when the evidence EXPLICITLY states that sibling counterfactual source(s) exist and names them — otherwise default to "skill".
- "skill": the layer is fine; fix the answering SKILL/prompt (the agent under-filtered, used the wrong field/grain, missed a wildcard, didn't reuse an existing view, or wrote bad inline Malloy).
- "model": a model-capability/reasoning gap on a hard compositional question that no layer or skill edit cleanly fixes.

(c) fix.kind ∈ {skill, linter, layer, model} with a one-line GENERAL detail (a reusable rule — NEVER a DABstep-specific fact or a target value).

CONSTRAINTS: you are given STRUCTURAL evidence and the agent's own trace ONLY. You are NOT given the gold answer and MUST NOT tune anything to a value. Attribute the wrongness by WHO produced it. If the agent wrote its OWN inline query (its own group_by/aggregate/filter/order_by) and that logic is wrong, the owner is "skill". BUT if the agent FAITHFULLY REUSED a NAMED layer view (a thin where/order_by/limit refinement of a pre-built ranking/aggregating view) and the wrong ranking/aggregation/grain is BAKED INTO that named view — e.g. it ranks groups by an AVERAGE where a total or true extremum is wanted, or over the wrong grain/candidate universe — the owner is "layer": the named view itself encodes the wrong computation and the agent cannot fix it from its query. A view that runs and returns rows can STILL be a layer defect when its baked-in aggregation/grain is the wrong measure for the question.

Return ONLY JSON: {"manner":"...","owner":"layer|skill|model","file":"<implicated .malloy file or null>","defect":"<one-line structural defect or empty>","fix":{"kind":"skill|linter|layer|model","detail":"<general rule>"},"rationale":"<one sentence>"}.`;

export async function missVerdict(opts: {
  evidence: string;
  trace: string;
  implicatedFileSrc: string | null;
  implicatedFile: string | null;
  profiles: string;
  manual: string;
  model: string;
  reasoningEffort?: string;
  provider?: string;
}): Promise<MissVerdict & ModelCallMeta> {
  const fileBlock = opts.implicatedFile && opts.implicatedFileSrc
    ? `## The implicated layer file \`${opts.implicatedFile}\`\n\`\`\`malloy\n${opts.implicatedFileSrc}\n\`\`\`\n\n`
    : '';
  const user = `## Failure evidence (structural — NO gold answer)\n${opts.evidence}\n\n## The agent's run trace\n${opts.trace}\n\n${fileBlock}## Column profiles (actual encodings + domains — ground truth)\n${opts.profiles}\n\n## The Merchant Manual\n${opts.manual}\n\nReturn the triage JSON now.`;
  const resp = await complete({
    model: opts.model,
    systemPrompt: MISS_SYSTEM,
    userPrompt: user,
    reasoningEffort: opts.reasoningEffort,
    provider: opts.provider,
    maxTokens: 2500,
  });
  const meta: ModelCallMeta = { cost: resp.cost ?? 0, promptTokens: resp.promptTokens, completionTokens: resp.completionTokens, cachedTokens: resp.cachedTokens, cacheWriteTokens: resp.cacheWriteTokens, raw: resp.text };
  // Safe default: skill / other, no layer edit.
  let v: MissVerdict = { owner: 'skill', manner: 'other', file: opts.implicatedFile, defect: '', fix: { kind: 'skill', detail: '' }, rationale: 'parse failure → defaulted to skill (no layer edit)' };
  try {
    const parsed = extractJsonObject(resp.text) as Partial<MissVerdict> | null;
    if (!parsed) throw new Error('no parseable JSON object in verdict response');
    const owner = parsed.owner;
    const manner = parsed.manner;
    const fix = parsed.fix as MissVerdict['fix'] | undefined;
    v = {
      owner: owner === 'layer' || owner === 'skill' || owner === 'model' || owner === 'answering' ? owner : 'skill',
      manner: FAILURE_MANNERS.includes(manner as FailureManner) ? (manner as FailureManner) : 'other',
      file: typeof parsed.file === 'string' && parsed.file ? parsed.file : opts.implicatedFile,
      defect: String(parsed.defect ?? ''),
      fix: { kind: fix && ['skill', 'linter', 'layer', 'model'].includes(fix.kind) ? fix.kind : 'skill', detail: String(fix?.detail ?? '') },
      rationale: String(parsed.rationale ?? ''),
    };
  } catch {
    /* keep the safe default */
  }
  return { ...v, ...meta };
}

// ---------------------------------------------------------------------------
// Tool-error meta-analysis: a tool that errors too often (>threshold) gets a
// model diagnosis of the SYSTEMIC cause + where the fix belongs.
// ---------------------------------------------------------------------------

export interface ToolDiagnosis {
  cause: string;
  fixKind: 'skill' | 'linter' | 'layer' | 'unknown';
  detail: string; // a GENERAL rule (no DABstep facts)
  file: string | null; // layer file, only when fixKind==='layer'
}

const TOOL_DIAG_SYSTEM = `A tool in an LLM data-analysis loop is FAILING TOO OFTEN across a run. Given the tool's role and a sample of its error outputs, diagnose the SYSTEMIC cause and say where the durable fix belongs:
- "skill": the answering prompt/SKILL should teach the agent to avoid this (e.g. "don't use select: in a grouping query", "filter wildcard rules with (col = x or col is null)").
- "linter": a deterministic pre-submit transform should auto-fix it (e.g. strip stray \`import\` lines, normalize a known function name).
- "layer": a layer view/source is itself broken and the agent keeps tripping on it (rare).
The detail MUST be a GENERAL, reusable rule — never a dataset-specific fact or a target answer value.
Return ONLY JSON: {"cause":"<one line>","fixKind":"skill|linter|layer|unknown","detail":"<general rule>","file":"<layer .malloy file or null>"}.`;

export async function diagnoseToolError(opts: {
  stat: ToolErrorStat;
  manual: string;
  model: string;
  reasoningEffort?: string;
  provider?: string;
}): Promise<ToolDiagnosis & ModelCallMeta> {
  const user = `## Tool failing too often\nTool: ${opts.stat.tool}\nError rate: ${(opts.stat.rate * 100).toFixed(1)}% (${opts.stat.errors}/${opts.stat.calls} calls)\n\n## Sample error outputs\n${opts.stat.samples.map((s, i) => `${i + 1}. ${s}`).join('\n') || '(none captured)'}\n\nDiagnose the systemic cause and the fix location. Return the JSON now.`;
  const resp = await complete({ model: opts.model, systemPrompt: TOOL_DIAG_SYSTEM, userPrompt: user, reasoningEffort: opts.reasoningEffort, provider: opts.provider, maxTokens: 1200 });
  const meta: ModelCallMeta = { cost: resp.cost ?? 0, promptTokens: resp.promptTokens, completionTokens: resp.completionTokens, cachedTokens: resp.cachedTokens, cacheWriteTokens: resp.cacheWriteTokens, raw: resp.text };
  let d: ToolDiagnosis = { cause: '', fixKind: 'unknown', detail: '', file: null };
  try {
    const parsed = extractJsonObject(resp.text) as Partial<ToolDiagnosis> | null;
    if (!parsed) throw new Error('no parseable JSON object in tool-diagnosis response');
    d = {
      cause: String(parsed.cause ?? ''),
      fixKind: ['skill', 'linter', 'layer', 'unknown'].includes(parsed.fixKind as string) ? (parsed.fixKind as ToolDiagnosis['fixKind']) : 'unknown',
      detail: String(parsed.detail ?? ''),
      file: typeof parsed.file === 'string' && parsed.file ? parsed.file : null,
    };
  } catch {
    /* keep unknown */
  }
  return { ...d, ...meta };
}
