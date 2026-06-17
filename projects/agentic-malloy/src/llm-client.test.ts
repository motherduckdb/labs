import { describe, it, expect, afterEach, vi } from 'vitest';
import { fetchWithRetry } from './llm-client.js';

// Mock fetch — never hits the network. Retries use real timers but tiny delays
// (jitter is capped by attempt; with maxAttempts kept low the test is fast).
const origFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = origFetch;
  vi.restoreAllMocks();
});

function res(status: number, headers: Record<string, string> = {}): Response {
  return new Response(status === 204 ? null : 'body', { status, headers });
}

describe('fetchWithRetry', () => {
  it('retries 429 honoring Retry-After, then succeeds', async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async () => {
      calls.push('call');
      return calls.length === 1 ? res(429, { 'retry-after': '0' }) : res(200);
    }) as unknown as typeof fetch;
    const report = { retryCount: 0 };
    const onRetry = vi.fn();
    const r = await fetchWithRetry('https://x', {}, { maxAttempts: 4, onRetry, report });
    expect(r.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(onRetry).toHaveBeenCalledWith(expect.stringContaining('429'));
    expect(report.retryCount).toBe(1); // one retry performed
  });

  it('retries 5xx then succeeds', async () => {
    let n = 0;
    globalThis.fetch = vi.fn(async () => (++n < 3 ? res(503) : res(200))) as unknown as typeof fetch;
    const r = await fetchWithRetry('https://x', {}, { maxAttempts: 5 });
    expect(r.status).toBe(200);
    expect(n).toBe(3);
  });

  it('retries a network error (TypeError) then succeeds', async () => {
    let n = 0;
    globalThis.fetch = vi.fn(async () => {
      if (++n === 1) throw new TypeError('fetch failed');
      return res(200);
    }) as unknown as typeof fetch;
    const r = await fetchWithRetry('https://x', {}, { maxAttempts: 3 });
    expect(r.status).toBe(200);
    expect(n).toBe(2);
  });

  it('does NOT retry a non-retryable status (400) — returns it immediately', async () => {
    const fetchMock = vi.fn(async () => res(400));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const r = await fetchWithRetry('https://x', {}, { maxAttempts: 5 });
    expect(r.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws after exhausting retries on persistent network errors', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await expect(fetchWithRetry('https://x', {}, { maxAttempts: 3 })).rejects.toThrow(/fetch failed/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('returns the last retryable response when attempts are exhausted', async () => {
    const fetchMock = vi.fn(async () => res(503));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const r = await fetchWithRetry('https://x', {}, { maxAttempts: 3 });
    expect(r.status).toBe(503); // exhausted: surfaced rather than thrown
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
