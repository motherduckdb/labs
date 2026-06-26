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
