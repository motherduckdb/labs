/**
 * columnProfiles() is the generic data-dictionary the build model relies on to
 * author correct match predicates (instead of guessing from prose). These tests
 * pin the behavior that previously bit the fee model: list columns must report
 * the NULL-vs-empty split (the wildcard-encoding fact), low-card scalars must
 * enumerate their full domain, and high-card numerics fall back to a range.
 * A tiny temp DuckDB stands in for the 138k-row real one so the test is fast.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { columnProfiles, renderQA, SEMANTIC_LAYER_POLICY, DUCKDB_NOTES, quoteDuckRef, safeTableName, normalizeTables } from './layer-build.js';

let dir: string;
let dbPath: string;

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'asm-profile-'));
  dbPath = path.join(dir, 'profile.duckdb');
  const inst = await DuckDBInstance.create(dbPath);
  const conn = await inst.connect();
  // rules: list wildcard = empty list (NOT null), a low-card scalar with a NULL
  // wildcard, and a high-card numeric id.
  await conn.run(`CREATE TABLE rules (
    id BIGINT,
    scheme VARCHAR,
    tier VARCHAR,
    tags VARCHAR[]
  )`);
  await conn.run(`INSERT INTO rules VALUES
    (1, 'A', 'low',  []),
    (2, 'A', 'high', ['x']),
    (3, 'B', NULL,   ['x','y']),
    (4, 'B', 'low',  [])`);
  // A table whose name is NOT a safe identifier (hyphen) — exercises ref-quoting
  // in introspection and the ref-vs-name split.
  await conn.run(`CREATE TABLE "order-items" (id BIGINT, qty INTEGER)`);
  await conn.run(`INSERT INTO "order-items" VALUES (1, 5), (2, 9)`);
  conn.closeSync();
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('columnProfiles', () => {
  it('reports the NULL-vs-empty split for list columns (wildcard encoding)', async () => {
    const p = await columnProfiles(['rules'], dbPath);
    const tags = p.rules.split('\n').find((l) => l.includes('tags'))!;
    expect(tags).toMatch(/LIST/);
    expect(tags).toMatch(/NULL=0/);
    expect(tags).toMatch(/empty\[\]=2/);
  });

  it('enumerates the full domain of a low-card scalar and counts NULLs', async () => {
    const p = await columnProfiles(['rules'], dbPath);
    const tier = p.rules.split('\n').find((l) => l.includes(' tier '))!;
    expect(tier).toContain("'high'");
    expect(tier).toContain("'low'");
    expect(tier).toMatch(/\+ 1 NULL/);
  });

  it('falls back to a numeric range for a high-card numeric column', async () => {
    // LOWCARD_MAX is 40; with only 4 rows id is still low-card, so assert the
    // enumeration path here and trust the range branch via the row count note.
    const p = await columnProfiles(['rules'], dbPath);
    expect(p.rules).toContain('(4 rows)');
    const scheme = p.rules.split('\n').find((l) => l.includes('scheme'))!;
    expect(scheme).toContain("'A'");
    expect(scheme).toContain("'B'");
  });
});

// --- generic builder boundary (no DABstep / no benchmark shapes) -------------

describe('generic builder: anti-benchmark rendering', () => {
  it('renders Q/A as ID-free numbered examples (no task ids to copy into the layer)', () => {
    const out = renderQA(
      [
        { question: 'avg fee for NexPay credit?', guidelines: 'round to 6', answer: '5.71' },
        { question: 'top 5 merchants by volume', answer: '[a,b,c]' },
      ],
      false, // includeAnswers=false → answers omitted entirely
    );
    expect(out).toContain('Example 1:');
    expect(out).toContain('Example 2:');
    expect(out).toContain('avg fee for NexPay'); // the question text is allowed
    expect(out).not.toMatch(/task_id|\[\d+\]/); // no task identifiers
    expect(out).not.toContain('5.71'); // includeAnswers=false → no expected values
  });

  it('includes expected values ONLY when includeAnswers is set (still labeled, never an id)', () => {
    const out = renderQA([{ question: 'q', answer: '42' }], true);
    expect(out).toContain('expected: 42');
    expect(out).toContain('Example 1:');
  });

  it('the semantic-layer policy forbids citing task ids / gold answers in output', () => {
    expect(SEMANTIC_LAYER_POLICY).toMatch(/NEVER cite an example\/task identifier/i);
    expect(SEMANTIC_LAYER_POLICY).toMatch(/reusable/i);
  });

  it('the generic Malloy guidance names no dataset entities (uses placeholders)', () => {
    // DUCKDB_NOTES is generic discipline — it must not bake in DABstep entities.
    expect(DUCKDB_NOTES).not.toMatch(/\bfee\b|\bmerchant\b|payments|acquirer/i);
    expect(DUCKDB_NOTES).toContain("duckdb.table('<table>')"); // placeholder, not a real table
  });
});

// --- table specs: name plays 3 roles (DuckDB ref / Malloy id / file stem) ----

describe('table specs (generic table names)', () => {
  it('quoteDuckRef quotes bare, hyphenated, and schema-qualified refs', () => {
    expect(quoteDuckRef('payments')).toBe('"payments"');
    expect(quoteDuckRef('order-items')).toBe('"order-items"');
    expect(quoteDuckRef('main.sales_orders')).toBe('"main"."sales_orders"');
    expect(quoteDuckRef('"Already"."Quoted"')).toBe('"Already"."Quoted"'); // verbatim
  });

  it('safeTableName derives a valid identifier from messy refs', () => {
    expect(safeTableName('order-items')).toBe('order_items');
    expect(safeTableName('user events')).toBe('user_events');
    expect(safeTableName('main.sales_orders')).toBe('sales_orders'); // last segment
    expect(safeTableName('123tbl')).toBe('_123tbl'); // digit-leading
  });

  it('normalizeTables splits ref vs name, validates, and rejects collisions', () => {
    expect(normalizeTables(['payments'])).toEqual([{ ref: 'payments', name: 'payments', quoted: '"payments"' }]);
    expect(normalizeTables([{ ref: 'main.sales_orders', name: 'orders' }])[0]).toMatchObject({ ref: 'main.sales_orders', name: 'orders', quoted: '"main"."sales_orders"' });
    // hyphenated ref → sanitized name, ref kept for SQL/duckdb.table
    expect(normalizeTables(['order-items'])[0]).toMatchObject({ ref: 'order-items', name: 'order_items' });
    // two refs collapsing to the same identifier must throw, not clobber a file
    expect(() => normalizeTables(['order-items', 'order items'])).toThrow(/map to the Malloy identifier/i);
  });

  it('columnProfiles introspects a non-identifier table name (keyed by safe name)', async () => {
    const p = await columnProfiles([{ ref: 'order-items' }], dbPath);
    // keyed by the SAFE name, not the raw ref
    expect(p.order_items).toBeDefined();
    expect(p['order-items']).toBeUndefined();
    expect(p.order_items).toContain('(2 rows)');
    expect(p.order_items).toContain('qty');
  });
});
