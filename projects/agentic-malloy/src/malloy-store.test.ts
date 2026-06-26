import { describe, it, expect, beforeAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MalloyStore } from './malloy-store.js';

// Stable fixture layer (not the live malloy/ dir, which changes per build).
const FIXTURE_MODELS = fileURLToPath(new URL('./__fixtures__/malloy/models', import.meta.url));
const FIXTURE_META = fileURLToPath(new URL('./__fixtures__/malloy/_meta', import.meta.url));

describe('MalloyStore', () => {
  const store = new MalloyStore(FIXTURE_MODELS, FIXTURE_META);
  beforeAll(async () => {
    await store.load();
  });

  it('lists domains with no args', () => {
    const out = store.listFiles();
    expect(out).toContain('domains');
    expect(out).toContain('payments');
  });

  it('lists files + exports for a domain', () => {
    const out = store.listFiles(['payments']);
    expect(out).toContain('payments_base.malloy');
    expect(out).toContain('(source)');
  });

  it('flags unknown domains', () => {
    expect(store.listFiles(['nope'])).toContain('unknown domains');
  });

  it('returns full source for a named file', () => {
    const out = store.getFile(['payments_base.malloy']);
    expect(out).toContain('source: payments_base');
  });

  it('tolerates a name without the .malloy suffix', () => {
    expect(store.getFile(['payments_base'])).toContain('source: payments_base');
  });

  it('get_file surfaces the yaml metadata (summary + per-export usage) alongside the source', () => {
    const out = store.getFile(['payments_base.malloy']);
    expect(out).toContain('Fixture payments base for tests.'); // file summary from the sidecar
    expect(out).toContain('Exports:');
    expect(out).toContain('usage: scope with where:'); // per-export how-to-call, so .malloy can stay lean
    expect(out).toContain('```malloy'); // the source is fenced after the metadata
  });

  it('reports central layer size and export names', () => {
    expect(store.centralLayerChars()).toBeGreaterThan(0);
    expect(store.allExportNames()).toContain('payments_base');
  });
});

describe('MalloyStore.listViews aggregation tags (3.1 — stop misrouting)', () => {
  it('tags an avg-ranked extremum view with an AVERAGE caution; a sum-ranked one as TOTAL', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'asm-store-'));
    const models = path.join(dir, 'models');
    const meta = path.join(dir, 'meta');
    mkdirSync(models);
    mkdirSync(meta);
    writeFileSync(
      path.join(models, 'c.malloy'),
      `source: c is base extend {
        dimension: f is fixed_amount
        measure: avg_f is f.avg()
        measure: total_f is f.sum()
        view: most_expensive_x is { group_by: x aggregate: avg_f order_by: avg_f desc limit: 1 }
        view: top_x_by_total is { group_by: x aggregate: total_f order_by: total_f desc limit: 1 }
      }\n`,
    );
    try {
      const store = new MalloyStore(models, meta);
      await store.load();
      const out = store.listViews();
      // Informational aggregation labels (no over-steering "wrong" verdict).
      expect(out).toMatch(/most_expensive_x` ranks by AVERAGE/);
      expect(out).toMatch(/top_x_by_total` ranks by TOTAL\/SUM/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
