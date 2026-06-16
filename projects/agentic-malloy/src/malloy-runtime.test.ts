import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { MalloyRuntime } from './malloy-runtime.js';
import { buildLocalDuckDB, LOCAL_DB_PATH } from './load.js';

describe('MalloyRuntime (local DuckDB)', () => {
  let rt: MalloyRuntime;

  beforeAll(async () => {
    if (!existsSync(LOCAL_DB_PATH)) await buildLocalDuckDB();
    rt = new MalloyRuntime();
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
    const r = await rt.runLocal('run: payments_base -> { aggregate: transaction_count }');
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
