import { describe, it, expect, beforeAll } from 'vitest';
import { fileURLToPath } from 'node:url';
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
