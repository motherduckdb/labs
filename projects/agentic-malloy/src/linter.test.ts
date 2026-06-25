import { describe, it, expect } from 'vitest';
import { lintMalloy, buildKindMap, detectRawSqlInMalloy, type FieldKind } from './linter.js';
import type { ModelInventory } from './malloy-runtime.js';

const SYMBOLS = new Set(['payments_base', 'fees', 'transaction_count', 'eur_amount', 'aci']);

// Field-kind map for the SQL-habit rules (measure → aggregate:, dimension → group_by:).
const KINDS = new Map<string, FieldKind>([
  ['card_scheme', 'dimension'], ['aci', 'dimension'], ['account_type', 'dimension'],
  ['transaction_count', 'measure'], ['total_eur_volume', 'measure'], ['eur_amount', 'dimension'],
]);
const SYM2 = new Set([...KINDS.keys(), 'payments_base', 'fees']);

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

  it('strips import statements (layer is pre-loaded)', () => {
    const src = 'import "dabstep.malloy"\nimport "c3_transaction_fees.malloy"\nrun: txn -> { aggregate: total_fees }';
    const { fixedSrc, fixes } = lintMalloy(src, new Set(['txn', 'total_fees']));
    expect(fixedSrc).not.toMatch(/import/);
    expect(fixedSrc.trim().startsWith('run:')).toBe(true);
    expect(fixes.some((f) => f.includes('import'))).toBe(true);
  });

  it('leaves a clean query unchanged', () => {
    const src = 'run: payments_base -> { aggregate: transaction_count }';
    const { fixedSrc, fixes } = lintMalloy(src, SYMBOLS);
    expect(fixedSrc).toBe(src);
    expect(fixes).toHaveLength(0);
  });
});

describe('lintMalloy — SQL-habit rules', () => {
  // #4 — casts
  it('rewrites *_type() casts to :: form', () => {
    const { fixedSrc, fixes } = lintMalloy(
      'run: payments_base -> { group_by: x is string_type(card_scheme), y is number_type(eur_amount) }', SYM2, KINDS);
    expect(fixedSrc).toContain('card_scheme::string');
    expect(fixedSrc).toContain('eur_amount::number');
    expect(fixes.some((f) => f.includes('::string'))).toBe(true);
  });
  it('declines a cast with a nested-paren argument (no half-rewrite)', () => {
    const { fixedSrc } = lintMalloy('run: payments_base -> { group_by: number_type(foo(eur_amount)) }', SYM2, KINDS);
    expect(fixedSrc).toContain('number_type(foo(eur_amount))');
  });

  // #2 — calculate -> aggregate
  it('flips calculate: of a plain aggregate to aggregate:', () => {
    const { fixedSrc, fixes } = lintMalloy('run: payments_base -> { calculate: t is sum(eur_amount) }', SYM2, KINDS);
    expect(fixedSrc).toMatch(/aggregate:\s*t is sum\(eur_amount\)/);
    expect(fixes.some((f) => f.includes('calculate: -> aggregate:'))).toBe(true);
  });
  it('does NOT flip a real window calculate:', () => {
    const src = 'run: payments_base -> { group_by: card_scheme\n calculate: r is rank() }';
    const { fixedSrc } = lintMalloy(src, SYM2, KINDS);
    expect(fixedSrc).toContain('calculate: r is rank()');
  });

  // #3 — where -> having
  it('splits an and-joined where: into where: + having:', () => {
    const { fixedSrc, fixes } = lintMalloy(
      "run: payments_base -> { group_by: card_scheme\n where: aci = 'A' and sum(eur_amount) > 100\n aggregate: transaction_count }", SYM2, KINDS);
    expect(fixedSrc).toMatch(/where: aci = 'A'/);
    expect(fixedSrc).toMatch(/having: sum\(eur_amount\) > 100/);
    expect(fixes.some((f) => f.includes('split where:'))).toBe(true);
  });
  it('does NOT split a where: when a top-level OR is present (hint only)', () => {
    const src = "run: payments_base -> { where: aci = 'A' or sum(eur_amount) > 100 }";
    const { fixedSrc, fixes } = lintMalloy(src, SYM2, KINDS);
    expect(fixedSrc).toContain("where: aci = 'A' or sum(eur_amount) > 100");
    expect(fixes.some((f) => f.includes('having:'))).toBe(true);
  });
  it('leaves a row-only where: alone', () => {
    const src = "run: payments_base -> { where: aci = 'A' and card_scheme = 'visa'\n aggregate: transaction_count }";
    const { fixedSrc } = lintMalloy(src, SYM2, KINDS);
    expect(fixedSrc).toContain("where: aci = 'A' and card_scheme = 'visa'");
    expect(fixedSrc).not.toContain('having:');
  });

  // #1 — select split
  it('splits select: into group_by: (dim) + aggregate: (measure) via the kind map', () => {
    const { fixedSrc, fixes } = lintMalloy('run: payments_base -> { select: card_scheme, total_eur_volume }', SYM2, KINDS);
    expect(fixedSrc).toMatch(/group_by: card_scheme/);
    expect(fixedSrc).toMatch(/aggregate: total_eur_volume/);
    expect(fixedSrc).not.toContain('select:');
    expect(fixes.some((f) => f.includes('split select:'))).toBe(true);
  });
  it('splits select: with an inline aggregate expression (syntax path, no kinds)', () => {
    const { fixedSrc } = lintMalloy('run: payments_base -> { select: card_scheme, sum(eur_amount) }', SYM2);
    expect(fixedSrc).toMatch(/group_by: card_scheme/);
    expect(fixedSrc).toMatch(/aggregate: sum\(eur_amount\)/);
  });
  it('declines (hint only) when a select item is unclassifiable', () => {
    const { fixedSrc, fixes } = lintMalloy('run: payments_base -> { select: mystery_col, sum(eur_amount) }', SYM2, KINDS);
    expect(fixedSrc).toContain('select:');
    expect(fixes.some((f) => f.includes('group_by:'))).toBe(true);
  });
  it('leaves a plain projection select: alone', () => {
    const src = 'run: payments_base -> { select: card_scheme, aci }';
    const { fixedSrc, fixes } = lintMalloy(src, SYM2, KINDS);
    expect(fixedSrc).toBe(src);
    expect(fixes).toHaveLength(0);
  });

  // masking integrity — none of the four rules touch text inside duckdb.sql("""...""")
  it('never touches rule-triggering text inside duckdb.sql blocks', () => {
    const src =
      'source: t is duckdb.sql("""\n' +
      "  SELECT card_scheme, sum(eur_amount) AS v FROM p\n" +
      "  WHERE aci = 'A' AND sum(amt) > 100\n" +
      '  -- string_type(x) number_type(y)\n' +
      '""") extend { measure: cnt is count() }\n' +
      'run: t -> { select: card_scheme, cnt }';
    const { fixedSrc } = lintMalloy(src, new Set(['t', 'card_scheme', 'cnt']),
      new Map<string, FieldKind>([['card_scheme', 'dimension'], ['cnt', 'measure']]));
    expect(fixedSrc).toContain('SELECT card_scheme, sum(eur_amount) AS v');
    expect(fixedSrc).toContain("WHERE aci = 'A' AND sum(amt) > 100");
    expect(fixedSrc).toContain('string_type(x) number_type(y)');
    // the real select: OUTSIDE the SQL string did get split
    expect(fixedSrc).toMatch(/group_by: card_scheme/);
    expect(fixedSrc).toMatch(/aggregate: cnt/);
  });
});

describe('buildKindMap', () => {
  it('flattens per-source kinds and marks cross-source collisions ambiguous (view)', () => {
    const inv = {
      sources: ['a', 'b'], fieldsBySource: {}, viewsBySource: {},
      fieldKindBySource: {
        a: { x: 'measure', y: 'dimension' },
        b: { x: 'measure', z: 'dimension', y: 'measure' }, // y differs across a/b → ambiguous
      },
    } as unknown as ModelInventory;
    const m = buildKindMap(inv);
    expect(m.get('x')).toBe('measure');
    expect(m.get('z')).toBe('dimension');
    expect(m.get('y')).toBe('view'); // ambiguous → declines downstream
  });
});

describe('detectRawSqlInMalloy', () => {
  it('flags duckdb.sql(...) wraps and ignores plain Malloy', () => {
    expect(detectRawSqlInMalloy('run: duckdb.sql("""select 1""") -> { select: x }')).toBe(true);
    expect(detectRawSqlInMalloy('run: duckdb . sql ( """select 1""" ) -> {}')).toBe(true);
    expect(detectRawSqlInMalloy('run: payments_base -> { aggregate: transaction_count }')).toBe(false);
  });
});
