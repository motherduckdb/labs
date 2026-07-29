import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Controllog is a no-op spy set — the loop must survive without a session and
// we don't want JSONL side effects from tests.
vi.mock('./controllog', () => ({
  newId: vi.fn(() => 'test-exchange-id'),
  modelPrompt: vi.fn(),
  modelCompletion: vi.fn(),
  toolEnd: vi.fn(),
  streamError: vi.fn(),
}));

// A marker string keeps assertions cheap and proves the loop appended THIS
// supplement to whatever the real get_dive_guide dispatch returned.
vi.mock('./gemini-dive-guide', () => ({
  buildGeminiDiveSupplement: vi.fn(() => 'GEMINI SUPPLEMENT'),
}));

import { runAgenticLoop, type RunAgenticLoopOpts } from './agentic-loop';
import { computeCostUSD } from './llm-client';
import { buildGeminiDiveSupplement } from './gemini-dive-guide';
import type { MvizBlockEvent, ToolEndCall, ToolStartCall, TurnSink } from './turn-sink';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

// ---------------------------------------------------------------------------
// Synthetic Kimi K3 SSE streams.
//
// The wire format is standard OpenAI streaming: reasoning arrives as
// `delta.reasoning_content`, and the final chunk (from
// `stream_options.include_usage`) carries token counts ONLY — no dollar cost,
// which the loop now derives locally via computeCostUSD.
// ---------------------------------------------------------------------------

function sseStream(payloads: Array<Record<string, unknown>>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const payload of payloads) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
}

function splitEvery(text: string, size: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return chunks;
}

/** Usage payload of the terminal chunk in `textStream`. */
const TEXT_USAGE = {
  prompt_tokens: 120,
  completion_tokens: 30,
  prompt_tokens_details: { cached_tokens: 20 },
  completion_tokens_details: { reasoning_tokens: 10 },
};

/** Usage payload of the terminal chunk in `toolCallStream` (no detail fields). */
const TOOL_USAGE = { prompt_tokens: 100, completion_tokens: 10 };

function textStream(text: string, opts?: { chunkSize?: number; reasoning?: string }): ReadableStream<Uint8Array> {
  const payloads: Array<Record<string, unknown>> = [];
  if (opts?.reasoning) {
    for (const chunk of splitEvery(opts.reasoning, 16)) {
      payloads.push({ choices: [{ delta: { reasoning_content: chunk } }] });
    }
  }
  for (const chunk of splitEvery(text, opts?.chunkSize ?? 16)) {
    payloads.push({ choices: [{ delta: { content: chunk } }] });
  }
  payloads.push({
    choices: [{ delta: {}, finish_reason: 'stop' }],
    usage: TEXT_USAGE,
  });
  return sseStream(payloads);
}

function toolCallStream(
  calls: Array<{ id: string; name: string; args: Record<string, unknown> | string }>,
  opts?: { reasoning?: string },
): ReadableStream<Uint8Array> {
  return sseStream([
    ...(opts?.reasoning
      ? splitEvery(opts.reasoning, 16).map((chunk) => ({ choices: [{ delta: { reasoning_content: chunk } }] }))
      : []),
    {
      choices: [{
        delta: {
          tool_calls: calls.map((call, index) => ({
            index,
            id: call.id,
            type: 'function',
            function: {
              name: call.name,
              // A raw string lets a test emit the malformed-arguments shape K3
              // occasionally produces; objects are stringified as usual.
              arguments: typeof call.args === 'string' ? call.args : JSON.stringify(call.args),
            },
          })),
        },
      }],
    },
    {
      choices: [{ delta: {}, finish_reason: 'tool_calls' }],
      usage: TOOL_USAGE,
    },
  ]);
}

// ---------------------------------------------------------------------------
// Recording sink + loop harness.
// ---------------------------------------------------------------------------

type RecordedEvent =
  | { type: 'text'; content: string }
  | { type: 'thinking'; content: string }
  | { type: 'thinking_done' }
  | { type: 'tool_start'; call: ToolStartCall }
  | { type: 'tool_end'; call: ToolEndCall }
  | { type: 'mviz_pending'; id: string }
  | { type: 'mviz_block'; block: MvizBlockEvent }
  | { type: 'usage'; usage: Record<string, unknown> }
  | { type: 'error'; message: string }
  | { type: 'auth_expired'; message: string }
  | { type: 'turn_complete'; finishReason: string };

function createRecordingSink(): { events: RecordedEvent[]; sink: TurnSink } {
  const events: RecordedEvent[] = [];
  const sink: TurnSink = {
    onText: (content) => events.push({ type: 'text', content }),
    onThinking: (content) => events.push({ type: 'thinking', content }),
    onThinkingDone: () => events.push({ type: 'thinking_done' }),
    onToolStart: (call) => events.push({ type: 'tool_start', call }),
    onToolEnd: (call) => events.push({ type: 'tool_end', call }),
    onMvizPending: (id) => events.push({ type: 'mviz_pending', id }),
    onMvizBlock: (block) => events.push({ type: 'mviz_block', block }),
    onUsage: (usage) => events.push({ type: 'usage', usage: usage as unknown as Record<string, unknown> }),
    onError: (message) => events.push({ type: 'error', message }),
    onAuthExpired: (message) => events.push({ type: 'auth_expired', message }),
    onTurnComplete: (finishReason) => events.push({ type: 'turn_complete', finishReason }),
  };
  return { events, sink };
}

function joinedText(events: RecordedEvent[]): string {
  return events.filter((e) => e.type === 'text').map((e) => e.content).join('');
}

async function runLoop(opts: {
  streams: Array<() => ReadableStream<Uint8Array>>;
  dispatchToolImpl?: RunAgenticLoopOpts['dispatchToolImpl'];
  confirmTool?: RunAgenticLoopOpts['confirmTool'];
  profileId?: string;
}) {
  const { events, sink } = createRecordingSink();
  const script = [...opts.streams];
  const streamChatCompletion = vi.fn(async () => {
    const next = script.shift();
    if (!next) throw new Error('mock LLM script exhausted');
    return next();
  });
  const messages: Array<{ role: string; content: unknown }> = [{ role: 'user', content: 'question' }];
  const result = await runAgenticLoop({
    messages,
    turnStartIndex: messages.length,
    profile: { id: opts.profileId ?? 'test-model', maxTokens: 1024, supportsReasoning: true, contextWindow: 200_000 },
    thinkingLevel: 'none',
    client: {} as Client,
    tools: [],
    systemPrompt: 'test system prompt',
    sink,
    taskId: 'task-1',
    runId: 'run-1',
    requestText: 'question',
    historyLength: 0,
    streamChatCompletion: streamChatCompletion as unknown as RunAgenticLoopOpts['streamChatCompletion'],
    ...(opts.dispatchToolImpl && { dispatchToolImpl: opts.dispatchToolImpl }),
    ...(opts.confirmTool && { confirmTool: opts.confirmTool }),
  });
  return { result, events, streamChatCompletion };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runAgenticLoop with TurnSink', () => {
  // The dive-guide supplement is now an explicit env opt-in (default OFF on
  // K3), so every test starts from "off" and the supplement tests turn it on.
  const savedSupplementFlag = process.env.QUACKBOT_DIVE_SUPPLEMENT;
  beforeEach(() => { delete process.env.QUACKBOT_DIVE_SUPPLEMENT; });
  afterEach(() => {
    if (savedSupplementFlag === undefined) delete process.env.QUACKBOT_DIVE_SUPPLEMENT;
    else process.env.QUACKBOT_DIVE_SUPPLEMENT = savedSupplementFlag;
  });

  it('streams text deltas as onText in order and finishes done', async () => {
    const answer = 'Hello! This is a plain streamed answer with no fences in it at all.';
    const { result, events } = await runLoop({ streams: [() => textStream(answer)] });

    expect(joinedText(events)).toBe(answer);
    expect(events.filter((e) => e.type === 'error')).toHaveLength(0);

    const usageEvents = events.filter((e) => e.type === 'usage');
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0].usage).toMatchObject({
      promptTokens: 120, completionTokens: 30,
      cachedPromptTokens: 20, reasoningTokens: 10,
      model: 'test-model', contextWindow: 200_000,
    });
    // Cost is no longer supplied by the provider — it is derived from the
    // token counts and the K3 rate table.
    expect(Number(usageEvents[0].usage.cost)).toBeCloseTo(
      computeCostUSD({ promptTokens: 120, completionTokens: 30, cachedPromptTokens: 20, reasoningTokens: 10 }),
      12,
    );
    // Pinned literal so a rate-table edit has to be deliberate:
    // 100 uncached prompt @ $3 + 20 cached @ $0.30 + 30 completion @ $15 per MTok.
    expect(Number(usageEvents[0].usage.cost)).toBeCloseTo(0.000756, 9);

    // turn_complete is the terminal event of the turn.
    expect(events[events.length - 1]).toEqual({ type: 'turn_complete', finishReason: 'done' });

    expect(result.finishReason).toBe('done');
    expect(result.newTurnMessages).toEqual([
      { role: 'assistant', content: [{ type: 'text', text: answer }] },
    ]);
  });

  // Captured verbatim from the live Kimi K3 endpoint on 2026-07-28: reasoning
  // tokens at the top level of `usage`, and `prompt_tokens_details: null`
  // rather than absent. The OpenAI-nested shape is covered by the test above;
  // this one exists because the deployed server does not use it.
  it('reads reasoning_tokens from the top level of usage, as the live endpoint emits it', async () => {
    const liveShape = () => sseStream([
      { choices: [{ delta: { content: 'quackbot online' } }] },
      {
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 120,
          completion_tokens: 30,
          total_tokens: 150,
          prompt_tokens_details: null,
          reasoning_tokens: 10,
        },
      },
    ]);
    const { events } = await runLoop({ streams: [liveShape] });

    const usageEvents = events.filter((e) => e.type === 'usage');
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0].usage).toMatchObject({
      promptTokens: 120, completionTokens: 30, reasoningTokens: 10,
    });
    // A null `prompt_tokens_details` must leave the field unset, not crash and
    // not read as zero cached tokens billed at the cached rate.
    expect(usageEvents[0].usage.cachedPromptTokens).toBeUndefined();
    expect(Number(usageEvents[0].usage.cost)).toBeCloseTo(
      computeCostUSD({ promptTokens: 120, completionTokens: 30, reasoningTokens: 10 }),
      12,
    );
  });

  it('routes reasoning deltas to onThinking and fires onThinkingDone after the stream', async () => {
    const { result, events } = await runLoop({
      streams: [() => textStream('Final answer.', { reasoning: 'Let me reason about the schema first.' })],
    });

    const thinkingText = events.filter((e) => e.type === 'thinking').map((e) => e.content).join('');
    expect(thinkingText).toBe('Let me reason about the schema first.');

    const doneIndexes = events.map((e, i) => (e.type === 'thinking_done' ? i : -1)).filter((i) => i >= 0);
    expect(doneIndexes).toHaveLength(1);
    const lastThinkingIndex = events.map((e, i) => (e.type === 'thinking' ? i : -1)).filter((i) => i >= 0).pop()!;
    expect(doneIndexes[0]).toBeGreaterThan(lastThinkingIndex);

    expect(result.newTurnMessages[0]).toEqual({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'Let me reason about the schema first.' },
        { type: 'text', text: 'Final answer.' },
      ],
    });
  });

  it('runs a tool round: onToolStart before onToolEnd, then a second LLM call', async () => {
    const dispatchToolImpl = vi.fn(async (_opts: { client: Client; name: string; args: Record<string, unknown> }) => ({
      content: 'sql-result: 3 rows',
      isError: false,
    }));
    const { result, events, streamChatCompletion } = await runLoop({
      streams: [
        () => toolCallStream([{ id: 'call_1', name: 'query', args: { sql: 'select 1' } }]),
        () => textStream('The answer is 42.'),
      ],
      dispatchToolImpl,
    });

    expect(streamChatCompletion).toHaveBeenCalledTimes(2);
    expect(dispatchToolImpl).toHaveBeenCalledTimes(1);
    expect(dispatchToolImpl.mock.calls[0][0]).toMatchObject({ name: 'query', args: { sql: 'select 1' } });

    const startIndex = events.findIndex((e) => e.type === 'tool_start');
    const endIndex = events.findIndex((e) => e.type === 'tool_end');
    expect(startIndex).toBeGreaterThanOrEqual(0);
    expect(endIndex).toBeGreaterThan(startIndex);
    expect(events[startIndex]).toMatchObject({ call: { id: 'call_1', name: 'query', args: { sql: 'select 1' } } });
    expect(events[endIndex]).toMatchObject({ call: { id: 'call_1', name: 'query', result: 'sql-result: 3 rows' } });

    // One usage event per LLM iteration.
    expect(events.filter((e) => e.type === 'usage')).toHaveLength(2);

    expect(result.finishReason).toBe('done');
    expect(result.turnToolNames).toEqual(new Set(['query']));
    expect(result.newTurnMessages).toEqual([
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call_1', name: 'query', input: { sql: 'select 1' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'sql-result: 3 rows' }],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'The answer is 42.' }] },
    ]);
  });

  it('dispatches a durable write after confirmTool approves it', async () => {
    const confirmTool = vi.fn(async (_c: { id: string; name: string; args: Record<string, unknown> }) => true);
    const dispatchToolImpl = vi.fn(async (_o: { client: Client; name: string; args: Record<string, unknown> }) => ({
      content: 'guide saved', isError: false,
    }));
    const { result, streamChatCompletion } = await runLoop({
      streams: [
        () => toolCallStream([{ id: 'w1', name: 'create_guide', args: { path: 'users/u/quackbot/a.md', content: 'x' } }]),
        () => textStream('Saved.'),
      ],
      dispatchToolImpl,
      confirmTool,
    });
    expect(confirmTool).toHaveBeenCalledTimes(1);
    expect(confirmTool.mock.calls[0][0]).toMatchObject({ name: 'create_guide' });
    expect(dispatchToolImpl).toHaveBeenCalledTimes(1);
    expect(streamChatCompletion).toHaveBeenCalledTimes(2);
    expect(result.finishReason).toBe('done');
  });

  it('skips a durable write and returns an error tool_result when confirmTool denies it', async () => {
    const confirmTool = vi.fn(async () => false);
    // update_guide now resolves its target via a read-only get_guide before the
    // gate; that read succeeds (quackbot-topic header) but the WRITE never runs.
    const dispatchToolImpl = vi.fn(async (o: { client: Client; name: string; args: Record<string, unknown> }) => {
      if (o.name === 'get_guide') {
        return { content: 'Taxi data table\nuuid: b0-1 · topic: quackbot/taxi · v3 · user\nA table.\n\nBody.', isError: false };
      }
      return { content: 'guide saved', isError: false };
    });
    const { result, events } = await runLoop({
      streams: [
        () => toolCallStream([{ id: 'w1', name: 'update_guide', args: { uuid: 'b0-1', content: 'x' } }]),
        () => textStream('Okay, not saving.'),
      ],
      dispatchToolImpl,
      confirmTool,
    });
    // The resolve read ran, but the update_guide WRITE never reached MCP.
    expect(dispatchToolImpl).toHaveBeenCalledTimes(1);
    expect(dispatchToolImpl.mock.calls[0][0]).toMatchObject({ name: 'get_guide', args: { uuid: 'b0-1' } });
    expect(confirmTool).toHaveBeenCalledTimes(1);
    // ...but the round stayed paired: a tool_result (is_error) was recorded and
    // surfaced to the sink, and the loop continued to a final answer.
    const toolEnd = events.find((e) => e.type === 'tool_end');
    expect(toolEnd).toMatchObject({ call: { name: 'update_guide', error: true } });
    const toolMsg = result.newTurnMessages.find((m) => m.role === 'user') as { content: Array<Record<string, unknown>> };
    expect(toolMsg.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'w1', is_error: true });
    expect(String(toolMsg.content[0].content)).toMatch(/declined/i);
    expect(result.finishReason).toBe('done');
  });

  it('resolves the target guide before confirming an update_guide and threads {title, topic, uuid} into confirmTool', async () => {
    const confirmTool = vi.fn(async (_c: { id: string; name: string; args: Record<string, unknown>; target?: unknown }) => true);
    const dispatchToolImpl = vi.fn(async (o: { client: Client; name: string; args: Record<string, unknown> }) => {
      if (o.name === 'get_guide') {
        return { content: 'NBA scoring estimates\nuuid: 1d02-77 · topic: quackbot/nba · v2 · user\nEstimates.\n\nBody text.', isError: false };
      }
      return { content: 'guide updated', isError: false };
    });
    const { result } = await runLoop({
      streams: [
        () => toolCallStream([{ id: 'w1', name: 'update_guide', args: { uuid: '1d02-77', content: 'new body' } }]),
        () => textStream('Updated.'),
      ],
      dispatchToolImpl,
      confirmTool,
    });
    // One resolve read + one write dispatch, in that order.
    expect(dispatchToolImpl.mock.calls.map((c) => c[0].name)).toEqual(['get_guide', 'update_guide']);
    // The confirmation was handed the resolved target.
    expect(confirmTool).toHaveBeenCalledTimes(1);
    expect(confirmTool.mock.calls[0][0]).toMatchObject({
      name: 'update_guide',
      target: { title: 'NBA scoring estimates', topic: 'quackbot/nba', uuid: '1d02-77' },
    });
    expect(result.finishReason).toBe('done');
  });

  it('does NOT add a resolve round-trip for create_guide (topic is in its own args)', async () => {
    const confirmTool = vi.fn(async (_c: { id: string; name: string; args: Record<string, unknown>; target?: unknown }) => true);
    const dispatchToolImpl = vi.fn(async (_o: { client: Client; name: string; args: Record<string, unknown> }) => ({
      content: 'guide created', isError: false,
    }));
    await runLoop({
      streams: [
        () => toolCallStream([{ id: 'c1', name: 'create_guide', args: { topic: 'quackbot/x', title: 't', content: 'c' } }]),
        () => textStream('Created.'),
      ],
      dispatchToolImpl,
      confirmTool,
    });
    // Exactly one dispatch — the create itself, no preceding get_guide.
    expect(dispatchToolImpl).toHaveBeenCalledTimes(1);
    expect(dispatchToolImpl.mock.calls[0][0]).toMatchObject({ name: 'create_guide' });
    expect(confirmTool.mock.calls[0][0].target).toBeUndefined();
  });

  it('rejects an uuid guide write whose target lives outside the quackbot namespace — never confirms, never writes', async () => {
    const confirmTool = vi.fn(async () => true);
    const dispatchToolImpl = vi.fn(async (o: { client: Client; name: string; args: Record<string, unknown> }) => {
      if (o.name === 'get_guide') {
        return { content: 'Org revenue guide\nuuid: org-9 · topic: finance/metrics · v5 · organization\nDesc.\n\nBody.', isError: false };
      }
      return { content: 'should never run', isError: false };
    });
    const { result, events } = await runLoop({
      streams: [
        () => toolCallStream([{ id: 'w1', name: 'edit_guide_content', args: { uuid: 'org-9', edits: [{ old_string: 'a', new_string: 'b' }] } }]),
        () => textStream('Understood, cannot edit that guide.'),
      ],
      dispatchToolImpl,
      confirmTool,
    });
    // Resolve read ran; the write was refused before confirmation.
    expect(dispatchToolImpl).toHaveBeenCalledTimes(1);
    expect(dispatchToolImpl.mock.calls[0][0]).toMatchObject({ name: 'get_guide' });
    expect(confirmTool).not.toHaveBeenCalled();
    const toolEnd = events.find((e) => e.type === 'tool_end');
    expect(toolEnd).toMatchObject({ call: { name: 'edit_guide_content', error: true } });
    const toolMsg = result.newTurnMessages.find((m) => m.role === 'user') as { content: Array<Record<string, unknown>> };
    expect(toolMsg.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'w1', is_error: true });
    expect(String(toolMsg.content[0].content)).toMatch(/quackbot/i);
    expect(result.finishReason).toBe('done');
  });

  it('fails closed when the target guide cannot be read (lookup error) — refuses, does not confirm', async () => {
    const confirmTool = vi.fn(async () => true);
    const dispatchToolImpl = vi.fn(async (o: { client: Client; name: string; args: Record<string, unknown> }) => {
      if (o.name === 'get_guide') return { content: 'Could not find guide or not authorized', isError: true, errorMessage: 'not found' };
      return { content: 'should never run', isError: false };
    });
    const { result } = await runLoop({
      streams: [
        () => toolCallStream([{ id: 'w1', name: 'update_guide', args: { uuid: 'ghost', content: 'x' } }]),
        () => textStream('Cannot find that guide.'),
      ],
      dispatchToolImpl,
      confirmTool,
    });
    expect(dispatchToolImpl).toHaveBeenCalledTimes(1);
    expect(confirmTool).not.toHaveBeenCalled();
    const toolMsg = result.newTurnMessages.find((m) => m.role === 'user') as { content: Array<Record<string, unknown>> };
    expect(toolMsg.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'w1', is_error: true });
    expect(String(toolMsg.content[0].content)).toMatch(/could not read/i);
  });

  it('fails closed when the target guide header cannot be parsed — refuses, does not confirm', async () => {
    const confirmTool = vi.fn(async () => true);
    const dispatchToolImpl = vi.fn(async (o: { client: Client; name: string; args: Record<string, unknown> }) => {
      // A body with no recognizable `uuid: … · topic: …` metadata line.
      if (o.name === 'get_guide') return { content: 'just some prose with no metadata header at all', isError: false };
      return { content: 'should never run', isError: false };
    });
    const { result } = await runLoop({
      streams: [
        () => toolCallStream([{ id: 'w1', name: 'update_guide', args: { uuid: 'weird', content: 'x' } }]),
        () => textStream('Cannot verify that guide.'),
      ],
      dispatchToolImpl,
      confirmTool,
    });
    expect(confirmTool).not.toHaveBeenCalled();
    const toolMsg = result.newTurnMessages.find((m) => m.role === 'user') as { content: Array<Record<string, unknown>> };
    expect(toolMsg.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'w1', is_error: true });
    expect(String(toolMsg.content[0].content)).toMatch(/could not parse/i);
  });

  it('does NOT confirm a plain read even when confirmTool is supplied', async () => {
    const confirmTool = vi.fn(async () => true);
    const dispatchToolImpl = vi.fn(async (_o: { client: Client; name: string; args: Record<string, unknown> }) => ({
      content: 'rows', isError: false,
    }));
    await runLoop({
      streams: [
        () => toolCallStream([{ id: 'r1', name: 'query', args: { sql: 'select 1' } }]),
        () => textStream('Answer.'),
      ],
      dispatchToolImpl,
      confirmTool,
    });
    expect(confirmTool).not.toHaveBeenCalled();
    expect(dispatchToolImpl).toHaveBeenCalledTimes(1);
  });

  it('turns a complete table fence into onMvizPending + onMvizBlock without leaking fence text', async () => {
    const tableSpec = JSON.stringify({
      title: 'Teams',
      columns: [{ id: 'team', title: 'Team' }, { id: 'points', title: 'Points' }],
      data: [{ team: 'BOS', points: 10422 }],
    });
    const fence = '```table\n' + tableSpec + '\n```';
    const answer = `Here are the teams:\n\n${fence}\n\nLet me know if you want more.`;

    const { result, events } = await runLoop({ streams: [() => textStream(answer, { chunkSize: 8 })] });

    const pendings = events.filter((e) => e.type === 'mviz_pending');
    const blocks = events.filter((e) => e.type === 'mviz_block');
    expect(pendings).toHaveLength(1);
    expect(blocks).toHaveLength(1);
    expect(events.findIndex((e) => e.type === 'mviz_pending')).toBeLessThan(
      events.findIndex((e) => e.type === 'mviz_block'),
    );

    // The block carries the pending id and the RAW fence source.
    expect(blocks[0].block.id).toBe(pendings[0].id);
    expect(blocks[0].block.source).toBe(fence);
    expect(blocks[0].block.fallback).toBeUndefined();
    // Real mviz-processor output, not fallback HTML.
    expect(blocks[0].block.html).toContain('data-table');
    expect(blocks[0].block.html).not.toContain('Table render failed');

    // No fence markup or fence body leaks through onText.
    const outside = joinedText(events);
    expect(outside).not.toContain('```');
    expect(outside).not.toContain('10422');
    expect(outside).toContain('Here are the teams:');
    expect(outside).toContain('Let me know if you want more.');

    // The assistant message keeps the full text including the fence.
    expect(result.newTurnMessages[0]).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: answer }],
    });
  });

  it('emits a fallback MvizBlockEvent for a fence truncated at end-of-stream', async () => {
    const truncated = 'Partial result:\n```table\n{"columns":[{"id":"a"';
    const { result, events } = await runLoop({ streams: [() => textStream(truncated, { chunkSize: 8 })] });

    const pendings = events.filter((e) => e.type === 'mviz_pending');
    const blocks = events.filter((e) => e.type === 'mviz_block');
    expect(pendings).toHaveLength(1);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].block).toMatchObject({
      id: pendings[0].id,
      source: '',
      fallback: true,
    });
    expect(blocks[0].block.html).toContain('cut off');

    // Text before the fence still streamed; nothing inside the fence leaked.
    expect(joinedText(events)).toBe('Partial result:\n');
    expect(result.finishReason).toBe('done');
  });

  it('retains reasoning_content on the assistant message of a TOOL round (the K3 echo-back requirement)', async () => {
    // Moonshot requires the entire untouched assistant message — reasoning
    // included — to be echoed back across tool calls. That starts here: the
    // thinking block must survive onto the message the loop appends to
    // history, ahead of the tool_use blocks. llm-client then serializes it
    // back out as `reasoning_content` (see llm-client.test.ts).
    const dispatchToolImpl = vi.fn(async (_o: { client: Client; name: string; args: Record<string, unknown> }) => ({
      content: 'rows', isError: false,
    }));
    const { result } = await runLoop({
      streams: [
        () => toolCallStream(
          [{ id: 'call_1', name: 'query', args: { sql: 'select 1' } }],
          { reasoning: 'I should check the schema before querying.' },
        ),
        () => textStream('Done.'),
      ],
      dispatchToolImpl,
    });

    expect(result.newTurnMessages[0]).toEqual({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'I should check the schema before querying.' },
        { type: 'tool_use', id: 'call_1', name: 'query', input: { sql: 'select 1' } },
      ],
    });
  });

  it('surfaces a malformed tool-call argument blob as an error tool_result instead of dispatching or throwing', async () => {
    // K3's tool-call emitter occasionally produces arguments its own parser
    // can't read. The turn must survive: no dispatch, a paired is_error
    // tool_result the model can act on, and a normal second iteration.
    const dispatchToolImpl = vi.fn(async (_o: { client: Client; name: string; args: Record<string, unknown> }) => ({
      content: 'should never run', isError: false,
    }));
    const { result, events } = await runLoop({
      streams: [
        () => toolCallStream([{ id: 'bad_1', name: 'query', args: '{"sql": "select 1"' }]),
        () => textStream('Let me try that again.'),
      ],
      dispatchToolImpl,
      profileId: 'moonshotai/Kimi-K3',
    });

    expect(dispatchToolImpl).not.toHaveBeenCalled();
    const toolEnd = events.find((e) => e.type === 'tool_end');
    expect(toolEnd).toMatchObject({ call: { id: 'bad_1', name: 'query', error: true } });

    const toolMsg = result.newTurnMessages.find((m) => m.role === 'user') as { content: Array<Record<string, unknown>> };
    expect(toolMsg.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'bad_1', is_error: true });
    expect(String(toolMsg.content[0].content)).toMatch(/not valid JSON/i);
    // The malformed text is echoed back (truncated) so the model can see what it sent.
    expect(String(toolMsg.content[0].content)).toContain('{"sql": "select 1"');
    // The loop kept going and answered.
    expect(result.finishReason).toBe('done');
    expect(joinedText(events)).toBe('Let me try that again.');
  });

  it('treats a valid-JSON-but-non-object argument blob as malformed', async () => {
    const dispatchToolImpl = vi.fn(async (_o: { client: Client; name: string; args: Record<string, unknown> }) => ({
      content: 'should never run', isError: false,
    }));
    const { result } = await runLoop({
      streams: [
        () => toolCallStream([{ id: 'bad_2', name: 'query', args: '"select 1"' }]),
        () => textStream('Retrying.'),
      ],
      dispatchToolImpl,
    });
    expect(dispatchToolImpl).not.toHaveBeenCalled();
    const toolMsg = result.newTurnMessages.find((m) => m.role === 'user') as { content: Array<Record<string, unknown>> };
    expect(toolMsg.content[0]).toMatchObject({ tool_use_id: 'bad_2', is_error: true });
  });

  it('does NOT intercept ordinary guide reads — list_guides flows through dispatchTool, even on Gemini', async () => {
    const dispatchToolImpl = vi.fn(async (_opts: { client: Client; name: string; args: Record<string, unknown> }) => ({
      content: JSON.stringify({ guides: [] }),
      isError: false,
    }));
    const { result, events } = await runLoop({
      streams: [
        () => toolCallStream([{ id: 'ctx_1', name: 'list_guides', args: { keyword: 'join keys' } }]),
        () => textStream('No saved guides yet.'),
      ],
      dispatchToolImpl,
      profileId: 'google/gemini-3-flash-preview',
    });

    // Dispatched like any other tool: real dispatch path, tool_start/tool_end events.
    expect(dispatchToolImpl).toHaveBeenCalledTimes(1);
    expect(dispatchToolImpl.mock.calls[0][0]).toMatchObject({
      name: 'list_guides',
      args: { keyword: 'join keys' },
    });
    expect(events.some((e) => e.type === 'tool_start' && e.call.name === 'list_guides')).toBe(true);
    expect(events.some((e) => e.type === 'tool_end' && e.call.name === 'list_guides')).toBe(true);

    // No pause: the loop continued to a second LLM call and finished normally.
    expect(result.finishReason).toBe('done');
    expect(result.turnToolNames).toEqual(new Set(['list_guides']));
    const toolResult = (result.newTurnMessages[1].content as Array<Record<string, unknown>>)[0];
    expect(toolResult).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'ctx_1',
      content: JSON.stringify({ guides: [] }),
    });
  });

  it('does NOT augment get_guide(uuid) on Gemini profiles — uuid reads always pass through untouched', async () => {
    vi.mocked(buildGeminiDiveSupplement).mockClear();
    const dispatchToolImpl = vi.fn(async (_opts: { client: Client; name: string; args: Record<string, unknown> }) => ({
      content: 'a saved convention',
      isError: false,
    }));
    await runLoop({
      streams: [
        () => toolCallStream([{ id: 'g_1', name: 'get_guide', args: { uuid: 'ddff9b9d-…' } }]),
        () => textStream('Read it.'),
      ],
      dispatchToolImpl,
      profileId: 'google/gemini-3-flash-preview',
    });
    expect(buildGeminiDiveSupplement).not.toHaveBeenCalled();
    expect(dispatchToolImpl).toHaveBeenCalledTimes(1);
  });

  it('augments get_dive_guide when QUACKBOT_DIVE_SUPPLEMENT is on: dispatches the real stock guide and appends the supplement', async () => {
    process.env.QUACKBOT_DIVE_SUPPLEMENT = '1';
    vi.mocked(buildGeminiDiveSupplement).mockClear();
    const dispatchToolImpl = vi.fn(async (_opts: { client: Client; name: string; args: Record<string, unknown> }) => ({
      content: 'STOCK DIVE GUIDE',
      isError: false,
    }));
    // Model id is deliberately Kimi: the gate is the flag now, not /gemini/.
    const { result, events } = await runLoop({
      streams: [
        () => toolCallStream([{ id: 'guide_1', name: 'get_dive_guide', args: { client: 'other' } }]),
        () => textStream('Guide read, building the dive.'),
      ],
      dispatchToolImpl,
      profileId: 'moonshotai/Kimi-K3',
    });

    // The real stock guide IS fetched via MCP, and the supplement is appended.
    expect(buildGeminiDiveSupplement).toHaveBeenCalledTimes(1);
    expect(dispatchToolImpl).toHaveBeenCalledTimes(1);
    expect(dispatchToolImpl.mock.calls[0][0]).toMatchObject({ name: 'get_dive_guide', args: { client: 'other' } });

    // Same tool_start/tool_end event pair as a dispatched tool.
    const startIndex = events.findIndex((e) => e.type === 'tool_start');
    const endIndex = events.findIndex((e) => e.type === 'tool_end');
    expect(startIndex).toBeGreaterThanOrEqual(0);
    expect(endIndex).toBeGreaterThan(startIndex);
    expect(events[endIndex]).toMatchObject({
      call: { id: 'guide_1', name: 'get_dive_guide', result: 'STOCK DIVE GUIDE\n\nGEMINI SUPPLEMENT' },
    });

    // The composed tool_result (stock + supplement) feeds the next LLM call.
    expect(result.finishReason).toBe('done');
    expect(result.turnToolNames).toEqual(new Set(['get_dive_guide']));
    const toolResult = (result.newTurnMessages[1].content as Array<Record<string, unknown>>)[0];
    expect(toolResult).toEqual({
      type: 'tool_result',
      tool_use_id: 'guide_1',
      content: 'STOCK DIVE GUIDE\n\nGEMINI SUPPLEMENT',
    });
  });

  it('keeps a FAILED stock get_dive_guide fetch an error — no supplement, is_error tool_result', async () => {
    process.env.QUACKBOT_DIVE_SUPPLEMENT = '1';
    vi.mocked(buildGeminiDiveSupplement).mockClear();
    const dispatchToolImpl = vi.fn(async (_opts: { client: Client; name: string; args: Record<string, unknown> }) => ({
      content: 'Tool returned an error:\n\nMCP transport failed', isError: true, errorMessage: 'mcp_error',
    }));
    const { result, events } = await runLoop({
      streams: [
        () => toolCallStream([{ id: 'guide_err', name: 'get_dive_guide', args: { client: 'other' } }]),
        () => textStream('The dive guide could not be fetched.'),
      ],
      dispatchToolImpl,
      profileId: 'google/gemini-3-flash-preview',
    });

    // The supplement is NOT appended to an error, and the failure is preserved.
    expect(buildGeminiDiveSupplement).not.toHaveBeenCalled();
    expect(dispatchToolImpl).toHaveBeenCalledTimes(1);
    const toolEnd = events.find((e) => e.type === 'tool_end');
    expect(toolEnd).toMatchObject({ call: { id: 'guide_err', name: 'get_dive_guide', error: true } });
    const toolResult = (result.newTurnMessages[1].content as Array<Record<string, unknown>>)[0];
    expect(toolResult).toMatchObject({ type: 'tool_result', tool_use_id: 'guide_err', is_error: true });
    expect(String(toolResult.content)).not.toContain('GEMINI SUPPLEMENT');
    expect(String(toolResult.content)).toContain('MCP transport failed');
    expect(result.finishReason).toBe('done');
  });

  it('appends the supplement regardless of the client arg passed', async () => {
    process.env.QUACKBOT_DIVE_SUPPLEMENT = '1';
    vi.mocked(buildGeminiDiveSupplement).mockClear();
    const dispatchToolImpl = vi.fn(async (_opts: { client: Client; name: string; args: Record<string, unknown> }) => ({
      content: 'STOCK DIVE GUIDE',
      isError: false,
    }));
    const { result } = await runLoop({
      streams: [
        () => toolCallStream([{ id: 'guide_1b', name: 'get_dive_guide', args: { client: 'claude' } }]),
        () => textStream('Guide read.'),
      ],
      dispatchToolImpl,
      profileId: 'google/gemini-3-flash-preview',
    });
    expect(buildGeminiDiveSupplement).toHaveBeenCalledTimes(1);
    expect(dispatchToolImpl).toHaveBeenCalledTimes(1);
    const toolResult = (result.newTurnMessages[1].content as Array<Record<string, unknown>>)[0];
    expect(toolResult).toMatchObject({ content: 'STOCK DIVE GUIDE\n\nGEMINI SUPPLEMENT' });
  });

  it('passes get_dive_guide through to dispatchTool WITHOUT the supplement when the flag is unset (the K3 default)', async () => {
    vi.mocked(buildGeminiDiveSupplement).mockClear();
    const dispatchToolImpl = vi.fn(async (_opts: { client: Client; name: string; args: Record<string, unknown> }) => ({
      content: 'mcp stock guide content',
      isError: false,
    }));
    const { result } = await runLoop({
      streams: [
        () => toolCallStream([{ id: 'guide_2', name: 'get_dive_guide', args: { client: 'other' } }]),
        () => textStream('Guide read.'),
      ],
      dispatchToolImpl,
      profileId: 'moonshotai/Kimi-K3',
    });

    expect(buildGeminiDiveSupplement).not.toHaveBeenCalled();
    expect(dispatchToolImpl).toHaveBeenCalledTimes(1);
    expect(dispatchToolImpl.mock.calls[0][0]).toMatchObject({ name: 'get_dive_guide', args: { client: 'other' } });
    const toolResult = (result.newTurnMessages[1].content as Array<Record<string, unknown>>)[0];
    expect(toolResult).toMatchObject({ content: 'mcp stock guide content' });
  });

  it('does NOT apply the supplement on a Gemini id either — the model id no longer gates it', async () => {
    // Regression guard for the migration: the old gate was /gemini/i on the
    // model id. It is gone; only QUACKBOT_DIVE_SUPPLEMENT decides.
    vi.mocked(buildGeminiDiveSupplement).mockClear();
    const dispatchToolImpl = vi.fn(async (_opts: { client: Client; name: string; args: Record<string, unknown> }) => ({
      content: 'STOCK DIVE GUIDE',
      isError: false,
    }));
    const { result } = await runLoop({
      streams: [
        () => toolCallStream([{ id: 'guide_3', name: 'get_dive_guide', args: { client: 'other' } }]),
        () => textStream('Guide read.'),
      ],
      dispatchToolImpl,
      profileId: 'google/gemini-3-flash-preview',
    });
    expect(buildGeminiDiveSupplement).not.toHaveBeenCalled();
    const toolResult = (result.newTurnMessages[1].content as Array<Record<string, unknown>>)[0];
    expect(toolResult).toMatchObject({ content: 'STOCK DIVE GUIDE' });
  });

  it('leaves no unpaired tool_use when auth expires mid-way through a multi-tool round', async () => {
    process.env.QUACKBOT_DIVE_SUPPLEMENT = '1';
    vi.mocked(buildGeminiDiveSupplement).mockClear();
    // Round of three: the dive guide read dispatches the stock guide (then gets
    // the supplement appended) and succeeds, query throws an auth error,
    // list_tables never runs.
    const dispatchToolImpl = vi.fn(async (opts: { client: Client; name: string; args: Record<string, unknown> }) => {
      if (opts.name === 'query') throw new Error('401 Unauthorized');
      if (opts.name === 'get_dive_guide') return { content: 'STOCK DIVE GUIDE', isError: false };
      return { content: 'ok', isError: false };
    });
    const { result, events } = await runLoop({
      streams: [
        () => toolCallStream([
          { id: 'guide_1', name: 'get_dive_guide', args: { client: 'other' } },
          { id: 'query_1', name: 'query', args: { sql: 'select 1' } },
          { id: 'tables_1', name: 'list_tables', args: {} },
        ]),
      ],
      dispatchToolImpl,
      profileId: 'google/gemini-3-flash-preview',
    });

    expect(result.finishReason).toBe('auth_expired');
    expect(events.some((e) => e.type === 'auth_expired')).toBe(true);
    // Two dispatches ran: the dive-guide fetch and query (which threw);
    // list_tables was never dispatched.
    expect(dispatchToolImpl).toHaveBeenCalledTimes(2);
    expect(buildGeminiDiveSupplement).toHaveBeenCalledTimes(1);

    // Persisted round is well-formed: every tool_use has a matching tool_result.
    expect(result.newTurnMessages).toHaveLength(2);
    const [assistantMsg, resultsMsg] = result.newTurnMessages;
    const toolUseIds = (assistantMsg.content as Array<Record<string, unknown>>)
      .filter((b) => b.type === 'tool_use')
      .map((b) => b.id);
    const toolResults = resultsMsg.content as Array<Record<string, unknown>>;
    expect(toolUseIds).toEqual(['guide_1', 'query_1', 'tables_1']);
    expect(toolResults.map((r) => r.tool_use_id)).toEqual(toolUseIds);

    // The ran/failed/skipped results each carry the right content.
    expect(toolResults[0]).toEqual({ type: 'tool_result', tool_use_id: 'guide_1', content: 'STOCK DIVE GUIDE\n\nGEMINI SUPPLEMENT' });
    expect(toolResults[1]).toMatchObject({ tool_use_id: 'query_1', content: 'Error: 401 Unauthorized', is_error: true });
    expect(toolResults[2]).toMatchObject({
      tool_use_id: 'tables_1',
      content: 'Error: MotherDuck auth expired before this tool ran.',
      is_error: true,
    });

    // The round's tools — including the intercepted guide — are recorded.
    expect(result.turnToolNames).toEqual(new Set(['get_dive_guide', 'query', 'list_tables']));
  });
});
