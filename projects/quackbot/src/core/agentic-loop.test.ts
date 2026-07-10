import { describe, expect, it, vi } from 'vitest';

// Controllog is a no-op spy set — the loop must survive without a session and
// we don't want JSONL side effects from tests.
vi.mock('./controllog', () => ({
  newId: vi.fn(() => 'test-exchange-id'),
  modelPrompt: vi.fn(),
  modelCompletion: vi.fn(),
  toolEnd: vi.fn(),
  streamError: vi.fn(),
}));

// The real guide is ~40K tokens of static text; a marker string keeps
// assertions cheap and proves the loop used THIS builder, not MCP.
vi.mock('./gemini-dive-guide', () => ({
  buildGeminiDiveGuide: vi.fn(() => 'GEMINI-TUNED DIVE GUIDE'),
}));

import { runAgenticLoop, type RunAgenticLoopOpts } from './agentic-loop';
import { buildGeminiDiveGuide } from './gemini-dive-guide';
import type { MvizBlockEvent, ToolEndCall, ToolStartCall, TurnSink } from './turn-sink';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

// ---------------------------------------------------------------------------
// Synthetic OpenRouter SSE streams (same shape as demo-validation.test.ts).
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

function textStream(text: string, opts?: { chunkSize?: number; reasoning?: string }): ReadableStream<Uint8Array> {
  const payloads: Array<Record<string, unknown>> = [];
  if (opts?.reasoning) {
    for (const chunk of splitEvery(opts.reasoning, 16)) {
      payloads.push({ choices: [{ delta: { reasoning: chunk } }] });
    }
  }
  for (const chunk of splitEvery(text, opts?.chunkSize ?? 16)) {
    payloads.push({ choices: [{ delta: { content: chunk } }] });
  }
  payloads.push({
    choices: [{ delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 120, completion_tokens: 30, cost: 0.001 },
  });
  return sseStream(payloads);
}

function toolCallStream(calls: Array<{ id: string; name: string; args: Record<string, unknown> }>): ReadableStream<Uint8Array> {
  return sseStream([
    {
      choices: [{
        delta: {
          tool_calls: calls.map((call, index) => ({
            index,
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: JSON.stringify(call.args) },
          })),
        },
      }],
    },
    {
      choices: [{ delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 100, completion_tokens: 10, cost: 0.0005 },
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
  });
  return { result, events, streamChatCompletion };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runAgenticLoop with TurnSink', () => {
  it('streams text deltas as onText in order and finishes done', async () => {
    const answer = 'Hello! This is a plain streamed answer with no fences in it at all.';
    const { result, events } = await runLoop({ streams: [() => textStream(answer)] });

    expect(joinedText(events)).toBe(answer);
    expect(events.filter((e) => e.type === 'error')).toHaveLength(0);

    const usageEvents = events.filter((e) => e.type === 'usage');
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0].usage).toMatchObject({
      promptTokens: 120, completionTokens: 30, cost: 0.001,
      model: 'test-model', contextWindow: 200_000,
    });

    // turn_complete is the terminal event of the turn.
    expect(events[events.length - 1]).toEqual({ type: 'turn_complete', finishReason: 'done' });

    expect(result.finishReason).toBe('done');
    expect(result.newTurnMessages).toEqual([
      { role: 'assistant', content: [{ type: 'text', text: answer }] },
    ]);
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

  it('does NOT intercept context tools — query_context_layer flows through dispatchTool', async () => {
    const dispatchToolImpl = vi.fn(async (_opts: { client: Client; name: string; args: Record<string, unknown> }) => ({
      content: JSON.stringify({ fragments: [] }),
      isError: false,
    }));
    const { result, events } = await runLoop({
      streams: [
        () => toolCallStream([{ id: 'ctx_1', name: 'query_context_layer', args: { query: 'join keys' } }]),
        () => textStream('No saved context yet.'),
      ],
      dispatchToolImpl,
    });

    // Dispatched like any other tool: real dispatch path, tool_start/tool_end events.
    expect(dispatchToolImpl).toHaveBeenCalledTimes(1);
    expect(dispatchToolImpl.mock.calls[0][0]).toMatchObject({
      name: 'query_context_layer',
      args: { query: 'join keys' },
    });
    expect(events.some((e) => e.type === 'tool_start' && e.call.name === 'query_context_layer')).toBe(true);
    expect(events.some((e) => e.type === 'tool_end' && e.call.name === 'query_context_layer')).toBe(true);

    // No pause: the loop continued to a second LLM call and finished normally.
    expect(result.finishReason).toBe('done');
    expect(result.turnToolNames).toEqual(new Set(['query_context_layer']));
    const toolResult = (result.newTurnMessages[1].content as Array<Record<string, unknown>>)[0];
    expect(toolResult).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'ctx_1',
      content: JSON.stringify({ fragments: [] }),
    });
  });

  it('intercepts get_dive_guide on Gemini profiles with the local guide, never dispatching to MCP', async () => {
    vi.mocked(buildGeminiDiveGuide).mockClear();
    const dispatchToolImpl = vi.fn(async (_opts: { client: Client; name: string; args: Record<string, unknown> }) => ({
      content: 'mcp guide (should not be used)',
      isError: false,
    }));
    const { result, events } = await runLoop({
      streams: [
        () => toolCallStream([{ id: 'guide_1', name: 'get_dive_guide', args: {} }]),
        () => textStream('Guide read, building the dive.'),
      ],
      dispatchToolImpl,
      profileId: 'google/gemini-3-flash-preview',
    });

    expect(buildGeminiDiveGuide).toHaveBeenCalledTimes(1);
    expect(dispatchToolImpl).not.toHaveBeenCalled();

    // Same tool_start/tool_end event pair as a dispatched tool.
    const startIndex = events.findIndex((e) => e.type === 'tool_start');
    const endIndex = events.findIndex((e) => e.type === 'tool_end');
    expect(startIndex).toBeGreaterThanOrEqual(0);
    expect(endIndex).toBeGreaterThan(startIndex);
    expect(events[endIndex]).toMatchObject({
      call: { id: 'guide_1', name: 'get_dive_guide', result: 'GEMINI-TUNED DIVE GUIDE' },
    });

    // The synthesized tool_result feeds the next LLM call like a real dispatch.
    expect(result.finishReason).toBe('done');
    expect(result.turnToolNames).toEqual(new Set(['get_dive_guide']));
    const toolResult = (result.newTurnMessages[1].content as Array<Record<string, unknown>>)[0];
    expect(toolResult).toEqual({
      type: 'tool_result',
      tool_use_id: 'guide_1',
      content: 'GEMINI-TUNED DIVE GUIDE',
    });
  });

  it('passes get_dive_guide through to dispatchTool on non-Gemini profiles', async () => {
    vi.mocked(buildGeminiDiveGuide).mockClear();
    const dispatchToolImpl = vi.fn(async (_opts: { client: Client; name: string; args: Record<string, unknown> }) => ({
      content: 'mcp claude guide content',
      isError: false,
    }));
    const { result } = await runLoop({
      streams: [
        () => toolCallStream([{ id: 'guide_2', name: 'get_dive_guide', args: {} }]),
        () => textStream('Guide read.'),
      ],
      dispatchToolImpl,
      profileId: 'anthropic/claude-sonnet-5',
    });

    expect(buildGeminiDiveGuide).not.toHaveBeenCalled();
    expect(dispatchToolImpl).toHaveBeenCalledTimes(1);
    expect(dispatchToolImpl.mock.calls[0][0]).toMatchObject({ name: 'get_dive_guide' });
    const toolResult = (result.newTurnMessages[1].content as Array<Record<string, unknown>>)[0];
    expect(toolResult).toMatchObject({ content: 'mcp claude guide content' });
  });

  it('leaves no unpaired tool_use when auth expires mid-way through a multi-tool round', async () => {
    vi.mocked(buildGeminiDiveGuide).mockClear();
    // Round of three: get_dive_guide is Gemini-intercepted and succeeds,
    // query throws an auth error, list_tables never runs.
    const dispatchToolImpl = vi.fn(async (opts: { client: Client; name: string; args: Record<string, unknown> }) => {
      if (opts.name === 'query') throw new Error('401 Unauthorized');
      return { content: 'ok', isError: false };
    });
    const { result, events } = await runLoop({
      streams: [
        () => toolCallStream([
          { id: 'guide_1', name: 'get_dive_guide', args: {} },
          { id: 'query_1', name: 'query', args: { sql: 'select 1' } },
          { id: 'tables_1', name: 'list_tables', args: {} },
        ]),
      ],
      dispatchToolImpl,
      profileId: 'google/gemini-3-flash-preview',
    });

    expect(result.finishReason).toBe('auth_expired');
    expect(events.some((e) => e.type === 'auth_expired')).toBe(true);
    // The loop broke at the auth failure — list_tables was never dispatched.
    expect(dispatchToolImpl).toHaveBeenCalledTimes(1);

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
    expect(toolResults[0]).toEqual({ type: 'tool_result', tool_use_id: 'guide_1', content: 'GEMINI-TUNED DIVE GUIDE' });
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
