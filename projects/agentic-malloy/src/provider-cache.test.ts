/**
 * Provider pinning + Anthropic prompt caching. Mocks globalThis.fetch to capture
 * the OpenRouter request body (never hits the network) and asserts: provider
 * routing is pinned when configured; Claude requests carry cache_control breakpoints;
 * non-Claude requests do not; and cached/write token counts from the usage object
 * (non-streamed via complete(), streamed via streamOneTurn) are surfaced.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { streamChatCompletion, complete } from './llm-client.js';
import { streamOneTurn } from './agentic-loop.js';

const origFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = origFetch;
  vi.restoreAllMocks();
});

/** Replace fetch with a capturing mock; returns the array of parsed request bodies. */
function captureFetch(response: () => Response): Array<Record<string, unknown>> {
  const bodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = vi.fn(async (_url: unknown, init: { body: string }) => {
    bodies.push(JSON.parse(init.body));
    return response();
  }) as unknown as typeof fetch;
  return bodies;
}

/** Build an SSE stream Response from JSON chunk strings, terminated by [DONE]. */
function sse(chunks: string[]): Response {
  return new Response(chunks.map((c) => `data: ${c}\n`).join('') + 'data: [DONE]\n', { status: 200 });
}
function jsonRes(usage: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: 'x' } }], usage }), { status: 200 });
}

describe('provider pinning', () => {
  it('pins provider routing on the streaming request body when provider is set', async () => {
    const bodies = captureFetch(() => sse([]));
    await streamChatCompletion({ model: 'anthropic/claude-sonnet-4.6', messages: [{ role: 'user', content: 'hi' }], systemPrompt: 'sys', provider: 'anthropic' });
    expect(bodies[0].provider).toEqual({ order: ['anthropic'], allow_fallbacks: false });
  });

  it('omits provider when none is configured', async () => {
    const bodies = captureFetch(() => sse([]));
    await streamChatCompletion({ model: 'openai/gpt-5.5', messages: [{ role: 'user', content: 'hi' }], systemPrompt: 'sys' });
    expect(bodies[0].provider).toBeUndefined();
  });

  it('pins provider routing on the non-streaming complete() body when set', async () => {
    const bodies = captureFetch(() => jsonRes({ prompt_tokens: 1, completion_tokens: 1 }));
    await complete({ model: 'anthropic/claude-opus-4.7', systemPrompt: 's', userPrompt: 'u', provider: 'anthropic' });
    expect(bodies[0].provider).toEqual({ order: ['anthropic'], allow_fallbacks: false });
  });
});

describe('anthropic cache breakpoints', () => {
  it('marks cache_control on the system + last message for Claude (streaming)', async () => {
    const bodies = captureFetch(() => sse([]));
    await streamChatCompletion({ model: 'anthropic/claude-sonnet-4.6', messages: [{ role: 'user', content: 'hi' }], systemPrompt: 'sys' });
    const msgs = bodies[0].messages as Array<{ role: string; content: Array<{ cache_control?: unknown }> | string }>;
    // system message → string converted to a block array with cache_control on it
    const sys = msgs.find((m) => m.role === 'system')!;
    expect(Array.isArray(sys.content)).toBe(true);
    expect((sys.content as Array<{ cache_control?: unknown }>)[0].cache_control).toEqual({ type: 'ephemeral' });
    // last message → cache_control on its final block
    const last = msgs[msgs.length - 1].content as Array<{ cache_control?: unknown }>;
    expect(Array.isArray(last)).toBe(true);
    expect(last[last.length - 1].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('does NOT add cache_control for non-Claude models (they cache automatically)', async () => {
    const bodies = captureFetch(() => sse([]));
    await streamChatCompletion({ model: 'openai/gpt-5.5', messages: [{ role: 'user', content: 'hi' }], systemPrompt: 'sys' });
    expect(JSON.stringify(bodies[0])).not.toContain('cache_control');
    // system content left as a plain string (not converted to blocks)
    expect(typeof (bodies[0].messages as Array<{ content: unknown }>)[0].content).toBe('string');
  });

  it('marks cache_control for Claude via complete()', async () => {
    const bodies = captureFetch(() => jsonRes({ prompt_tokens: 1, completion_tokens: 1 }));
    await complete({ model: 'anthropic/claude-opus-4.7', systemPrompt: 's', userPrompt: 'u' });
    expect(JSON.stringify(bodies[0])).toContain('cache_control');
  });
});

describe('cache telemetry', () => {
  it('surfaces cached/write tokens from complete() usage', async () => {
    captureFetch(() => jsonRes({ prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 80, cache_write_tokens: 20 } }));
    const r = await complete({ model: 'anthropic/claude-opus-4.7', systemPrompt: 's', userPrompt: 'u' });
    expect(r.cachedTokens).toBe(80);
    expect(r.cacheWriteTokens).toBe(20);
  });

  it('surfaces cached/write tokens from a streamed usage chunk into the parsed turn', async () => {
    captureFetch(() =>
      sse([
        JSON.stringify({ choices: [{ delta: { content: 'hi' } }] }),
        JSON.stringify({ usage: { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 80, cache_write_tokens: 20 } } }),
      ]),
    );
    const parsed = await streamOneTurn({ model: 'anthropic/claude-sonnet-4.6', messages: [{ role: 'user', content: 'hi' }], tools: [], systemPrompt: 'sys' });
    expect(parsed.usage.cachedTokens).toBe(80);
    expect(parsed.usage.cacheWriteTokens).toBe(20);
  });

  it('defaults cache tokens to 0 when usage has no prompt_tokens_details', async () => {
    captureFetch(() => jsonRes({ prompt_tokens: 5, completion_tokens: 5 }));
    const r = await complete({ model: 'openai/gpt-5.5', systemPrompt: 's', userPrompt: 'u' });
    expect(r.cachedTokens).toBe(0);
    expect(r.cacheWriteTokens).toBe(0);
  });
});
