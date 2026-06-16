import { describe, it, expect } from 'vitest';
import { lintMalloy } from './linter.js';

const SYMBOLS = new Set(['payments_base', 'fees', 'transaction_count', 'eur_amount', 'aci']);

describe('lintMalloy', () => {
  it('strips a markdown fence and prefixes a bare pipeline with run:', () => {
    const { fixedSrc, fixes } = lintMalloy('```malloy\npayments_base -> { aggregate: transaction_count }\n```', SYMBOLS);
    expect(fixedSrc).toBe('run: payments_base -> { aggregate: transaction_count }');
    expect(fixes).toContain('stripped markdown code fence');
    expect(fixes.some((f) => f.includes("'run:'"))).toBe(true);
  });

  it('fixes identifier casing when exactly one case-insensitive match exists', () => {
    const { fixedSrc, fixes } = lintMalloy('run: Payments_Base -> { aggregate: transaction_count }', SYMBOLS);
    expect(fixedSrc).toContain('payments_base');
    expect(fixes.some((f) => f.includes("cased 'Payments_Base'"))).toBe(true);
  });

  it('escapes list functions with typed raw form', () => {
    const { fixedSrc, fixes } = lintMalloy('run: fees -> { where: len(aci) = 0 or list_contains(aci, "B") }', SYMBOLS);
    expect(fixedSrc).toContain('len!number(');
    expect(fixedSrc).toContain('list_contains!boolean(');
    expect(fixes.length).toBeGreaterThanOrEqual(2);
  });

  it('does not re-escape already-escaped functions', () => {
    const src = 'run: fees -> { where: len!number(aci) = 0 }';
    const { fixedSrc } = lintMalloy(src, SYMBOLS);
    expect(fixedSrc).not.toContain('len!number!number');
  });

  it('does not corrupt SQL inside duckdb.sql blocks (masks strings/comments)', () => {
    const src =
      'source: t is duckdb.sql("""SELECT count(*) AS n, a || b AS c, list_contains(x, y) AS m FROM p WHERE year = 2023""") extend { measure: cnt is count() }\n' +
      'run: t -> { where: year = 2023; aggregate: cnt }';
    const { fixedSrc } = lintMalloy(src, new Set(['t', 'year', 'cnt']));
    // inside the SQL string — untouched
    expect(fixedSrc).toContain('count(*)');
    expect(fixedSrc).toContain('a || b');
    expect(fixedSrc).toContain('list_contains(x, y)');
    expect(fixedSrc).toContain('WHERE year = 2023');
    // outside the string — the Malloy where-clause `year` gets backticked
    expect(fixedSrc).toMatch(/where: `year` = 2023/);
  });

  it('leaves a clean query unchanged', () => {
    const src = 'run: payments_base -> { aggregate: transaction_count }';
    const { fixedSrc, fixes } = lintMalloy(src, SYMBOLS);
    expect(fixedSrc).toBe(src);
    expect(fixes).toHaveLength(0);
  });
});
