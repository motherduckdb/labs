import { pruneOldEvents } from './store/events';
import { pruneExpiredKv } from './store/kv';
import { pruneOldConfirmations } from './slack/confirm';
import { closePool } from './store/pg';
import { redactError } from './core/redact';

/**
 * Periodic table maintenance. Invoked by `modal_app.py::housekeeping`, daily.
 *
 * Three tables in migrations/002_modal.sql grow without bound: `slack_events`
 * gains a row per Slack event forever, `kv_cache` keeps expired rows because
 * expiry is evaluated on read rather than by a reaper, and `confirmations`
 * accumulates both spent decisions and rows abandoned by workers that died
 * mid-poll. None of that affects correctness — dedupe, the cache and the
 * handshake are all right whether or not this ever runs — which is exactly why
 * it needs its own scheduled job: nothing in the request path will ever be
 * blamed for the growth, so nothing in the request path will ever fix it.
 *
 * Deliberately NOT called at the end of a turn. That would put a delete on the
 * latency path of every user message to solve a problem with a timescale of
 * weeks, and would have every concurrent worker issuing the same delete.
 *
 * Each prune is independent: one failing must not skip the others, since a
 * single wedged table would otherwise stop all maintenance. The job still exits
 * nonzero if any of them failed, so Modal surfaces it rather than reporting a
 * clean run that silently did nothing.
 */

interface PruneResult {
  name: string;
  removed?: number;
  error?: unknown;
}

async function runPrune(name: string, fn: () => Promise<number>): Promise<PruneResult> {
  try {
    return { name, removed: await fn() };
  } catch (error) {
    return { name, error };
  }
}

async function main(): Promise<void> {
  const results = await Promise.all([
    runPrune('slack_events', () => pruneOldEvents()),
    runPrune('kv_cache', () => pruneExpiredKv()),
    runPrune('confirmations', () => pruneOldConfirmations()),
  ]);

  for (const r of results) {
    if (r.error) console.error(`[quackbot] prune ${r.name} failed:`, redactError(r.error));
    else console.log(`[quackbot] prune ${r.name}: removed ${r.removed}`);
  }

  if (results.some((r) => r.error)) throw new Error('one or more prunes failed');
}

main()
  .then(async () => {
    await closePool().catch(() => {});
    process.exitCode = 0;
  })
  .catch(async (err) => {
    console.error('[quackbot] housekeeping failed:', redactError(err));
    await closePool().catch(() => {});
    process.exitCode = 1;
  });
