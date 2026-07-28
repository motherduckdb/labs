import { beforeEach, describe, expect, it, vi } from 'vitest';

const queryMock = vi.fn();
vi.mock('./pg', () => ({
  getPool: () => ({ query: queryMock }),
}));

import { markEventSeen, pruneOldEvents } from './events';

beforeEach(() => {
  queryMock.mockReset();
});

describe('markEventSeen', () => {
  it('returns true for a first sighting', async () => {
    queryMock.mockResolvedValueOnce({ rowCount: 1, rows: [] });
    await expect(markEventSeen('C1:1700000000.000100')).resolves.toBe(true);
  });

  it('returns false when the event was already claimed', async () => {
    queryMock.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await expect(markEventSeen('C1:1700000000.000100')).resolves.toBe(false);
  });

  it('claims atomically with insert … on conflict do nothing', async () => {
    // A select-then-insert would let two containers both read "unseen" and both
    // run the turn. The claim has to be one statement.
    queryMock.mockResolvedValueOnce({ rowCount: 1, rows: [] });
    await markEventSeen('E1');

    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/insert into slack_events/i);
    expect(sql).toMatch(/on conflict \(event_id\) do nothing/i);
    expect(sql).not.toMatch(/select/i);
    expect(params).toEqual(['E1']);
  });

  it('treats a null rowCount as "did not claim"', async () => {
    // pg types rowCount as nullable. Guessing "we won" on an ambiguous reply
    // would double-run a turn; guessing "we lost" merely drops one.
    queryMock.mockResolvedValueOnce({ rowCount: null, rows: [] });
    await expect(markEventSeen('E1')).resolves.toBe(false);
  });
});

describe('pruneOldEvents', () => {
  it('deletes by age and reports the row count', async () => {
    queryMock.mockResolvedValueOnce({ rowCount: 7, rows: [] });
    await expect(pruneOldEvents(60_000)).resolves.toBe(7);

    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/delete from slack_events/i);
    expect(sql).toMatch(/seen_at < now\(\)/i);
    // Seconds, because make_interval(secs => …) takes seconds.
    expect(params).toEqual([60]);
  });

  it('defaults to a day, comfortably past any Slack retry window', async () => {
    queryMock.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await pruneOldEvents();
    expect(queryMock.mock.calls[0][1]).toEqual([24 * 60 * 60]);
  });

  it('reports zero when pg gives no row count', async () => {
    queryMock.mockResolvedValueOnce({ rowCount: null, rows: [] });
    await expect(pruneOldEvents()).resolves.toBe(0);
  });
});
