/**
 * layer-improve unit tests:
 *  - the MISS → FILE mapping, resolved via SOURCE names (P2: views are
 *    source-scoped and reused across sources, so a global view→file map is wrong);
 *  - the LAYER-vs-SKILL triage (classifyMiss, pure over re-execution evidence);
 *  - the TRAIN-ONLY guard (P1: held-out task ids must not drive layer edits);
 *  - no-leakage: the evidence/trace fed to the model never carries the gold answer.
 * No credentials/runtime needed — the structural probe is modeled as plain inputs.
 */
import { describe, it, expect } from 'vitest';
import {
  buildLayerIndex,
  mapMalloyToFiles,
  referencedViews,
  identifiersIn,
  parseHeadSource,
  classifyMiss,
  evidenceBlock,
  analyzeMiss,
  nonTrainTaskIds,
  type MissAnalysis,
  type MissClassification,
} from './miss-analysis.js';
import { traceBlock } from './miss-verdict.js';
import type { TaskTrace } from './run-log.js';
import type { MalloyRuntime } from './malloy-runtime.js';

// A miniature layer mirroring the real f2163373 structure — and crucially the
// DUPLICATE view name `by_account_type` on two different sources/files (as the
// real layer has on payments_enriched + merchants_base), which a global view
// index would mis-resolve.
const BODIES: Record<string, string> = {
  'fees_base.malloy': `source: fees_base is duckdb.table('fees') extend {
  measure: avg_fee is avg(fee)
  view: by_card_scheme is { group_by: card_scheme; aggregate: avg_fee }
}`,
  'merchants_base.malloy': `source: merchants_base is duckdb.table('merchants') extend {
  view: by_account_type is { group_by: account_type; aggregate: n is count() }
}`,
  'c1_payments_enriched.malloy': `source: payments_enriched is payments_base extend {
  view: by_account_type is { group_by: acct; aggregate: total is sum(amount) }
}`,
  'dabstep.malloy': `source: rules_lens is fees_base extend {
  dimension: avg_fee_1000eur is fixed_amount + rate
  view: by_card_scheme_avg_fee is { group_by: card_scheme; aggregate: m is avg(avg_fee_1000eur) }
}`,
  'c3_fee_assignment.malloy': `source: fee_match is fee_match_facts extend {
  measure: total_fee_amount is matched.sum(matched.fee)
  view: total_fees_by_merchant_year is { group_by: merchant, year; aggregate: total_fee_amount }
  view: total_fees_by_merchant_month is { group_by: merchant, month; aggregate: total_fee_amount }
}`,
};

const INDEX = buildLayerIndex(BODIES);

describe('miss → file mapping (source-keyed)', () => {
  it('indexes each source to its file and each source to its own views', () => {
    expect(INDEX.sources.has('rules_lens')).toBe(true);
    expect(INDEX.sources.has('fee_match')).toBe(true);
    expect(INDEX.fileOfSource.get('rules_lens')).toBe('dabstep.malloy');
    expect(INDEX.fileOfSource.get('fee_match')).toBe('c3_fee_assignment.malloy');
    expect(INDEX.viewsBySource.get('fee_match')!.has('total_fees_by_merchant_year')).toBe(true);
    expect(INDEX.viewsBySource.get('fees_base')!.has('by_card_scheme')).toBe(true);
  });

  it('maps a query to the file that defines its source', () => {
    const src = `run: rules_lens -> { where: card_scheme = 'NexPay'; aggregate: m is avg(avg_fee_1000eur) }`;
    expect(mapMalloyToFiles(src, INDEX)).toEqual(['dabstep.malloy']);
  });

  it('maps a bare named-view query via the source (view lives in the source file)', () => {
    const src = `run: fee_match -> total_fees_by_merchant_year`;
    expect(mapMalloyToFiles(src, INDEX)).toEqual(['c3_fee_assignment.malloy']);
    expect(referencedViews(src, INDEX)).toEqual([{ source: 'fee_match', view: 'total_fees_by_merchant_year' }]);
  });

  it('P2: a view name shared by two sources resolves to the HEAD source, not a global first-wins', () => {
    expect(parseHeadSource('run: merchants_base -> by_account_type')).toBe('merchants_base');
    // Same view name, different head source → different source/file each time.
    expect(referencedViews('run: merchants_base -> by_account_type', INDEX)).toEqual([{ source: 'merchants_base', view: 'by_account_type' }]);
    expect(mapMalloyToFiles('run: merchants_base -> by_account_type', INDEX)).toEqual(['merchants_base.malloy']);
    expect(referencedViews('run: payments_enriched -> by_account_type', INDEX)).toEqual([{ source: 'payments_enriched', view: 'by_account_type' }]);
    expect(mapMalloyToFiles('run: payments_enriched -> by_account_type', INDEX)).toEqual(['c1_payments_enriched.malloy']);
  });

  it('does not attribute a view to a source that does not define it', () => {
    // by_account_type is NOT a view of rules_lens, so referencing it under
    // rules_lens yields no probe (avoids probing the wrong source).
    expect(referencedViews('run: rules_lens -> by_account_type', INDEX)).toEqual([]);
  });

  it('ignores non-source/view tokens and handles empty input', () => {
    expect(mapMalloyToFiles('run: rules_lens -> { group_by: card_scheme; aggregate: avg_fee }', INDEX)).toEqual(['dabstep.malloy']);
    expect(mapMalloyToFiles('', INDEX)).toEqual([]);
    expect(identifiersIn('a a b a')).toEqual(['a', 'b']);
  });
});

// --- P1: train-only guard ----------------------------------------------------

describe('train-only guard (nonTrainTaskIds)', () => {
  const train = new Set(['1290', '1451', '1507']);
  it('flags task ids outside the train split (held-out → no layer edits)', () => {
    expect(nonTrainTaskIds(['1290', '1451'], train)).toEqual([]); // all train
    expect(nonTrainTaskIds(['1290', '9999'], train)).toEqual(['9999']); // held-out present
    expect(nonTrainTaskIds([1290, 9999], train)).toEqual(['9999']); // numeric ids coerced
  });
});

// --- triage (classifyMiss) ---------------------------------------------------

function baseAnalysis(over: Partial<MissAnalysis>): MissAnalysis {
  return {
    taskId: 't',
    submitted: true,
    hitLimit: false,
    malloySource: 'run: rules_lens -> { aggregate: m is avg(avg_fee_1000eur) }',
    reExec: { ok: true, rowCount: 1 },
    viewProbes: [],
    implicatedFiles: ['dabstep.malloy'],
    ...over,
  };
}

describe('layer-vs-skill triage (classifyMiss)', () => {
  it('NO SUBMISSION → answering, never the layer', () => {
    const c = classifyMiss(baseAnalysis({ submitted: false, hitLimit: true, malloySource: null, reExec: null }));
    expect(c.category).toBe('no_submission');
    expect(c.suggestedOwner).toBe('answering');
    expect(c.layerSuspected).toBe(false);
  });

  it('1290-style: query re-runs fine and returns rows → SKILL (agent inline logic), NOT layer', () => {
    const c = classifyMiss(baseAnalysis({ reExec: { ok: true, rowCount: 1 }, viewProbes: [] }));
    expect(c.category).toBe('query_wrong_answer');
    expect(c.suggestedOwner).toBe('skill');
    expect(c.layerSuspected).toBe(false);
  });

  it('a referenced layer VIEW that errors on its own → LAYER (structural defect)', () => {
    const c = classifyMiss(
      baseAnalysis({
        reExec: { ok: false, rowCount: 0, error: 'Referenced table not found' },
        viewProbes: [{ source: 'fee_match', view: 'total_fees_by_merchant_year', file: 'c3_fee_assignment.malloy', ok: false, rowCount: 0, error: 'Referenced table not found' }],
      }),
    );
    expect(c.category).toBe('layer_view_error');
    expect(c.suggestedOwner).toBe('layer');
    expect(c.layerSuspected).toBe(true);
    expect(c.implicatedFiles[0]).toBe('c3_fee_assignment.malloy');
  });

  it('1442 case: query runs + returns rows but a referenced view is DEGENERATE → LAYER (wrong grain), not skill', () => {
    // Previously this was query_wrong_answer/skill (reExec ok, rows > 0). The
    // degeneracy smell promotes it to a wrong-grain LAYER defect (I1).
    const c = classifyMiss(
      baseAnalysis({
        reExec: { ok: true, rowCount: 727 },
        viewProbes: [{
          source: 'c4_mcc_avg_fee', view: 'by_mcc_at_50000', file: 'c4_fee_scenarios.malloy',
          ok: true, rowCount: 769,
          smells: [{ code: 'extreme_tie', column: 'avg_fee_at_50000', message: '727/769 rows tie at the MAX of "avg_fee_at_50000" (284.99) — a ranking that does not rank' }],
        }],
      }),
    );
    expect(c.category).toBe('layer_view_degenerate');
    expect(c.suggestedOwner).toBe('layer');
    expect(c.layerSuspected).toBe(true);
    expect(c.implicatedFiles[0]).toBe('c4_fee_scenarios.malloy');
  });

  it('submitted query errors but every referenced view runs clean → SKILL (inline query bug)', () => {
    const c = classifyMiss(
      baseAnalysis({
        reExec: { ok: false, rowCount: 0, error: "Unknown function 'lpad'" },
        viewProbes: [{ source: 'fee_match', view: 'total_fees_by_merchant_year', file: 'c3_fee_assignment.malloy', ok: true, rowCount: 5 }],
      }),
    );
    expect(c.category).toBe('query_compile_error');
    expect(c.suggestedOwner).toBe('skill');
    expect(c.layerSuspected).toBe(false);
  });

  it('query empty AND a referenced view empty on its own → LAYER-suspected (model confirms)', () => {
    const c = classifyMiss(
      baseAnalysis({
        reExec: { ok: true, rowCount: 0 },
        viewProbes: [{ source: 'fee_match', view: 'total_fees_by_merchant_year', file: 'c3_fee_assignment.malloy', ok: true, rowCount: 0 }],
      }),
    );
    expect(c.category).toBe('layer_view_empty');
    expect(c.suggestedOwner).toBe('layer');
    expect(c.layerSuspected).toBe(true);
  });

  it('query empty but the views it used are non-empty → SKILL (agent over-filtered)', () => {
    const c = classifyMiss(
      baseAnalysis({
        reExec: { ok: true, rowCount: 0 },
        viewProbes: [{ source: 'fee_match', view: 'total_fees_by_merchant_year', file: 'c3_fee_assignment.malloy', ok: true, rowCount: 9 }],
      }),
    );
    expect(c.category).toBe('query_wrong_answer');
    expect(c.suggestedOwner).toBe('skill');
    expect(c.layerSuspected).toBe(false);
  });
});

// --- no leakage --------------------------------------------------------------

describe('no leakage', () => {
  it('the evidence block fed to the model never contains the gold answer', async () => {
    const fakeRt = { run: async () => ({ ok: true, rows: [{ x: 1 }] }) } as unknown as MalloyRuntime;
    const a = await analyzeMiss(
      { task_id: '1290', question: 'avg fee for NexPay credit?', is_correct: false, submitted: true, malloy_source: 'run: rules_lens -> { aggregate: m is avg(avg_fee_1000eur) }', predicted_answer: '5.757053', gold_answer: '5.715872' } as never,
      fakeRt,
      INDEX,
    );
    const cls: MissClassification = classifyMiss(a);
    const ev = evidenceBlock(a, cls);
    expect(ev).toContain('1290');
    expect(ev).toContain('avg fee for NexPay'); // the question (intent) is allowed
    expect(ev).toContain('5.757053'); // the agent's OWN predicted output is structural evidence
    expect(ev).not.toContain('5.715872'); // the GOLD answer must never appear
  });

  it('the trace block surfaces the agent actions + answer shape but never the gold', () => {
    const trace: TaskTrace = {
      taskId: '1290',
      steps: [
        { name: 'list_malloy_files', ok: true, args: {} },
        { name: 'run_malloy', ok: false, output: 'compile error' },
        { name: 'submit_answer', ok: true, args: { source: 'run: rules_lens -> {}' } },
      ],
      exploredLayer: true,
      runMalloyErrors: 1,
      submitErrors: 0,
      toolCalls: 3,
    };
    const tb = traceBlock(trace, '5.757053', true);
    expect(tb).toContain('list_malloy_files');
    expect(tb).toContain('Explored the layer');
    expect(tb).toContain('scalar'); // answer-shape signal (shape only, not the value)
    expect(tb).not.toContain('5.715872'); // gold never enters the trace evidence
  });
});
