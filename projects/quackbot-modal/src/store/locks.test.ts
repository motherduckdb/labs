import { beforeEach, describe, expect, it, vi } from 'vitest';

const queryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn();

vi.mock('./pg', () => ({
  getPool: () => ({ connect: connectMock }),
}));

import { threadLockKey, withThreadLock } from './locks';

beforeEach(() => {
  queryMock.mockReset();
  releaseMock.mockReset();
  connectMock.mockReset();
  connectMock.mockResolvedValue({ query: queryMock, release: releaseMock });
});

/** `pg_try_advisory_lock` reply. */
function lockReply(locked: boolean) {
  return { rows: [{ locked }] };
}

describe('threadLockKey', () => {
  it('joins channel and thread ts', () => {
    expect(threadLockKey('C1', '1700000000.000100')).toBe('C1:1700000000.000100');
  });
});

describe('withThreadLock', () => {
  it('runs the callback and reports acquired when the lock is free', async () => {
    queryMock.mockResolvedValueOnce(lockReply(true)); // try_advisory_lock
    queryMock.mockResolvedValueOnce({ rows: [] }); // advisory_unlock

    const fn = vi.fn().mockResolvedValue('done');
    const outcome = await withThreadLock('C1:T1', fn);

    expect(outcome).toEqual({ acquired: true, result: 'done' });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('takes the lock with pg_try_advisory_lock, not the blocking variant', async () => {
    // Blocking would queue a second turn behind the first; the whole point is
    // to lose fast so the caller can say "still working on your last message".
    queryMock.mockResolvedValueOnce(lockReply(true));
    queryMock.mockResolvedValueOnce({ rows: [] });

    await withThreadLock('C1:T1', async () => undefined);

    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/pg_try_advisory_lock/);
    expect(sql).not.toMatch(/pg_advisory_lock\(/);
    expect(sql).toMatch(/hashtext/);
    expect(params).toEqual(['C1:T1']);
  });

  it('does not run the callback when the lock is held elsewhere', async () => {
    queryMock.mockResolvedValueOnce(lockReply(false));

    const fn = vi.fn();
    const outcome = await withThreadLock('C1:T1', fn);

    expect(outcome).toEqual({ acquired: false });
    expect(fn).not.toHaveBeenCalled();
  });

  it('does not attempt an unlock it never acquired', async () => {
    // Unlocking a lock we do not hold would be a no-op returning false, but it
    // would also be a lie in the logs — and if the key ever collided, a
    // genuinely wrong unlock of someone else's lock.
    queryMock.mockResolvedValueOnce(lockReply(false));

    await withThreadLock('C1:T1', async () => undefined);

    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });

  it('unlocks and rethrows when the callback throws', async () => {
    queryMock.mockResolvedValueOnce(lockReply(true));
    queryMock.mockResolvedValueOnce({ rows: [] });

    await expect(withThreadLock('C1:T1', async () => {
      throw new Error('turn blew up');
    })).rejects.toThrow('turn blew up');

    expect(queryMock).toHaveBeenCalledTimes(2);
    expect(queryMock.mock.calls[1][0]).toMatch(/pg_advisory_unlock/);
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });

  it('holds the lock for the whole of an awaited callback', async () => {
    queryMock.mockResolvedValueOnce(lockReply(true));
    queryMock.mockResolvedValueOnce({ rows: [] });

    let unlockedDuringCallback = false;
    await withThreadLock('C1:T1', async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      unlockedDuringCallback = queryMock.mock.calls.some(([sql]) =>
        /pg_advisory_unlock/.test(sql as string),
      );
    });

    expect(unlockedDuringCallback).toBe(false);
  });

  it('locks, runs and unlocks on ONE checked-out client', async () => {
    // Session advisory locks belong to a connection. If the unlock went out on
    // a different pooled client it would silently target a session that never
    // held the lock, and the real lock would leak until its connection died.
    queryMock.mockResolvedValueOnce(lockReply(true));
    queryMock.mockResolvedValueOnce({ rows: [] });

    await withThreadLock('C1:T1', async () => undefined);

    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(queryMock).toHaveBeenCalledTimes(2);
  });

  it('uses the same key expression for lock and unlock', async () => {
    queryMock.mockResolvedValueOnce(lockReply(true));
    queryMock.mockResolvedValueOnce({ rows: [] });

    await withThreadLock('C1:T1', async () => undefined);

    expect(queryMock.mock.calls[0][1]).toEqual(['C1:T1']);
    expect(queryMock.mock.calls[1][1]).toEqual(['C1:T1']);
  });

  it('always releases the client back to the pool', async () => {
    queryMock.mockResolvedValueOnce(lockReply(true));
    queryMock.mockResolvedValueOnce({ rows: [] });
    await withThreadLock('C1:T1', async () => undefined);
    expect(releaseMock).toHaveBeenCalledWith(undefined);
  });

  it('destroys the connection when the unlock itself fails', async () => {
    // Returning a client that may still hold the lock to the pool would wedge
    // the thread for the life of that connection. Releasing with an error makes
    // pg discard it, which ends the session and drops every lock it held.
    queryMock.mockResolvedValueOnce(lockReply(true));
    queryMock.mockRejectedValueOnce(new Error('connection lost'));

    const outcome = await withThreadLock('C1:T1', async () => 'ok');

    expect(outcome).toEqual({ acquired: true, result: 'ok' });
    expect(releaseMock).toHaveBeenCalledTimes(1);
    expect(releaseMock.mock.calls[0][0]).toBeInstanceOf(Error);
  });

  it('propagates the callback error, not a later unlock error', async () => {
    queryMock.mockResolvedValueOnce(lockReply(true));
    queryMock.mockRejectedValueOnce(new Error('connection lost'));

    await expect(withThreadLock('C1:T1', async () => {
      throw new Error('turn blew up');
    })).rejects.toThrow('turn blew up');
  });

  it('treats a missing/odd lock reply as not acquired', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });

    const fn = vi.fn();
    const outcome = await withThreadLock('C1:T1', fn);

    expect(outcome).toEqual({ acquired: false });
    expect(fn).not.toHaveBeenCalled();
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });
});
