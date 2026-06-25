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
  detectCounterfactualSource,
  detectPatternGap,
  isSteeringQuestion,
  steeringVocabulary,
  isListingQuestion,
  evidenceBlock,
  analyzeMiss,
  nonTrainTaskIds,
  viewMissClusters,
  type MissAnalysis,
  type MissClassification,
} from './miss-analysis.js';
import { traceBlock, MISS_SYSTEM } from './miss-verdict.js';
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
  // A file with BOTH a partition-by-actual ranking source AND a counterfactual
  // SIBLING (the aci-steering shape). The pattern-gap detector keys off exactly
  // this asymmetry: a steering question answered by `priced` (ranks actuals)
  // while `priced_aci_steering` proves the layer can express counterfactuals.
  'c5_priced.malloy': `source: priced is duckdb.sql("""SELECT merchant, card_scheme, fee FROM payments JOIN fees USING (card_scheme)""") extend {
  measure: total_fee is fee.sum()
  view: scheme_ranking is { group_by: card_scheme; aggregate: total_fee }
}

source: priced_aci_steering is duckdb.sql("""
  WITH cands AS (SELECT UNNEST(['A','B']) AS candidate_aci)
  SELECT p.merchant, c.candidate_aci, f.fee FROM payments p CROSS JOIN cands c JOIN fees f ON list_contains(f.aci, c.candidate_aci)
""") extend {
  measure: total_fee is fee.sum()
  view: by_aci is { group_by: candidate_aci; aggregate: total_fee }
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

  it('P1b: query ERRORS while a referenced view is degenerate → SKILL (query error wins, not layer)', () => {
    // A degenerate referenced view must NOT steal the blame for the agent's own
    // broken query — the query-error branch runs before the degeneracy branch.
    const c = classifyMiss(
      baseAnalysis({
        reExec: { ok: false, rowCount: 0, error: "Unknown function 'lpad'" },
        viewProbes: [{
          source: 'c4_mcc_avg_fee', view: 'by_mcc_at_50000', file: 'c4_fee_scenarios.malloy',
          ok: true, rowCount: 769,
          smells: [{ code: 'extreme_tie', column: 'avg_fee_at_50000', message: '727/769 rows tie at the MAX' }],
        }],
      }),
    );
    expect(c.category).toBe('query_compile_error');
    expect(c.suggestedOwner).toBe('skill');
    expect(c.layerSuspected).toBe(false);
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

// --- pattern-consistency gate (the counterfactual coverage gap) --------------

describe('counterfactual-source detection (buildLayerIndex)', () => {
  it('flags a CROSS JOIN-over-candidate_<dim> source as counterfactual, with its dim + file', () => {
    expect(INDEX.counterfactualSources.has('priced_aci_steering')).toBe(true);
    expect(INDEX.counterfactualSources.get('priced_aci_steering')!.dims).toEqual(['aci']);
    expect(INDEX.counterfactualSources.get('priced_aci_steering')!.file).toBe('c5_priced.malloy');
  });
  it('does NOT flag an ordinary partition-by-actual source (no candidate cross-join)', () => {
    expect(INDEX.counterfactualSources.has('priced')).toBe(false);
    expect(INDEX.counterfactualSources.has('fee_match')).toBe(false);
  });
  it('detectCounterfactualSource: name fallback fires; a plain source is null', () => {
    expect(detectCounterfactualSource('x_steering', 'SELECT 1')).toEqual(['(unspecified)']);
    expect(detectCounterfactualSource('plain', 'SELECT a FROM t WHERE b = 1')).toBeNull();
  });
});

describe('isSteeringQuestion', () => {
  it('matches steer / move-to-different / to-which-X-should phrasings', () => {
    expect(isSteeringQuestion('to which card scheme should the merchant steer traffic to pay the minimum fees?')).toBe(true);
    expect(isSteeringQuestion('which ACI should we move fraud to a different value?')).toBe(true);
    expect(isSteeringQuestion('what is the total fee for NexPay in 2023?')).toBe(false);
  });
  it('honors extra glossary scenario terms (and ignores too-short noise)', () => {
    expect(isSteeringQuestion('reprice the cohort', ['reprice'])).toBe(true);
    expect(isSteeringQuestion('reprice the cohort')).toBe(false);
  });
});

describe('steeringVocabulary (don\'t let a dimension noun masquerade as steering)', () => {
  it('keeps SCENARIO + OPERATION terms/aliases that name a steering ACTION', () => {
    const v = steeringVocabulary([
      { kind: 'scenario', term: 'Counterfactual ACI steering', aliases: ['move fraudulent transactions to a different ACI', 'incentivize different interaction'] },
      { kind: 'operation', term: 'Cheapest / most expensive option', aliases: ['steer traffic to', 'minimum fees'] }, // operation now included
      { kind: 'dimension', term: 'Authorization Characteristics Indicator (ACI)', aliases: ['authorization characteristic'] }, // must NOT be pulled in
      { kind: 'scenario', term: 'Average fee scenario', aliases: ['typical fee'] }, // scenario but no steering verb → dropped
    ]);
    expect(v).toContain('Counterfactual ACI steering');
    expect(v).toContain('move fraudulent transactions to a different ACI');
    expect(v).toContain('steer traffic to'); // operation-kind alias with a steering verb
    expect(v).not.toContain('minimum fees'); // operation alias but NO steering verb → dropped
    expect(v).not.toContain('authorization characteristic'); // dimension entry excluded
    expect(v).not.toContain('typical fee'); // no steering verb
    expect(v).not.toContain('incentivize different interaction'); // no steering verb
  });

  it('REGRESSION: a dimension alias can no longer make a hypothetical-pricing question look like steering (the 1451 false positive)', () => {
    // The ACI DIMENSION entry's description mentions "counterfactual steering"; its
    // alias "authorization characteristic" is a substring of Q1451 — but it must
    // not seed the steering lexicon, so Q1451 is correctly NOT a steering question.
    const terms = steeringVocabulary([{ kind: 'dimension', term: 'ACI', aliases: ['authorization characteristic'] }]);
    expect(terms).toEqual([]);
    expect(isSteeringQuestion('what would be the most expensive Authorization Characteristics Indicator (ACI)?', terms)).toBe(false);
  });
});

describe('pattern-consistency gate (detectPatternGap)', () => {
  const steeringMiss = (over: Partial<MissAnalysis> = {}): MissAnalysis => ({
    taskId: '2762',
    question: 'to which card scheme should the merchant steer traffic to pay the minimum fees?',
    submitted: true,
    hitLimit: false,
    malloySource: 'run: priced -> scheme_ranking + { order_by: total_fee asc; limit: 1 }',
    reExec: { ok: true, rowCount: 4 },
    viewProbes: [{ source: 'priced', view: 'scheme_ranking', file: 'c5_priced.malloy', ok: true, rowCount: 4 }],
    implicatedFiles: ['c5_priced.malloy'],
    ...over,
  });

  it('clean STEERING miss answered with a non-counterfactual source + a CF sibling exists → LAYER coverage gap', () => {
    const g = detectPatternGap(steeringMiss(), INDEX, { isSteering: true });
    expect(g).not.toBeNull();
    expect(g!.category).toBe('layer_pattern_gap');
    expect(g!.layerSuspected).toBe(true);
    expect(g!.suggestedOwner).toBe('layer');
    expect(g!.implicatedFiles[0]).toBe('c5_priced.malloy');
    expect(g!.note).toMatch(/priced_aci_steering/); // names the sibling — satisfies the verdict's guard
  });

  it('null when the question is NOT a steering question', () => {
    expect(detectPatternGap(steeringMiss(), INDEX, { isSteering: false })).toBeNull();
  });

  it('null when the agent ALREADY used a counterfactual source (no gap)', () => {
    expect(detectPatternGap(steeringMiss({ malloySource: 'run: priced_aci_steering -> by_aci', viewProbes: [] }), INDEX, { isSteering: true })).toBeNull();
  });

  it('null when the layer has NO counterfactual sibling (no template → never speculate)', () => {
    const noCf = buildLayerIndex({ 'a.malloy': `source: priced is duckdb.sql("""SELECT 1""") extend {\n  view: r is { group_by: x }\n}` });
    expect(detectPatternGap(steeringMiss(), noCf, { isSteering: true })).toBeNull();
  });

  it('null on the wrong-but-not-healthy cases (query errored / empty / degenerate view) — a structural probe owns those', () => {
    expect(detectPatternGap(steeringMiss({ reExec: { ok: false, rowCount: 0, error: 'boom' } }), INDEX, { isSteering: true })).toBeNull();
    expect(detectPatternGap(steeringMiss({ reExec: { ok: true, rowCount: 0 } }), INDEX, { isSteering: true })).toBeNull();
    expect(
      detectPatternGap(
        steeringMiss({ viewProbes: [{ source: 'priced', view: 'scheme_ranking', file: 'c5_priced.malloy', ok: true, rowCount: 4, smells: [{ code: 'extreme_tie', column: 'total_fee', message: 'tie' }] }] }),
        INDEX,
        { isSteering: true },
      ),
    ).toBeNull();
  });
});

// --- phantom-NULL-in-a-listing gate (the 1744 class) -------------------------

describe('isListingQuestion', () => {
  it('detects a comma-separated-list answer guideline', () => {
    expect(isListingQuestion('What are the applicable fee IDs for X in 2023?', 'Answer must be a list of values in comma separated list, eg: A, B, C.')).toBe(true);
  });
  it('detects "list"/"what are the" question phrasings', () => {
    expect(isListingQuestion('List the merchants that paid NexPay.')).toBe(true);
    expect(isListingQuestion('What are the fee IDs that apply?')).toBe(true);
  });
  it('is false for a scalar question', () => {
    expect(isListingQuestion('What is the total fee for NexPay in 2023?', 'Answer must be a number rounded to 2 decimals.')).toBe(false);
  });
});

describe('layer_listing_null (phantom NULL key in an enumeration answer)', () => {
  const listingMiss = (over: Partial<MissAnalysis> = {}): MissAnalysis => baseAnalysis({
    question: 'What are the applicable fee IDs for Martinis_Fine_Steakhouse in 2023?',
    guidelines: 'Answer must be a list of values in comma separated list, eg: A, B, C.',
    malloySource: 'run: fee_match -> { group_by: fee_id is fees.ID; aggregate: total_fee_amount }',
    implicatedFiles: ['c3_fee_assignment.malloy'],
    reExec: { ok: true, rowCount: 87 },
    reExecSmells: [{ code: 'phantom_key_null', column: 'fee_id', message: '1 row(s) have a NULL "fee_id" while the other 86 value(s) are (near-)unique — a phantom unmatched-join row in what should be a clean enumeration of "fee_id"' }],
    viewProbes: [],
    ...over,
  });

  it('a LISTING answer whose own output has a phantom NULL key → LAYER (enumeration surface defect)', () => {
    const c = classifyMiss(listingMiss());
    expect(c.category).toBe('layer_listing_null');
    expect(c.layerSuspected).toBe(true);
    expect(c.suggestedOwner).toBe('layer');
    expect(c.note).toMatch(/phantom NULL|is not null/);
  });

  it('the SAME phantom on a NON-listing (scalar) question stays SKILL — no enumeration to clean', () => {
    const c = classifyMiss(listingMiss({ question: 'What is the max fee?', guidelines: 'Answer must be a number.' }));
    expect(c.category).toBe('query_wrong_answer');
    expect(c.layerSuspected).toBe(false);
  });

  it('a listing answer with NO phantom smell is not a layer defect (clean enumeration)', () => {
    const c = classifyMiss(listingMiss({ reExecSmells: [] }));
    expect(c.category).toBe('query_wrong_answer');
    expect(c.layerSuspected).toBe(false);
  });
});

// --- 2B.1 view-miss clustering (the detection unlock) ------------------------

describe('viewMissClusters (closed-book: keys only on view + is_correct)', () => {
  const rows = [
    // a view reused ONLY by a miss (passCount=0) — the §4.1 "ranks cleanly by the
    // wrong measure" blind spot → flagged by default (minMisses=1, missRate=1.0).
    { task_id: '1451', is_correct: false, submitted: true, malloy_source: 'run: rules_lens -> by_card_scheme_avg_fee + { limit: 1 }' },
    // a view reused by BOTH a miss and a pass → missRate=0.5 < 1.0 → NOT flagged.
    { task_id: 'a', is_correct: false, submitted: true, malloy_source: 'run: fee_match -> total_fees_by_merchant_year' },
    { task_id: 'b', is_correct: true, submitted: true, malloy_source: 'run: fee_match -> total_fees_by_merchant_year + { where: x }' },
    // a healthy high-pass view (only passes) → never flagged.
    { task_id: 'c', is_correct: true, submitted: true, malloy_source: 'run: fees_base -> by_card_scheme' },
    // a non-submission (no malloy) must be ignored without throwing.
    { task_id: 'd', is_correct: false, submitted: false, malloy_source: null },
  ];

  it('flags a view reused only by misses; protects any view a pass used', () => {
    const c = viewMissClusters(rows, INDEX);
    expect([...c.keys()]).toEqual(['rules_lens -> by_card_scheme_avg_fee']);
    const stat = c.get('rules_lens -> by_card_scheme_avg_fee')!;
    expect(stat).toMatchObject({ source: 'rules_lens', view: 'by_card_scheme_avg_fee', file: 'dabstep.malloy', missCount: 1, passCount: 0 });
    expect(stat.missRate).toBe(1);
    expect(c.has('fee_match -> total_fees_by_merchant_year')).toBe(false); // 1 miss + 1 pass → 0.5
    expect(c.has('fees_base -> by_card_scheme')).toBe(false); // pass-only
  });

  it('respects a higher minMisses threshold (a lone miss no longer clusters)', () => {
    expect(viewMissClusters(rows, INDEX, { minMisses: 2 }).size).toBe(0);
  });

  it('respects a lower missRate threshold (a mixed view can cluster)', () => {
    const c = viewMissClusters(rows, INDEX, { minMissRate: 0.5 });
    expect(c.has('fee_match -> total_fees_by_merchant_year')).toBe(true); // 0.5 now qualifies
    expect(c.has('fees_base -> by_card_scheme')).toBe(false); // still pass-only (0.0)
  });
});

// --- 2B.2 verdict: faithful-reuse owner relaxation ---------------------------

describe('traceBlock faithful-reuse signal (2B.2)', () => {
  const trace: TaskTrace = { taskId: '1451', steps: [{ name: 'submit_answer', ok: true }], exploredLayer: true, runMalloyErrors: 0, submitErrors: 0, toolCalls: 1 };

  it('names the reused view and frames it as a LAYER-attributable faithful reuse', () => {
    const tb = traceBlock(trace, '[A]', true, ['c3_avg_fee_by_aci -> most_expensive_aci_on_100']);
    expect(tb).toMatch(/FAITHFUL REUSE/);
    expect(tb).toContain('most_expensive_aci_on_100');
    expect(tb).toMatch(/LAYER/);
  });

  it('frames an inline (no named view) answer as the agent\'s OWN query (skill)', () => {
    const tb = traceBlock(trace, '[A]', false);
    expect(tb).toMatch(/its OWN inline query/);
    expect(tb).toMatch(/skill/i);
  });
});

describe('MISS_SYSTEM owner rule (2B.2 relaxed, still closed-book)', () => {
  it('permits owner=layer for a faithfully-reused named view, keeps inline=skill', () => {
    expect(MISS_SYSTEM).toMatch(/FAITHFULLY REUSED a NAMED layer view/);
    expect(MISS_SYSTEM).toMatch(/owner is "layer"/);
    expect(MISS_SYSTEM).toMatch(/own inline query[\s\S]*owner is "skill"/i);
  });
  it('stays closed-book on the gold value', () => {
    expect(MISS_SYSTEM).toMatch(/NOT given the gold answer/);
    expect(MISS_SYSTEM).toMatch(/MUST NOT tune anything to a value/);
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
