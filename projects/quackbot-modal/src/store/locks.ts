import { getPool } from './pg';

/**
 * Per-thread mutex, backed by Postgres session-level advisory locks.
 *
 * Replaces the `Map<key, Promise<void>>` in handlers.ts, which was only correct
 * because exactly one Node process existed. Modal runs one container per turn,
 * so two messages arriving in the same thread a second apart are two processes
 * that share nothing but the database.
 *
 * Two deliberate differences from the in-memory version:
 *
 * 1. **Non-blocking.** `pg_try_advisory_lock` returns false immediately rather
 *    than waiting. The in-memory mutex queued the second turn behind the first;
 *    here the caller is told it lost the race so it can post "still working on
 *    your last message" instead. Queueing would be actively wrong on Modal — a
 *    worker blocked on a lock still bills, and Slack's user has no idea their
 *    message was even received.
 * 2. **Session-scoped, not transaction-scoped.** A turn spans many statements
 *    and many seconds, so wrapping it in one transaction is not an option.
 *    Session locks survive across statements; the price is that releasing them
 *    is our job (see below).
 */

/** The mutex key for a thread. `handlers.ts` derives `threadTs` per its own conversation-key rules. */
export function threadLockKey(channel: string, threadTs: string): string {
  return `${channel}:${threadTs}`;
}

export interface ThreadLockResult<T> {
  /** False means another worker holds this thread's lock; `result` is absent. */
  acquired: boolean;
  result?: T;
}

/**
 * Run `fn` holding the advisory lock for `key`, or return `{acquired: false}`
 * immediately if another worker already holds it.
 *
 * CRITICAL — the lock lives on a CONNECTION, not on the pool. Session-level
 * advisory locks are owned by the specific backend session that took them, so
 * every statement in the lock/run/unlock sequence has to travel down the same
 * connection. `pool.query()` hands out an arbitrary idle client per call, which
 * means a lock taken via the pool and released via the pool will, sooner or
 * later, unlock on a connection that never held the lock: `pg_advisory_unlock`
 * returns false, logs nothing, and the real lock leaks until its connection
 * dies. That failure is invisible in testing (one warm connection, so it always
 * happens to work) and shows up in production as a thread that has silently
 * wedged. Hence the explicit `pool.connect()` / `client.release()` below — do
 * not "simplify" this to `pool.query()`.
 *
 * The lock is released in a `finally`, so a throw from `fn` unlocks on the way
 * out and the error still propagates to the caller.
 *
 * NOT re-entrant, and for a non-obvious reason: Postgres would happily let one
 * *session* re-acquire an advisory lock it already holds, so re-entrancy looks
 * like it should work. It doesn't, because each call here checks out its own
 * client — a nested `withThreadLock` on the same key is a different session and
 * therefore contends with its own parent, returning `{acquired: false}`. Take
 * the lock once, at the top of the turn.
 */
export async function withThreadLock<T>(key: string, fn: () => Promise<T>): Promise<ThreadLockResult<T>> {
  const pool = getPool();
  const client = await pool.connect();
  let acquired = false;
  // Set if unlocking failed: the connection must then be destroyed rather than
  // returned to the pool, since we can no longer prove the lock is gone.
  let unlockError: Error | undefined;

  try {
    // hashtext() is a Postgres builtin returning int4, widened to the bigint
    // the single-argument lock functions take. It is a hash, so two unrelated
    // threads can collide (~1 in 4 billion) and serialize against each other.
    // The consequence is one user occasionally being told to wait for a turn
    // that isn't theirs — annoying, never incorrect. Doing the hash in SQL
    // rather than TS keeps lock and unlock provably consistent: they are the
    // same expression, not two implementations that must agree.
    const res = await client.query<{ locked: boolean }>(
      'select pg_try_advisory_lock(hashtext($1)::bigint) as locked',
      [key],
    );
    acquired = res.rows[0]?.locked === true;
    if (!acquired) return { acquired: false };

    return { acquired: true, result: await fn() };
  } finally {
    if (acquired) {
      try {
        await client.query('select pg_advisory_unlock(hashtext($1)::bigint)', [key]);
      } catch (err) {
        unlockError = err instanceof Error ? err : new Error(String(err));
      }
    }
    // Releasing WITH an error tells pg to destroy this connection instead of
    // pooling it. That is the recovery path for a failed unlock: ending the
    // session is what drops every advisory lock it held, so a dead connection
    // frees the thread rather than wedging it. Note this swallows the unlock
    // error deliberately — `fn`'s own error, if any, is the one worth
    // propagating, and rethrowing from a finally would replace it.
    client.release(unlockError);
  }
}
