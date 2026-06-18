/**
 * view-quality smells — the closed-book degeneracy detector (B2/I1). The marquee
 * case is the real 1442 distribution: a per-MCC fee "ranking" where 727/769 rows
 * tie at the max because the grain folds in wildcard rules — it executes but is
 * meaningless. Also: all-zero (a never-firing measure, the original broken
 * fee-match bug), zero-variance (wrong grain), all-null, and the no-false-positive
 * guards (a small honest ranking, a legitimately varied ranking).
 */
import { describe, it, expect } from 'vitest';
import { viewQualitySmells, smellSummary } from './view-quality.js';

const rows = (vals: number[], col = 'fee') => vals.map((v) => ({ [col]: v, label: `g${v}` }));

describe('viewQualitySmells', () => {
  it('flags extreme_tie: the 1442 case (727/769 tie at the max)', () => {
    const data = [
      ...Array.from({ length: 727 }, () => ({ mcc: 1, fee: 284.99 })), // wildcard-dominated max
      ...Array.from({ length: 42 }, (_, i) => ({ mcc: 2, fee: 100 + i })), // the few real ones
    ];
    const s = viewQualitySmells(data);
    const tie = s.find((x) => x.code === 'extreme_tie' && x.column === 'fee')!;
    expect(tie).toBeTruthy();
    expect(tie.message).toMatch(/727\/769 rows tie at the MAX/);
  });

  it('flags all_zero: a measure that never fires (the broken fee-match bug)', () => {
    const s = viewQualitySmells(rows(Array(20).fill(0)));
    expect(s.map((x) => x.code)).toContain('all_zero');
  });

  it('flags zero_variance: identical value across all groups (wrong grain)', () => {
    const s = viewQualitySmells(rows(Array(20).fill(7.5)));
    expect(s.map((x) => x.code)).toContain('zero_variance');
  });

  it('flags all_null: a column that computes nothing', () => {
    const data = Array.from({ length: 12 }, (_, i) => ({ id: i, total: null as number | null }));
    expect(viewQualitySmells(data).map((x) => x.code)).toContain('all_null');
  });

  it('does NOT flag a legitimately varied ranking (no false positive)', () => {
    // 20 distinct descending fees, a clean ranking with a unique max.
    const data = rows(Array.from({ length: 20 }, (_, i) => 100 - i));
    expect(viewQualitySmells(data)).toEqual([]);
  });

  it('does NOT judge tiny groupings (a 5-row scheme ranking is fine)', () => {
    const data = rows([10, 10, 10, 10, 10]); // identical but < minRows
    expect(viewQualitySmells(data)).toEqual([]);
  });

  it('P2: does NOT flag a numeric integer DIMENSION (constant/low-spread) — only float measures', () => {
    // year (int dimension) is constant, month (int dimension) is heavily tied — both
    // are normal for a grouping key and must NOT trigger; the float measure is judged.
    const data = [
      ...Array.from({ length: 11 }, () => ({ year: 2023, month: 1, fee: 5.5 })),
      { year: 2023, month: 2, fee: 99.9 },
    ];
    const s = viewQualitySmells(data);
    expect(s.some((x) => x.column === 'year')).toBe(false); // integer dimension, not judged
    expect(s.some((x) => x.column === 'month')).toBe(false); // integer dimension, not judged
    // a genuinely degenerate FLOAT measure is still caught:
    expect(viewQualitySmells(Array.from({ length: 12 }, () => ({ year: 2023, fee: 5.5 }))).some((x) => x.code === 'zero_variance' && x.column === 'fee')).toBe(true);
  });

  it('handles bigint counts (MotherDuck) without misjudging', () => {
    const data = Array.from({ length: 10 }, (_, i) => ({ g: i, n: BigInt(i + 1) }));
    expect(viewQualitySmells(data)).toEqual([]); // 1..10 distinct → no smell
  });

  it('smellSummary renders the worst smells for a send-back', () => {
    const s = viewQualitySmells(rows(Array(20).fill(0)));
    const txt = smellSummary('c4 -> by_mcc_at_50000', s);
    expect(txt).toMatch(/DEGENERATE/);
    expect(txt).toMatch(/by_mcc_at_50000/);
  });
});
