/**
 * Bounded concurrency pool. Replaces the ad-hoc inline worker loop in evaluate.
 *
 * Guarantees:
 *   - validates concurrency >= 1
 *   - one item's failure NEVER aborts its siblings (the worker calls a runner
 *     that is expected to NOT throw; if it does throw anyway, the rejection is
 *     captured and surfaced after all items finish rather than racing the pool)
 *   - results are returned in INPUT order regardless of completion order
 */
export async function runPool<T, R>(
  items: T[],
  concurrency: number,
  run: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`concurrency must be an integer >= 1 (got ${concurrency})`);
  }
  const results = new Array<R>(items.length);
  const errors: unknown[] = [];
  let next = 0;

  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = await run(items[i], i);
      } catch (e) {
        // The runner is contracted to return an outcome rather than throw; a
        // throw here is a harness bug, so we record it and keep the pool alive
        // for the remaining items instead of rejecting Promise.all.
        errors.push(e);
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length || 1) }, () => worker()));
  if (errors.length) {
    // Preserve the first error's stack; note any extras.
    const first = errors[0];
    if (errors.length > 1 && first instanceof Error) first.message += ` (+${errors.length - 1} more pool errors)`;
    throw first;
  }
  return results;
}

/**
 * A tiny serializing writer: chains async writes so concurrent callers never
 * interleave appends to the same file. Returns a function that enqueues a write
 * and resolves when it (and everything ahead of it) has been flushed.
 */
export function makeSerializedWriter(write: (line: string) => Promise<void>): (line: string) => Promise<void> {
  let tail: Promise<void> = Promise.resolve();
  return (line: string) => {
    const run = tail.then(() => write(line));
    // Keep the chain alive even if one write rejects, so a single failure does
    // not poison every subsequent write.
    tail = run.catch(() => {});
    return run;
  };
}
