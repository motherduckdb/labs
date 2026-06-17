import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MalloyRuntime, orderModelFilesByDependency } from './malloy-runtime.js';
import { buildLocalDuckDB, LOCAL_DB_PATH } from './load.js';

describe('orderModelFilesByDependency', () => {
  it('puts a referenced source before its referrer regardless of filename order', () => {
    // `aaa_fact` references `zzz_dim`; alphabetical would wrongly put aaa first.
    const body = {
      'aaa_fact.malloy': 'source: facts is zzz_dim extend { measure: n is count() }',
      'zzz_dim.malloy': "source: zzz_dim is duckdb.table('dim') extend { dimension: k is id }",
    };
    const order = orderModelFilesByDependency(['aaa_fact.malloy', 'zzz_dim.malloy'], body);
    expect(order.indexOf('zzz_dim.malloy')).toBeLessThan(order.indexOf('aaa_fact.malloy'));
  });

  it('orders a multi-level chain dependency-first and keeps base files leading', () => {
    const body = {
      'central.malloy': 'source: central is mid extend { view: v is { aggregate: c is count() } }',
      'mid.malloy': 'source: mid is thing_base extend { join_one: x is other_base on 1=1 }',
      'thing_base.malloy': "source: thing_base is duckdb.table('t')",
      'other_base.malloy': "source: other_base is duckdb.table('o')",
    };
    const order = orderModelFilesByDependency(Object.keys(body), body);
    expect(order.indexOf('thing_base.malloy')).toBeLessThan(order.indexOf('mid.malloy'));
    expect(order.indexOf('other_base.malloy')).toBeLessThan(order.indexOf('mid.malloy'));
    expect(order.indexOf('mid.malloy')).toBeLessThan(order.indexOf('central.malloy'));
    expect(order[0].endsWith('_base.malloy')).toBe(true);
  });

  it('does not throw on a dependency cycle (falls back, returns all files)', () => {
    const body = {
      'a.malloy': 'source: a is b extend { measure: n is count() }',
      'b.malloy': 'source: b is a extend { measure: m is count() }',
    };
    const order = orderModelFilesByDependency(['a.malloy', 'b.malloy'], body);
    expect([...order].sort()).toEqual(['a.malloy', 'b.malloy']);
  });
});

// Run against a STABLE fixture layer, not the live malloy/ dir (which changes
// every layer-build) — so these tests are deterministic across rebuilds.
const FIXTURE_MODELS = fileURLToPath(new URL('./__fixtures__/malloy/models', import.meta.url));

describe('MalloyRuntime (local DuckDB)', () => {
  let rt: MalloyRuntime;

  beforeAll(async () => {
    if (!existsSync(LOCAL_DB_PATH)) await buildLocalDuckDB();
    rt = new MalloyRuntime({ modelsDir: FIXTURE_MODELS });
  }, 120_000);

  afterAll(async () => {
    await rt?.close();
  });

  it('compiles a query to SQL', async () => {
    const c = await rt.compile('run: payments_base -> { aggregate: transaction_count }');
    expect(c.ok).toBe(true);
    expect(c.sql).toMatch(/select/i);
  });

  it('runs locally and returns the row count', async () => {
    const r = await rt.run('run: payments_base -> { aggregate: transaction_count }');
    expect(r.ok).toBe(true);
    expect(Number((r.rows![0] as { transaction_count: number }).transaction_count)).toBe(138236);
  });

  it('returns diagnostics on a bad query (no throw)', async () => {
    const c = await rt.compile('run: payments_base -> { aggregate: does_not_exist }');
    expect(c.ok).toBe(false);
    expect(c.diagnostics && c.diagnostics.length).toBeGreaterThan(0);
  });

  it('describe() exposes sources + fields', async () => {
    const inv = await rt.describe();
    expect(inv.sources).toContain('payments_base');
    expect(inv.fieldsBySource['payments_base']).toContain('eur_amount');
  });
});
