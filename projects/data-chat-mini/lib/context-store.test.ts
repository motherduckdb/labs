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

  it('tokenized query prefers fragments matching ALL terms', async () => {
    await applyUpdate({ action: 'create', title: 'Revenue definition', content: 'revenue = sum(order_items.price)' });
    await applyUpdate({ action: 'create', title: 'Customer join', content: 'orders join customers on customer_id' });

    // "revenue order" → fragment 1 hits both ('revenue' + 'order_items'),
    // fragment 2 hits only 'order'. AND-match wins → only fragment 1.
    const res = await queryFragments({ query: 'revenue order' });
    expect(res).toHaveLength(1);
    expect(res[0].title).toBe('Revenue definition');
  });

  it('falls back to ANY-term matches when no fragment matches all terms', async () => {
    await applyUpdate({ action: 'create', title: 'Revenue definition', content: 'revenue = sum(price)' });
    // No fragment contains "lag"; "revenue lag" should still recall the revenue one.
    const res = await queryFragments({ query: 'revenue lag' });
    expect(res).toHaveLength(1);
    expect(res[0].title).toBe('Revenue definition');
  });

  it('ranks title hits above content-only hits', async () => {
    await applyUpdate({ action: 'create', title: 'Customers table', content: 'you can join here' });
    await applyUpdate({ action: 'create', title: 'Join key', content: 'irrelevant body' });
    const res = await queryFragments({ query: 'join' });
    expect(res.map((f) => f.title)).toEqual(['Join key', 'Customers table']);
  });

  it('reference filter still ANDs with the query', async () => {
    await applyUpdate({ action: 'create', title: 'Revenue', content: 'revenue rule', references: ['database:db.main.orders'] });
    await applyUpdate({ action: 'create', title: 'Revenue elsewhere', content: 'revenue rule', references: ['database:db.main.customers'] });
    const res = await queryFragments({ query: 'revenue', reference: 'orders' });
    expect(res).toHaveLength(1);
    expect(res[0].title).toBe('Revenue');
  });

  it('normalizes camelCase, hyphenated words, plurals, and schema refs', async () => {
    await applyUpdate({
      action: 'create',
      title: 'FullGame team points grain',
      content: 'Filter box_scores.period = FullGame and player_name IS NULL before summing team points.',
      references: ['database:nba_box_scores_v2.main.box_scores'],
    });

    const byVocabulary = await queryFragments({ query: 'full-game box scores team totals' });
    expect(byVocabulary).toHaveLength(1);
    expect(byVocabulary[0].title).toBe('FullGame team points grain');

    const byReference = await queryFragments({ reference: 'nba box scores v2 main box scores' });
    expect(byReference).toHaveLength(1);
    expect(byReference[0].title).toBe('FullGame team points grain');
  });

  it('does not over-stem status-like search terms', async () => {
    await applyUpdate({
      action: 'create',
      title: 'Injury status caveat',
      content: 'No player availability status fields are present in this schema.',
    });

    const res = await queryFragments({ query: 'status availability' });
    expect(res).toHaveLength(1);
    expect(res[0].title).toBe('Injury status caveat');
  });
});
