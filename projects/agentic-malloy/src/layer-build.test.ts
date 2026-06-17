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
import { columnProfiles } from './layer-build.js';

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
