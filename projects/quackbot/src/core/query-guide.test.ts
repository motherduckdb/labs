import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { fetchQueryGuideBlock, clearQueryGuideCache } from './query-guide';

/**
 * fetchQueryGuideBlock calls the real `executeToolWithStatus` (get_query_guide
 * is allowlisted), so we stub the MCP client's `callTool`. `executeToolWithStatus`
 * stringifies `structuredContent` when present, so a `{text}` envelope arrives
 * as the JSON string `{"text":"…"}` — the extractor must recover the inner text.
 */
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

describe('fetchQueryGuideBlock', () => {
  beforeEach(() => clearQueryGuideCache());
  afterEach(() => clearQueryGuideCache());

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

  it('caches a successful result within the TTL (second call does not re-invoke)', async () => {
    const { client, callTool } = clientReturning({ text: 'GUIDANCE' }, { structured: true });
    const now = vi.fn(() => 1_000);
    expect(await fetchQueryGuideBlock(client, { now })).toBe('GUIDANCE');
    // 5 minutes later — still within the ~15min TTL.
    now.mockReturnValue(1_000 + 5 * 60 * 1000);
    expect(await fetchQueryGuideBlock(client, { now })).toBe('GUIDANCE');
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it('re-fetches after the TTL expires', async () => {
    const { client, callTool } = clientReturning({ text: 'GUIDANCE' }, { structured: true });
    const now = vi.fn(() => 1_000);
    expect(await fetchQueryGuideBlock(client, { now })).toBe('GUIDANCE');
    // 16 minutes later — past the 15min TTL.
    now.mockReturnValue(1_000 + 16 * 60 * 1000);
    expect(await fetchQueryGuideBlock(client, { now })).toBe('GUIDANCE');
    expect(callTool).toHaveBeenCalledTimes(2);
  });

  it('does not cache failures — the next turn retries', async () => {
    let call = 0;
    const callTool = vi.fn(async () => {
      call += 1;
      if (call === 1) return { structuredContent: { text: 'x' }, isError: true }; // fail first
      return { structuredContent: { text: 'RECOVERED' }, isError: false };
    });
    const client = { callTool } as unknown as Client;
    const now = vi.fn(() => 5_000);
    expect(await fetchQueryGuideBlock(client, { now })).toBeNull();
    // Same instant — a cached failure would short-circuit; instead it retries.
    expect(await fetchQueryGuideBlock(client, { now })).toBe('RECOVERED');
    expect(callTool).toHaveBeenCalledTimes(2);
  });
});
