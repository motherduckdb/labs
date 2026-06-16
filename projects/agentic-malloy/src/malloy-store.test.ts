import { describe, it, expect, beforeAll } from 'vitest';
import { MalloyStore } from './malloy-store.js';

describe('MalloyStore', () => {
  const store = new MalloyStore();
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

  it('reports central layer size and export names', () => {
    expect(store.centralLayerChars()).toBeGreaterThan(0);
    expect(store.allExportNames()).toContain('payments_base');
  });
});
