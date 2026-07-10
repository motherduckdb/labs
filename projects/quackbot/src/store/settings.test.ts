import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const queryMock = vi.fn();
vi.mock('./pg', () => ({
  getPool: () => ({ query: queryMock }),
}));

import { getChannelDatabases, resolveDatabases, setChannelDatabases } from './settings';

const ORIGINAL_ENV = process.env.QUACKBOT_DATABASES;

beforeEach(() => {
  queryMock.mockReset();
});

afterEach(() => {
  process.env.QUACKBOT_DATABASES = ORIGINAL_ENV;
});

describe('getChannelDatabases', () => {
  it('returns null when no override row exists', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    expect(await getChannelDatabases('C1')).toBeNull();
    expect(queryMock).toHaveBeenCalledWith(expect.stringContaining('select databases'), ['C1']);
  });

  it('returns the stored databases when a row exists', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ databases: ['db1', 'db2'] }] });
    expect(await getChannelDatabases('C1')).toEqual(['db1', 'db2']);
  });
});

describe('setChannelDatabases', () => {
  it('upserts with the expected SQL and params', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    await setChannelDatabases('C1', ['db1', 'db2']);

    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/insert into channel_settings/i);
    expect(sql).toMatch(/on conflict \(channel\)/i);
    expect(params).toEqual(['C1', ['db1', 'db2']]);
  });
});

describe('resolveDatabases', () => {
  it('prefers the channel override when present', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ databases: ['override_db'] }] });
    process.env.QUACKBOT_DATABASES = 'env_db1,env_db2';
    expect(await resolveDatabases('C1')).toEqual(['override_db']);
  });

  it('falls back to QUACKBOT_DATABASES, trimmed and empties dropped', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    process.env.QUACKBOT_DATABASES = ' env_db1 , env_db2,, ';
    expect(await resolveDatabases('C1')).toEqual(['env_db1', 'env_db2']);
  });

  it('falls back to an empty array when nothing is configured', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    delete process.env.QUACKBOT_DATABASES;
    expect(await resolveDatabases('C1')).toEqual([]);
  });
});
