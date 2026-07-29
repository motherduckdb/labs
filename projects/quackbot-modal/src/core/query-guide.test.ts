import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

/**
 * fetchQueryGuideBlock calls the real `executeToolWithStatus` (get_query_guide
 * is allowlisted), so we stub the MCP client's `callTool`. `executeToolWithStatus`
 * stringifies `structuredContent` when present, so a `{text}` envelope arrives
 * as the JSON string `{"text":"…"}` — the extractor must recover the inner text.
 *
 * The TTL cache now lives in Postgres (src/store/kv.ts) rather than a module
 * variable, so what used to be a fake JS clock is now a fake `kv_cache`: a tiny
 * in-memory map behind mocked kvGet/kvSet/kvDelete. Real TTL/expiry semantics
 * (the `expires_at > now()` predicate) are kv.ts's own tests to own — this file
 * only has to prove fetchQueryGuideBlock reads/writes/invalidates through that
 * seam correctly, without requiring a live database.
 */
vi.mock('../store/kv', () => ({
  kvGet: vi.fn(),
  kvSet: vi.fn(),
  kvDelete: vi.fn(),
}));

import { kvDelete, kvGet, kvSet } from '../store/kv';
import { fetchQueryGuideBlock, clearQueryGuideCache } from './query-guide';

const kvGetMock = vi.mocked(kvGet);
const kvSetMock = vi.mocked(kvSet);
const kvDeleteMock = vi.mocked(kvDelete);

const kvStore = new Map<string, unknown>();

function clientReturning(content: unknown, opts: { structured?: boolean; isError?: boolean } = {}): {
  client: Client;
  callTool: ReturnType<typeof vi.fn>;
} {
  const callTool = vi.fn(async () => {
    if (opts.structured) {
      return { structuredContent: content, isError: opts.isError === true };
    }
    return {
      content: [{ type: 'text', text: typeof content === 'string' ? content : JSON.stringify(content) }],
      isError: opts.isError === true,
    };
  });
  return { client: { callTool } as unknown as Client, callTool };
}

function throwingClient(): Client {
  return { callTool: vi.fn(async () => { throw new Error('transport down'); }) } as unknown as Client;
}

beforeEach(() => {
  kvStore.clear();
  kvGetMock.mockReset().mockImplementation(async (key: string) => (kvStore.has(key) ? kvStore.get(key) : null));
  kvSetMock.mockReset().mockImplementation(async (key: string, value: unknown) => {
    kvStore.set(key, value);
  });
  kvDeleteMock.mockReset().mockImplementation(async (key: string) => {
    kvStore.delete(key);
  });
});
afterEach(async () => clearQueryGuideCache());

describe('fetchQueryGuideBlock', () => {
  it('returns the guide text from a structured {text} envelope', async () => {
    const { client, callTool } = clientReturning({ text: 'ORG GUIDANCE\n- topic map' }, { structured: true });
    const block = await fetchQueryGuideBlock(client);
    expect(block).toBe('ORG GUIDANCE\n- topic map');
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(callTool.mock.calls[0][0]).toMatchObject({ name: 'get_query_guide', arguments: {} });
  });

  it('returns the raw text when the server sends plain text blocks', async () => {
    const { client } = clientReturning('plain guidance text', { structured: false });
    const block = await fetchQueryGuideBlock(client);
    expect(block).toBe('plain guidance text');
  });

  it('returns null on a tool-level error (isError)', async () => {
    const { client } = clientReturning({ text: 'nope' }, { structured: true, isError: true });
    expect(await fetchQueryGuideBlock(client)).toBeNull();
  });

  it('returns null when callTool throws (never propagates)', async () => {
    await expect(fetchQueryGuideBlock(throwingClient())).resolves.toBeNull();
  });

  it('returns null on an empty body', async () => {
    const { client } = clientReturning({ text: '   ' }, { structured: true });
    expect(await fetchQueryGuideBlock(client)).toBeNull();
  });

  it('returns null when the envelope has no usable text field', async () => {
    const { client } = clientReturning({ success: true }, { structured: true });
    expect(await fetchQueryGuideBlock(client)).toBeNull();
  });

  it('caches a successful result (second call is served from kv, not callTool)', async () => {
    const { client, callTool } = clientReturning({ text: 'GUIDANCE' }, { structured: true });
    expect(await fetchQueryGuideBlock(client)).toBe('GUIDANCE');
    expect(await fetchQueryGuideBlock(client)).toBe('GUIDANCE');
    expect(callTool).toHaveBeenCalledTimes(1);
    // Written through kvSet with the 15-minute TTL, in milliseconds — kv.ts
    // converts that to seconds for Postgres's make_interval, but that's kv.ts's
    // contract to keep, not this module's.
    expect(kvSetMock).toHaveBeenCalledWith('query-guide', 'GUIDANCE', 15 * 60 * 1000);
  });

  it('re-fetches once the cached entry is gone (kv.ts owns real expiry via the DB clock)', async () => {
    const { client, callTool } = clientReturning({ text: 'GUIDANCE' }, { structured: true });
    expect(await fetchQueryGuideBlock(client)).toBe('GUIDANCE');
    // Stand-in for the row aging out of kv_cache — kvGet would return null
    // past expires_at regardless of which container reads it.
    kvStore.clear();
    expect(await fetchQueryGuideBlock(client)).toBe('GUIDANCE');
    expect(callTool).toHaveBeenCalledTimes(2);
  });

  it('does not cache failures — the next call retries', async () => {
    let call = 0;
    const callTool = vi.fn(async () => {
      call += 1;
      if (call === 1) return { structuredContent: { text: 'x' }, isError: true }; // fail first
      return { structuredContent: { text: 'RECOVERED' }, isError: false };
    });
    const client = { callTool } as unknown as Client;
    expect(await fetchQueryGuideBlock(client)).toBeNull();
    expect(kvSetMock).not.toHaveBeenCalled();
    expect(await fetchQueryGuideBlock(client)).toBe('RECOVERED');
    expect(callTool).toHaveBeenCalledTimes(2);
  });

  it('clearQueryGuideCache deletes the shared kv key', async () => {
    const { client, callTool } = clientReturning({ text: 'GUIDANCE' }, { structured: true });
    await fetchQueryGuideBlock(client);
    await clearQueryGuideCache();
    expect(kvDeleteMock).toHaveBeenCalledWith('query-guide');
    await fetchQueryGuideBlock(client);
    expect(callTool).toHaveBeenCalledTimes(2);
  });
});
