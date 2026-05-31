import { describe, it, expect, beforeEach, vi } from 'vitest';

// In-memory fake for idb-keyval so the store works under the node test env.
const mem = new Map<string, unknown>();
vi.mock('idb-keyval', () => ({
  createStore: () => ({}),
  get: vi.fn(async (key: string) => mem.get(key)),
  set: vi.fn(async (key: string, val: unknown) => { mem.set(key, val); }),
}));

import {
  queryFragments,
  applyUpdate,
  serviceContextTool,
  listFragments,
} from './context-store';

beforeEach(() => {
  mem.clear();
});

describe('context-store', () => {
  it('creates, queries, updates, and deletes fragments', async () => {
    const created = await applyUpdate({
      action: 'create',
      title: 'Orders join key',
      content: 'orders join customers on customer_id, not user_id',
      references: ['database:db.main.orders'],
    });
    expect(created.ok).toBe(true);
    const id = created.fragment!.id;

    expect((await listFragments())).toHaveLength(1);

    // keyword query
    const byKeyword = await queryFragments({ query: 'join' });
    expect(byKeyword).toHaveLength(1);
    expect(byKeyword[0].id).toBe(id);

    // reference query
    const byRef = await queryFragments({ reference: 'db.main.orders' });
    expect(byRef).toHaveLength(1);

    // miss
    expect(await queryFragments({ query: 'nonexistent' })).toHaveLength(0);

    // update
    const updated = await applyUpdate({ action: 'update', id, title: 'Renamed' });
    expect(updated.ok).toBe(true);
    expect(updated.fragment!.title).toBe('Renamed');
    expect(updated.fragment!.content).toContain('customer_id'); // content preserved

    // delete
    const deleted = await applyUpdate({ action: 'delete', id });
    expect(deleted.ok).toBe(true);
    expect(await listFragments()).toHaveLength(0);
  });

  it('update/delete fail closed on missing id', async () => {
    expect((await applyUpdate({ action: 'update' })).ok).toBe(false);
    expect((await applyUpdate({ action: 'delete' })).ok).toBe(false);
    expect((await applyUpdate({ action: 'update', id: 'nope', title: 'x' })).ok).toBe(false);
  });

  it('serviceContextTool returns model-facing text mirroring MD tool shapes', async () => {
    // empty read
    const empty = await serviceContextTool('query_context_layer', { query: 'anything' });
    expect(empty.isError).toBe(false);
    expect(empty.resultText).toMatch(/no saved context/i);

    // create via the MD-shaped write tool
    const write = await serviceContextTool('update_context_layer', {
      action: 'create',
      title: 'Revenue definition',
      content: 'revenue = sum(paid_total) - refunds',
    });
    expect(write.isError).toBe(false);

    // read back
    const read = await serviceContextTool('query_context_layer', { query: 'revenue' });
    expect(read.isError).toBe(false);
    expect(read.resultText).toContain('Revenue definition');
    expect(read.resultText).toContain('sum(paid_total)');

    // unknown tool
    const bad = await serviceContextTool('frobnicate', {});
    expect(bad.isError).toBe(true);
  });
});
