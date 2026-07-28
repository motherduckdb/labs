import { beforeEach, describe, expect, it, vi } from 'vitest';

const queryMock = vi.fn();
vi.mock('./pg', () => ({
  getPool: () => ({ query: queryMock }),
}));

import { kvDelete, kvGet, kvSet, pruneExpiredKv } from './kv';

beforeEach(() => {
  queryMock.mockReset();
});

describe('kvGet', () => {
  it('returns the stored value', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ value: { guide: 'text' } }] });
    await expect(kvGet<{ guide: string }>('query-guide')).resolves.toEqual({ guide: 'text' });
  });

  it('returns null on a miss', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    await expect(kvGet('query-guide')).resolves.toBeNull();
  });

  it('filters expired rows in SQL, using the database clock on both sides', async () => {
    // Container clocks need not agree with each other or with Postgres. If
    // expiry were computed in JS, the same row would be live or dead depending
    // on which machine happened to read it.
    queryMock.mockResolvedValueOnce({ rows: [] });
    await kvGet('k');

    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/select value from kv_cache/i);
    expect(sql).toMatch(/expires_at > now\(\)/i);
    expect(params).toEqual(['k']);
  });

  it('treats an expired row as a miss (it never comes back from the query)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    await expect(kvGet('expired')).resolves.toBeNull();
  });

  it('round-trips a bare string value', async () => {
    // The query guide is stored as a plain string, not an object.
    queryMock.mockResolvedValueOnce({ rows: [{ value: '## Guide\n…' }] });
    await expect(kvGet<string>('query-guide')).resolves.toBe('## Guide\n…');
  });
});

describe('kvSet', () => {
  it('upserts with a database-computed expiry', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    await kvSet('k', { a: 1 }, 15 * 60 * 1000);

    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/insert into kv_cache/i);
    expect(sql).toMatch(/on conflict \(key\)/i);
    expect(sql).toMatch(/do update set/i);
    expect(sql).toMatch(/now\(\) \+ make_interval/i);
    // ttl passed as seconds for make_interval(secs => …)
    expect(params).toEqual(['k', JSON.stringify({ a: 1 }), 900]);
  });

  it('stringifies a bare string rather than handing pg raw text for a jsonb param', async () => {
    // A raw string would be parsed as JSON by Postgres and fail on any guide
    // that is not coincidentally valid JSON.
    queryMock.mockResolvedValueOnce({ rows: [] });
    await kvSet('query-guide', '## Guide', 1000);
    expect(queryMock.mock.calls[0][1]).toEqual(['query-guide', '"## Guide"', 1]);
  });

  it('accepts sub-second TTLs as fractional seconds', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    await kvSet('k', 1, 250);
    expect(queryMock.mock.calls[0][1][2]).toBe(0.25);
  });
});

describe('kvDelete', () => {
  it('removes one key', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    await kvDelete('k');

    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/delete from kv_cache where key = \$1/i);
    expect(params).toEqual(['k']);
  });
});

describe('pruneExpiredKv', () => {
  it('deletes expired rows and reports the count', async () => {
    queryMock.mockResolvedValueOnce({ rowCount: 3, rows: [] });
    await expect(pruneExpiredKv()).resolves.toBe(3);
    expect(queryMock.mock.calls[0][0]).toMatch(/delete from kv_cache where expires_at <= now\(\)/i);
  });

  it('reports zero when pg gives no row count', async () => {
    queryMock.mockResolvedValueOnce({ rowCount: null, rows: [] });
    await expect(pruneExpiredKv()).resolves.toBe(0);
  });
});
