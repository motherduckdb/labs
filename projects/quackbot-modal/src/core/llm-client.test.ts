import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildAuthHeaders,
  computeCostUSD,
  getChatCompletionsUrl,
  getContextWindow,
  getModelProfile,
  KIMI_K3_RATES_PER_MTOK,
  modelSupportsVision,
  streamChatCompletion,
  toOpenAIMessages,
  toReasoningEffort,
} from './llm-client';

// ---------------------------------------------------------------------------
// Env sandbox — every test in this file pokes at process.env, so snapshot and
// restore the whole thing rather than tracking individual keys.
// ---------------------------------------------------------------------------

const ENV_KEYS = [
  'MODAL_INFERENCE_BASE_URL',
  'MODAL_INFERENCE_KEY',
  'MODAL_INFERENCE_MODEL',
  'MODAL_KEY',
  'MODAL_SECRET',
] as const;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  // There is no default base URL — getChatCompletionsUrl throws without one
  // (deliberately; see llm-client.ts). Every test that isn't specifically about
  // URL resolution needs *some* value here, so supply an obviously-fake one.
  // Tests that care override it; the "throws when unset" test deletes it.
  process.env.MODAL_INFERENCE_BASE_URL = 'https://test.invalid/v1';
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// fetch capture — streamChatCompletion only needs a body-bearing ok Response.
// ---------------------------------------------------------------------------

interface CapturedRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function captureFetch(response?: { ok?: boolean; status?: number; text?: string }): () => CapturedRequest {
  let captured: CapturedRequest | undefined;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    captured = {
      url,
      headers: (init.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init.body)),
    };
    if (response && response.ok === false) {
      return {
        ok: false,
        status: response.status ?? 500,
        text: async () => response.text ?? 'boom',
      } as unknown as Response;
    }
    return {
      ok: true,
      status: 200,
      body: new ReadableStream<Uint8Array>({ start(c) { c.close(); } }),
    } as unknown as Response;
  }));
  return () => {
    if (!captured) throw new Error('fetch was never called');
    return captured;
  };
}

async function callStream(params?: Partial<Parameters<typeof streamChatCompletion>[0]>) {
  return streamChatCompletion({
    model: 'moonshotai/Kimi-K3',
    messages: [{ role: 'user', content: 'hi' }],
    systemPrompt: 'sys',
    ...params,
  });
}

// ---------------------------------------------------------------------------

describe('request body construction', () => {
  it('sends the K3-shaped body: max_completion_tokens, stream_options, reasoning_effort — and NO sampling params', async () => {
    process.env.MODAL_INFERENCE_KEY = 'k';
    const read = captureFetch();
    await callStream({ maxTokens: 16384 });
    const { body } = read();

    expect(body.model).toBe('moonshotai/Kimi-K3');
    expect(body.max_completion_tokens).toBe(16384);
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.reasoning_effort).toBe('low');

    // Sampling params are locked by K3 — sending them is an error or a no-op.
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('top_p');
    expect(body).not.toHaveProperty('n');
    expect(body).not.toHaveProperty('presence_penalty');
    expect(body).not.toHaveProperty('frequency_penalty');

    // OpenRouter-only leftovers must be gone.
    expect(body).not.toHaveProperty('max_tokens');
    expect(body).not.toHaveProperty('usage');
    expect(body).not.toHaveProperty('provider');
    expect(body).not.toHaveProperty('reasoning');
  });

  it('defaults max_completion_tokens to 16384 and omits tools when none are supplied', async () => {
    process.env.MODAL_INFERENCE_KEY = 'k';
    const read = captureFetch();
    await callStream();
    const { body } = read();
    expect(body.max_completion_tokens).toBe(16384);
    expect(body).not.toHaveProperty('tools');
  });

  it('converts Anthropic tool definitions to OpenAI function tools', async () => {
    process.env.MODAL_INFERENCE_KEY = 'k';
    const read = captureFetch();
    await callStream({
      tools: [{ name: 'query', description: 'run sql', input_schema: { type: 'object', properties: {} } }],
    });
    expect(read().body.tools).toEqual([
      {
        type: 'function',
        function: { name: 'query', description: 'run sql', parameters: { type: 'object', properties: {} } },
      },
    ]);
  });

  it('drops the OpenRouter attribution headers', async () => {
    process.env.MODAL_INFERENCE_KEY = 'k';
    const read = captureFetch();
    await callStream();
    const { headers } = read();
    expect(headers).not.toHaveProperty('X-Title');
    expect(headers).not.toHaveProperty('HTTP-Referer');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('throws a redacted, Modal-labelled error on a non-2xx response', async () => {
    process.env.MODAL_INFERENCE_KEY = 'k';
    captureFetch({ ok: false, status: 429, text: 'rate limited' });
    await expect(callStream()).rejects.toThrow(/Modal inference error 429/);
  });
});

describe('reasoning_effort mapping', () => {
  it('collapses the six-rung thinking ladder onto low|high|max', () => {
    expect(toReasoningEffort('none')).toBe('low');
    expect(toReasoningEffort('minimal')).toBe('low');
    expect(toReasoningEffort('low')).toBe('low');
    expect(toReasoningEffort('medium')).toBe('high');
    expect(toReasoningEffort('high')).toBe('high');
    expect(toReasoningEffort('xhigh')).toBe('max');
  });

  it('defaults to low for undefined, empty, and unknown levels (reasoning bills at $15/MTok)', () => {
    expect(toReasoningEffort(undefined)).toBe('low');
    expect(toReasoningEffort('')).toBe('low');
    expect(toReasoningEffort('turbo')).toBe('low');
  });

  it('puts the mapped value on the request as a TOP-LEVEL reasoning_effort', async () => {
    process.env.MODAL_INFERENCE_KEY = 'k';
    const read = captureFetch();
    await callStream({ thinkingLevel: 'xhigh' });
    const { body } = read();
    expect(body.reasoning_effort).toBe('max');
    expect(body).not.toHaveProperty('reasoning');
  });

  it('still sends reasoning_effort: low when the caller asks for "none" — K3 cannot turn thinking off', async () => {
    process.env.MODAL_INFERENCE_KEY = 'k';
    const read = captureFetch();
    await callStream({ thinkingLevel: 'none' });
    expect(read().body.reasoning_effort).toBe('low');
  });
});

describe('endpoint + auth', () => {
  it('reads the base URL from MODAL_INFERENCE_BASE_URL and tolerates a trailing slash', () => {
    process.env.MODAL_INFERENCE_BASE_URL = 'https://example.modal.run/v1/';
    expect(getChatCompletionsUrl()).toBe('https://example.modal.run/v1/chat/completions');
    process.env.MODAL_INFERENCE_BASE_URL = 'https://example.modal.run/v1';
    expect(getChatCompletionsUrl()).toBe('https://example.modal.run/v1/chat/completions');
  });

  it('defaults to the Shared API host when the env var is unset', () => {
    // The Shared API is one fixed host for every workspace, so an unset var is
    // the ordinary case, not a misconfiguration. Pinned rather than loosely
    // matched: a silent change to this host is a change of inference provider.
    delete process.env.MODAL_INFERENCE_BASE_URL;
    expect(getChatCompletionsUrl()).toBe('https://api.us-west-2.modal.direct/v1/chat/completions');
  });

  it('ignores a blank override rather than building a relative URL from it', () => {
    // An unset key in a Modal secret arrives as an empty string, not as absent.
    process.env.MODAL_INFERENCE_BASE_URL = '   ';
    expect(getChatCompletionsUrl()).toBe('https://api.us-west-2.modal.direct/v1/chat/completions');
  });

  it('POSTs to the resolved chat-completions URL', async () => {
    process.env.MODAL_INFERENCE_BASE_URL = 'https://example.modal.run/v1';
    process.env.MODAL_INFERENCE_KEY = 'k';
    const read = captureFetch();
    await callStream();
    expect(read().url).toBe('https://example.modal.run/v1/chat/completions');
  });

  it('sends MODAL_INFERENCE_KEY as an OpenAI-style bearer', () => {
    expect(buildAuthHeaders({ MODAL_INFERENCE_KEY: 'sk-1' } as NodeJS.ProcessEnv)).toEqual({
      Authorization: 'Bearer sk-1',
    });
  });

  it('ignores the Modal-Key/Modal-Secret proxy-token pair entirely', () => {
    // Regression guard for a hedge that was removed on evidence, not taste: the
    // proxy-token pair authenticates DEDICATED Auto Endpoints. Sent to the
    // Shared API it returns "missing or invalid Authorization header" — the
    // same response as sending no credentials at all. Reintroducing it as a
    // preferred scheme would make a correctly-configured bot fail to reach the
    // model while looking, from the env, entirely well set up.
    expect(buildAuthHeaders({ MODAL_KEY: 'wk-1', MODAL_SECRET: 'ws-1' } as NodeJS.ProcessEnv)).toEqual({
      Authorization: 'Bearer ',
    });
  });

  it('sends the bearer even when the retired pair is also present', async () => {
    process.env.MODAL_KEY = 'wk-1';
    process.env.MODAL_SECRET = 'ws-1';
    process.env.MODAL_INFERENCE_KEY = 'sk-1';
    const read = captureFetch();
    await callStream();
    const { headers } = read();
    expect(headers.Authorization).toBe('Bearer sk-1');
    expect(headers).not.toHaveProperty('Modal-Key');
  });
});

describe('message conversion + reasoning echo-back', () => {
  it('echoes a thinking block back as reasoning_content alongside content and tool_calls', () => {
    const out = toOpenAIMessages('sys', [
      { role: 'user', content: 'how many rows?' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'The table is big; count first.' },
          { type: 'text', text: 'Checking.' },
          { type: 'tool_use', id: 'call_1', name: 'query', input: { sql: 'select count(*) from t' } },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '42' }] },
    ]);

    expect(out[0]).toEqual({ role: 'system', content: 'sys' });
    expect(out[1]).toEqual({ role: 'user', content: 'how many rows?' });
    expect(out[2]).toEqual({
      role: 'assistant',
      content: 'Checking.',
      reasoning_content: 'The table is big; count first.',
      tool_calls: [{
        id: 'call_1',
        type: 'function',
        function: { name: 'query', arguments: JSON.stringify({ sql: 'select count(*) from t' }) },
      }],
    });
    expect(out[3]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: '42' });
  });

  it('round-trips reasoning verbatim: concatenated deltas in, identical string out', () => {
    // The loop builds the thinking block by concatenating raw
    // `delta.reasoning_content` chunks, so echo-back must be byte-identical.
    const chunks = ['Step 1. ', 'Step 2.\n', 'Step 3 — done.'];
    const out = toOpenAIMessages('sys', [
      { role: 'assistant', content: [{ type: 'thinking', thinking: chunks.join('') }] },
    ]);
    expect(out[1]).toEqual({ role: 'assistant', reasoning_content: chunks.join('') });
  });

  it('joins multiple thinking blocks rather than keeping only the last', () => {
    const out = toOpenAIMessages('sys', [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'first.' },
          { type: 'thinking', thinking: 'second.' },
        ],
      },
    ]);
    expect(out[1]).toMatchObject({ reasoning_content: 'first.second.' });
  });

  it('omits reasoning_content entirely when the assistant message has no thinking', () => {
    const out = toOpenAIMessages('sys', [
      { role: 'assistant', content: [{ type: 'text', text: 'plain' }] },
    ]);
    expect(out[1]).toEqual({ role: 'assistant', content: 'plain' });
    expect(out[1]).not.toHaveProperty('reasoning_content');
  });

  it('carries reasoning_content through the real request body', async () => {
    process.env.MODAL_INFERENCE_KEY = 'k';
    const read = captureFetch();
    await callStream({
      messages: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: [{ type: 'thinking', thinking: 'because.' }, { type: 'text', text: 'a' }] },
      ],
    });
    const msgs = read().body.messages as Array<Record<string, unknown>>;
    expect(msgs[2]).toMatchObject({ role: 'assistant', reasoning_content: 'because.' });
  });

  it('passes multimodal user content arrays through untouched', () => {
    const parts = [{ type: 'text', text: 'what is this' }, { type: 'image_url', image_url: { url: 'data:…' } }];
    const out = toOpenAIMessages('sys', [{ role: 'user', content: parts }]);
    expect(out[1]).toEqual({ role: 'user', content: parts });
  });
});

describe('cost computation', () => {
  const M = 1_000_000;

  it('bills uncached and cached prompt tokens at their separate rates without double-charging', () => {
    const cost = computeCostUSD({ promptTokens: 1000, completionTokens: 0, cachedPromptTokens: 400 });
    // 600 @ $3 + 400 @ $0.30
    expect(cost).toBeCloseTo((600 * 3 + 400 * 0.3) / M, 12);
    // Strictly cheaper than billing all 1000 at the full prompt rate.
    expect(cost).toBeLessThan((1000 * 3) / M);
  });

  it('treats reasoning tokens as a subset of completion tokens (no double charge)', () => {
    const withReasoning = computeCostUSD({ promptTokens: 0, completionTokens: 1000, reasoningTokens: 700 });
    const without = computeCostUSD({ promptTokens: 0, completionTokens: 1000 });
    // Same rate today, so the split must not change the total.
    expect(withReasoning).toBeCloseTo(without, 12);
    expect(withReasoning).toBeCloseTo((1000 * 15) / M, 12);
  });

  it('computes a full mixed call', () => {
    const cost = computeCostUSD({
      promptTokens: 120_000, completionTokens: 8_000,
      cachedPromptTokens: 100_000, reasoningTokens: 3_000,
    });
    expect(cost).toBeCloseTo((20_000 * 3 + 100_000 * 0.3 + 8_000 * 15) / M, 12);
  });

  it('is zero for a zero-token call and never negative', () => {
    expect(computeCostUSD({ promptTokens: 0, completionTokens: 0 })).toBe(0);
    expect(computeCostUSD({ promptTokens: -5, completionTokens: -5 })).toBe(0);
  });

  it('clamps detail counts that exceed their parent (defensive against odd upstream usage blocks)', () => {
    // cached > prompt must not produce a negative uncached charge.
    expect(computeCostUSD({ promptTokens: 100, completionTokens: 0, cachedPromptTokens: 500 }))
      .toBeCloseTo((100 * 0.3) / M, 12);
    // reasoning > completion likewise.
    expect(computeCostUSD({ promptTokens: 0, completionTokens: 100, reasoningTokens: 500 }))
      .toBeCloseTo((100 * 15) / M, 12);
  });

  it('pins the published K3 rate table', () => {
    // https://modal.com/library/moonshot/kimi-k3 — update deliberately.
    expect(KIMI_K3_RATES_PER_MTOK).toEqual({
      prompt: 3.0, cachedPrompt: 0.3, completion: 15.0, reasoning: 15.0,
    });
  });
});

describe('model profile', () => {
  it('defaults to moonshotai/Kimi-K3 with a 1M context window', () => {
    const p = getModelProfile();
    expect(p.id).toBe('moonshotai/Kimi-K3');
    expect(p.contextWindow).toBe(1_000_000);
    expect(p.maxTokens).toBe(16384);
    expect(p.supportsReasoning).toBe(true);
  });

  it('honours MODAL_INFERENCE_MODEL', () => {
    process.env.MODAL_INFERENCE_MODEL = ' anthropic/claude-sonnet-5 ';
    const p = getModelProfile();
    expect(p.id).toBe('anthropic/claude-sonnet-5');
    expect(p.contextWindow).toBe(200_000);
  });

  it('resolves Kimi context windows to 1M and keeps the inherited families working', () => {
    expect(getContextWindow('moonshotai/Kimi-K3')).toBe(1_000_000);
    expect(getContextWindow('kimi-k3')).toBe(1_000_000);
    expect(getContextWindow('google/gemini-3-flash-preview')).toBe(1_000_000);
    expect(getContextWindow('openai/gpt-4o')).toBe(128_000);
    expect(getContextWindow('some/unknown-model')).toBe(200_000);
  });

  it('treats Kimi as vision-capable', () => {
    // Hygiene only: modelSupportsVision has no caller and the bot has no
    // Slack file-upload path (see llm-client.ts).
    expect(modelSupportsVision('moonshotai/Kimi-K3')).toBe(true);
    expect(modelSupportsVision('some/text-only-model')).toBe(false);
  });
});
