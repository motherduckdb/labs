/**
 * layer-improve unit tests. Two pieces the handoff calls out specifically:
 *  - the MISS → FILE mapping (which layer file a submitted query implicates), and
 *  - the LAYER-vs-SKILL triage (classifyMiss, a pure function over re-execution
 *    evidence — the hard, valuable part).
 * Plus a no-leakage assertion: the evidence fed to the model never carries the
 * gold answer. No credentials / runtime needed — the structural-defect probe is
 * modeled as plain MissAnalysis inputs.
 */
import { describe, it, expect } from 'vitest';
import {
  buildLayerIndex,
  mapMalloyToFiles,
  referencedViews,
  identifiersIn,
  classifyMiss,
  evidenceBlock,
  traceBlock,
  analyzeMiss,
  type MissAnalysis,
  type MissClassification,
} from './layer-improve.js';
import type { TaskTrace } from './run-log.js';
import type { MalloyRuntime } from './malloy-runtime.js';

// A miniature layer mirroring the real f2163373 structure: a lens source in
// dabstep.malloy, a fee-match source + views in c3, base views in fees_base.
const BODIES: Record<string, string> = {
  'fees_base.malloy': `source: fees_base is duckdb.table('fees') extend {
  measure: avg_fee is avg(fee)
  view: by_card_scheme is { group_by: card_scheme; aggregate: avg_fee }
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

describe('miss → file mapping', () => {
  it('indexes every source and view to its defining file', () => {
    expect(INDEX.sources.has('fees_base')).toBe(true);
    expect(INDEX.sources.has('rules_lens')).toBe(true);
    expect(INDEX.sources.has('fee_match')).toBe(true);
    expect(INDEX.views.has('total_fees_by_merchant_year')).toBe(true);
    expect(INDEX.fileOf.get('rules_lens')).toBe('dabstep.malloy');
    expect(INDEX.fileOf.get('total_fees_by_merchant_year')).toBe('c3_fee_assignment.malloy');
    expect(INDEX.fileOf.get('by_card_scheme')).toBe('fees_base.malloy');
  });

  it('maps a query on a lens source to the file that defines the source', () => {
    const src = `run: rules_lens -> { where: card_scheme = 'NexPay'; aggregate: m is avg(avg_fee_1000eur) }`;
    expect(mapMalloyToFiles(src, INDEX)).toEqual(['dabstep.malloy']);
  });

  it('maps a bare named-view query to the file defining the source AND the view', () => {
    const src = `run: fee_match -> total_fees_by_merchant_year`;
    expect(mapMalloyToFiles(src, INDEX)).toEqual(['c3_fee_assignment.malloy']);
    expect(referencedViews(src, INDEX)).toEqual(['total_fees_by_merchant_year']);
  });

  it('ignores tokens that are not known sources/views (keywords, fields, literals)', () => {
    const src = `run: rules_lens -> { group_by: card_scheme; aggregate: avg_fee }`;
    // card_scheme / avg_fee / group_by are fields/keywords, not source/view names.
    expect(mapMalloyToFiles(src, INDEX)).toEqual(['dabstep.malloy']);
    expect(referencedViews(src, INDEX)).toEqual([]);
  });

  it('returns no files for an empty / non-submission', () => {
    expect(mapMalloyToFiles('', INDEX)).toEqual([]);
    expect(identifiersIn('a a b a')).toEqual(['a', 'b']);
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
    // The agent filtered `is_credit = true` and dropped the wildcard rules: the
    // query is valid and returns a row, just the wrong one. The layer is fine.
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
    // the broken view's file is surfaced first.
    expect(c.implicatedFiles[0]).toBe('c3_fee_assignment.malloy');
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
    // A fake runtime so analyzeMiss runs without credentials. The row carries a
    // gold_answer — analyzeMiss must never surface it into the evidence.
    const fakeRt = {
      run: async () => ({ ok: true, rows: [{ x: 1 }] }),
    } as unknown as MalloyRuntime;
    const a = await analyzeMiss(
      { task_id: '1290', question: 'avg fee for NexPay credit?', is_correct: false, submitted: true, malloy_source: 'run: rules_lens -> { aggregate: m is avg(avg_fee_1000eur) }', predicted_answer: '5.757053', gold_answer: '5.715872' } as never,
      fakeRt,
      INDEX,
      new Map(),
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
    expect(tb).toContain('run_malloy');
    expect(tb).toContain('Explored the layer');
    expect(tb).toContain('Reused a NAMED layer view');
    expect(tb).toContain('scalar'); // answer-shape signal (shape only, not the value)
    expect(tb).not.toContain('5.715872'); // gold never enters the trace evidence
  });
});
