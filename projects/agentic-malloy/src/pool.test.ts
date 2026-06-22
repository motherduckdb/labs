import { describe, it, expect } from 'vitest';
import { runPool, makeSerializedWriter } from './pool.js';

describe('runPool', () => {
  it('rejects concurrency < 1 or non-integer', async () => {
    await expect(runPool([1], 0, async (x) => x)).rejects.toThrow(/concurrency must be/);
    await expect(runPool([1], 1.5, async (x) => x)).rejects.toThrow(/concurrency must be/);
  });

  it('returns results in INPUT order regardless of completion order', async () => {
    const items = [30, 10, 20];
    const out = await runPool(items, 3, async (ms) => {
      await new Promise((r) => setTimeout(r, ms));
      return ms;
    });
    expect(out).toEqual([30, 10, 20]);
  });

  it('one item failing does not abort siblings (runner contracted not to throw)', async () => {
    // A well-behaved runner returns an outcome even on internal failure.
    const ran: number[] = [];
    const out = await runPool([1, 2, 3], 2, async (n) => {
      ran.push(n);
      return n === 2 ? { id: n, failed: true } : { id: n, failed: false };
    });
    expect(ran.sort()).toEqual([1, 2, 3]); // all three ran
    expect(out.map((o) => o.id)).toEqual([1, 2, 3]); // exactly one result each
    expect(out.filter((o) => o.failed)).toHaveLength(1);
  });

  it('does not run more than `concurrency` items at once', async () => {
    let active = 0;
    let peak = 0;
    await runPool(Array.from({ length: 10 }, (_, i) => i), 3, async (i) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return i;
    });
    expect(peak).toBeLessThanOrEqual(3);
  });
});

describe('makeSerializedWriter', () => {
  it('serializes concurrent writes — every line appears exactly once, no interleave', async () => {
    const lines: string[] = [];
    let inFlight = 0;
    let overlapped = false;
    const write = makeSerializedWriter(async (line: string) => {
      inFlight++;
      if (inFlight > 1) overlapped = true;
      await new Promise((r) => setTimeout(r, Math.random() * 5));
      lines.push(line);
      inFlight--;
    });
    const ids = Array.from({ length: 20 }, (_, i) => `id-${i}`);
    await Promise.all(ids.map((id) => write(id)));
    expect(overlapped).toBe(false); // never two writes at once
    expect(lines.sort()).toEqual([...ids].sort());
    expect(new Set(lines).size).toBe(ids.length); // each exactly once
  });

  it('a single write failure does not poison subsequent writes', async () => {
    const ok: string[] = [];
    let n = 0;
    const write = makeSerializedWriter(async (line: string) => {
      if (n++ === 1) throw new Error('boom');
      ok.push(line);
    });
    const results = await Promise.allSettled([write('a'), write('b'), write('c')]);
    expect(results[1].status).toBe('rejected'); // 'b' failed
    expect(ok).toEqual(['a', 'c']); // 'a' and 'c' still wrote
  });
});
