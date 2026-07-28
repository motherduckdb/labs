import { getPool } from './pg';

/**
 * Slack event dedupe.
 *
 * Replaces the in-process `Set` in handlers.ts. There are two independent
 * duplicate sources and this table covers both: Slack redelivers an event when
 * it doesn't get a 200 in three seconds, and a DM @-mention fires both
 * `message.im` and `app_mention` for a single human utterance. With per-turn
 * containers, neither can be caught in memory any more — the duplicate is
 * usually a *different process*.
 *
 * The event id is whatever the caller decides identifies one logical turn.
 * handlers.ts keys on `(channel, ts)` rather than Slack's `event_id`, which is
 * the important nuance: Slack mints a fresh `event_id` for the `message.im` and
 * `app_mention` copies of one message, so deduping on it would let the double
 * fire through.
 */

/** Rows older than this are past any plausible Slack retry and safe to drop. */
const DEFAULT_PRUNE_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Claim `eventId`. Returns true if this caller is the first to see it and
 * should run the turn; false if someone already has it.
 *
 * The atomicity is the entire point: `insert … on conflict do nothing` makes
 * the check and the claim one statement, so two containers racing on the same
 * event cannot both read "unseen" and both proceed. A select-then-insert would
 * have exactly that hole.
 */
export async function markEventSeen(eventId: string): Promise<boolean> {
  const pool = getPool();
  const result = await pool.query(
    'insert into slack_events (event_id) values ($1) on conflict (event_id) do nothing',
    [eventId],
  );
  // pg types rowCount as nullable (it is null for statements that return no
  // count); an insert always reports one, so treat null as "did not insert"
  // rather than optimistically assuming we won the race.
  return result.rowCount === 1;
}

/**
 * Delete dedupe rows older than `olderThanMs`. Housekeeping only — dedupe stays
 * correct without it, the table just grows. Returns the number of rows removed.
 *
 * Safe to call from any container, and cheap to call from all of them: the
 * delete is idempotent and indexed on `seen_at`.
 */
export async function pruneOldEvents(olderThanMs: number = DEFAULT_PRUNE_AGE_MS): Promise<number> {
  const pool = getPool();
  const result = await pool.query(
    'delete from slack_events where seen_at < now() - make_interval(secs => $1)',
    [olderThanMs / 1000],
  );
  return result.rowCount ?? 0;
}
