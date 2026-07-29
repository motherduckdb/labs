import { beforeEach, describe, expect, it, vi } from 'vitest';

const queryMock = vi.fn();
vi.mock('./pg', () => ({
  getPool: () => ({ query: queryMock }),
}));

import { getConversation, saveConversation } from './conversations';

beforeEach(() => {
  queryMock.mockReset();
});

describe('getConversation', () => {
  it('returns null when no row is found', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const result = await getConversation('C1', 'T1');
    expect(result).toBeNull();
    expect(queryMock).toHaveBeenCalledWith(expect.stringContaining('select messages, databases'), [
      'C1',
      'T1',
    ]);
  });

  it('returns messages and databases when a row is found', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ messages: [{ role: 'user', content: 'hi' }], databases: ['nba_box_scores_v2'] }],
    });
    const result = await getConversation('C1', 'T1');
    expect(result).toEqual({ messages: [{ role: 'user', content: 'hi' }], databases: ['nba_box_scores_v2'] });
  });
});

describe('saveConversation', () => {
  it('upserts with the expected SQL and params', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const messages = [{ role: 'user', content: 'hi' }];
    await saveConversation('C1', 'T1', messages, ['db1']);

    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/insert into conversations/i);
    expect(sql).toMatch(/on conflict \(channel, thread_ts\)/i);
    expect(sql).toMatch(/do update set/i);
    expect(params).toEqual(['C1', 'T1', JSON.stringify(messages), ['db1']]);
  });
});
