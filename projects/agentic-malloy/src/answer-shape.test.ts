/**
 * answer-shape unit tests — the GENERAL, gold-free pre-submit warnings (easy-
 * convention discipline enforced on BOTH submit paths). Each check is driven by
 * question/guideline WORDING + value SHAPE; with no context the linter is a no-op.
 */
import { describe, it, expect } from 'vitest';
import { answerShapeWarnings, type ShapeWarning } from './answer-shape.js';

const codes = (w: ShapeWarning[]) => w.map((x) => x.code).sort();

describe('answer-shape: no context → never warn', () => {
  it('returns [] when neither question nor guidelines are present', () => {
    // even a clearly-off shape (ratio, 2 cols, null) gets no warning without wording.
    expect(answerShapeWarnings({ source: 'run: x -> { limit: 1 }', columns: ['a', 'b'], rows: [[0.5, null]] })).toEqual([]);
  });
});

describe('answer-shape: extra columns (single-value intent)', () => {
  it('warns on >1 column when the question asks for a single value', () => {
    const w = answerShapeWarnings({ question: 'Which payment method has the highest volume?', guidelines: 'Answer with just the value.', columns: ['method', 'volume'], rows: [['D', 49642]] });
    expect(codes(w)).toContain('extra_columns');
  });
  it('infers column count from the row on the SQL path (no column names)', () => {
    const w = answerShapeWarnings({ question: 'What is the most common card scheme?', rows: [['NexPay', 2955]] });
    expect(codes(w)).toContain('extra_columns');
  });
  it('does NOT warn on a single-column answer', () => {
    expect(answerShapeWarnings({ question: 'Which payment method?', columns: ['method'], rows: [['D']] })).toEqual([]);
  });
  it('does NOT warn when the wording implies per-group output ("for each")', () => {
    const w = answerShapeWarnings({ question: 'What is the total volume for each method?', columns: ['method', 'volume'], rows: [['D', 49642]] });
    expect(codes(w)).not.toContain('extra_columns');
  });
  it('warns on the modal "what <thing> would … pay" single-value form (delta questions)', () => {
    // previously slipped through: "what delta would" is not "what is the …", so the
    // grouping-view row (merchant,count,total_fee,delta) submitted UN-warned (tasks 2490/2463).
    const w = answerShapeWarnings({
      question: 'In the year 2023 what delta would Crossfit_Hanna pay if the relative fee of the fee with ID=792 changed to 99?',
      guidelines: 'Answer must be just a number rounded to 14 decimals.',
      columns: ['merchant', 'transaction_count', 'total_fee', 'delta'],
      rows: [['Crossfit_Hanna', 55139, 43520.83, 2048.69]],
    });
    expect(codes(w)).toContain('extra_columns');
  });
});

describe('answer-shape: [key: value] list carries extra columns', () => {
  it('warns when a [grouping: amount] guideline result has >2 columns (task 347)', () => {
    const w = answerShapeWarnings({
      question: "What is the average transaction value grouped by issuing_country for Golfclub_Baron_Friso's NexPay transactions?",
      guidelines: 'The final answer should be a list of this format: [grouping_i: amount_i, ]. All amounts rounded to 2 decimals.',
      columns: ['issuing_country', 'transaction_count', 'total_amount', 'avg_amount'],
      rows: [['FR', 155, 11032.31, 71.18], ['GR', 60, 4653.63, 77.56]],
    });
    expect(codes(w)).toContain('list_extra_columns');
  });
  it('does NOT warn when the [key: value] result has exactly two columns', () => {
    const w = answerShapeWarnings({
      question: 'average value grouped by issuing_country',
      guidelines: 'list of this format: [grouping_i: amount_i, ]',
      columns: ['issuing_country', 'avg_amount'],
      rows: [['FR', 71.18], ['GR', 77.56]],
    });
    expect(codes(w)).not.toContain('list_extra_columns');
  });
});

describe('answer-shape: percentage on a 0–1 ratio', () => {
  it('warns when a "percentage" answer is a single scalar in (0,1)', () => {
    const w = answerShapeWarnings({ question: 'What percentage of transactions are fraudulent?', guidelines: 'Round to 6 decimals.', rows: [[0.114862]] });
    expect(codes(w)).toContain('percentage_ratio');
  });
  it('does NOT warn when the value is already on a 0–100 scale', () => {
    const w = answerShapeWarnings({ question: 'What percentage …?', rows: [[11.486208]] });
    expect(codes(w)).not.toContain('percentage_ratio');
  });
  it('does NOT warn on a 0 value, or when "percentage" is absent', () => {
    expect(codes(answerShapeWarnings({ question: 'What percentage …?', rows: [[0]] }))).not.toContain('percentage_ratio');
    expect(codes(answerShapeWarnings({ question: 'What is the average fee?', rows: [[0.42]] }))).not.toContain('percentage_ratio');
  });
});

describe('answer-shape: limit 1 / rank()=1 drops ties', () => {
  it('warns when the source limits to 1 but the question asks to list all / ties', () => {
    const w = answerShapeWarnings({ question: 'List all merchants with the maximum fee.', guidelines: 'Comma separated list; if there are ties, list all.', source: 'run: x -> rank_view + { order_by: fee desc; limit: 1 }', rows: [['m1']] });
    expect(codes(w)).toContain('limit_drops_ties');
  });
  it('does NOT warn when there is no limit/rank=1, or no list/ties wording', () => {
    expect(codes(answerShapeWarnings({ question: 'List all …; if there are ties list all.', source: 'run: x -> { order_by: fee desc }', rows: [['m1']] }))).not.toContain('limit_drops_ties');
    expect(codes(answerShapeWarnings({ question: 'Which merchant has the max fee?', source: 'run: x -> { limit: 1 }', rows: [['m1']] }))).not.toContain('limit_drops_ties');
  });
});

describe('answer-shape: NULL in a list answer', () => {
  it('warns on a NULL cell in a multi-row answer', () => {
    const w = answerShapeWarnings({ question: 'What are the applicable fee IDs?', guidelines: 'Comma separated list, eg: A, B, C.', rows: [['12'], ['34'], [null]] });
    expect(codes(w)).toContain('null_in_list');
  });
  it('warns on a NULL in a single-row LIST-worded answer (phantom)', () => {
    const w = answerShapeWarnings({ question: 'List the merchants that paid NexPay.', rows: [[null]] });
    expect(codes(w)).toContain('null_in_list');
  });
  it('does NOT warn on a single scalar NULL with no list wording', () => {
    expect(codes(answerShapeWarnings({ question: 'What is the max fee?', rows: [[null]] }))).not.toContain('null_in_list');
  });
});

describe('answer-shape: boolean expected, number returned', () => {
  it('warns when the guideline asks yes/no but a number is returned', () => {
    const w = answerShapeWarnings({ question: 'Is the fraud rate above the platform average?', guidelines: 'Answer yes or no.', rows: [[0.1483]] });
    expect(codes(w)).toContain('boolean_expected_numeric');
  });
  it('warns on the "yes/no" slash form', () => {
    const w = answerShapeWarnings({ question: 'Are these two fields correlated?', guidelines: 'Answer with yes/no.', rows: [[0.62]] });
    expect(codes(w)).toContain('boolean_expected_numeric');
  });
  it('does NOT warn when the answer is already a yes/no string', () => {
    expect(codes(answerShapeWarnings({ question: 'Is it above average?', guidelines: 'Answer yes or no.', rows: [['yes']] }))).not.toContain('boolean_expected_numeric');
  });
  it('does NOT warn when there is no boolean wording', () => {
    expect(codes(answerShapeWarnings({ question: 'What is the fraud rate?', rows: [[0.1483]] }))).not.toContain('boolean_expected_numeric');
  });
});

describe('answer-shape: letter/code expected, number returned', () => {
  it('warns when the guideline asks for a single letter but a number is returned', () => {
    const w = answerShapeWarnings({ question: 'Which ACI has the lowest fee?', guidelines: 'Answer with just the letter of the ACI.', rows: [[0.42]] });
    expect(codes(w)).toContain('letter_expected_numeric');
  });
  it('does NOT warn when the answer is a letter', () => {
    expect(codes(answerShapeWarnings({ question: 'Which ACI?', guidelines: 'Answer with just a letter.', rows: [['C']] }))).not.toContain('letter_expected_numeric');
  });
  it('does NOT warn without letter wording', () => {
    expect(codes(answerShapeWarnings({ question: 'What is the lowest fee?', rows: [[0.42]] }))).not.toContain('letter_expected_numeric');
  });
});

describe('answer-shape: hard-copied decimal threshold on a ties question', () => {
  it('warns when the source filters on a pasted decimal for a "list all / ties" answer', () => {
    const w = answerShapeWarnings({
      question: 'List all merchants whose total fee equals the maximum.',
      guidelines: 'Comma separated; if there are ties, list all.',
      source: 'run: x -> { group_by: merchant; aggregate: fee } -> { where: fee = 43520.83 }',
      rows: [['m1'], ['m2']],
    });
    expect(codes(w)).toContain('hardcoded_threshold_literal');
  });
  it('does NOT warn on an integer id comparison (no decimal point)', () => {
    const w = answerShapeWarnings({
      question: 'List all merchants at the maximum; list all ties.',
      source: 'run: x -> { where: fee_id = 384 }',
      rows: [['m1']],
    });
    expect(codes(w)).not.toContain('hardcoded_threshold_literal');
  });
  it('does NOT warn without list/ties wording', () => {
    const w = answerShapeWarnings({ question: 'Which merchant?', source: 'run: x -> { where: fee = 43520.83 }', rows: [['m1']] });
    expect(codes(w)).not.toContain('hardcoded_threshold_literal');
  });
});

describe('answer-shape: duplicated values in a list answer', () => {
  it('warns when the key column repeats (un-deduped projection)', () => {
    const w = answerShapeWarnings({ question: 'List all fee IDs that apply.', guidelines: 'Comma separated list.', rows: [['12'], ['34'], ['12']] });
    expect(codes(w)).toContain('undeduped_list');
  });
  it('does NOT warn when every value is distinct', () => {
    expect(codes(answerShapeWarnings({ question: 'List all fee IDs.', rows: [['12'], ['34'], ['56']] }))).not.toContain('undeduped_list');
  });
});
