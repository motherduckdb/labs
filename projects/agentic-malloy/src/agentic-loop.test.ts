import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the LLM transport and the tool dispatcher so the loop runs offline. The
// stream is a scripted sequence of "turns"; each turn is either terminal text
// (no tool calls) or a single tool call. dispatchTool is driven by a script too.
const streamMock = vi.fn();
const dispatchMock = vi.fn();

vi.mock('./llm-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./llm-client.js')>();
  return { ...actual, streamChatCompletion: (...a: unknown[]) => streamMock(...a) };
});
vi.mock('./tools.js', () => ({ dispatchTool: (...a: unknown[]) => dispatchMock(...a) }));

// Silence controllog (no session bound in this test).
vi.mock('./controllog.js', () => ({
  newId: () => 'id',
  modelPrompt: () => {}, modelCompletion: () => {}, toolCall: () => {}, toolResult: () => {},
}));

import { runTask, type RunTaskOpts } from './agentic-loop.js';

/** Build an SSE ReadableStream for one turn: optional text + optional tool call. */
function sseTurn(opts: { text?: string; tool?: { name: string; input?: unknown } }): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const chunks: string[] = [];
  if (opts.text) chunks.push(`data: ${JSON.stringify({ choices: [{ delta: { content: opts.text } }] })}\n`);
  if (opts.tool) {
    chunks.push(
      `data: ${JSON.stringify({
        choices: [{ delta: { tool_calls: [{ index: 0, id: 'tc1', function: { name: opts.tool.name, arguments: JSON.stringify(opts.tool.input ?? {}) } }] } }] },
      )}\n`,
    );
  }
  chunks.push(`data: ${JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 } })}\n`);
  chunks.push('data: [DONE]\n');
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

function baseOpts(state: { submitted: boolean }): RunTaskOpts {
  return {
    question: 'q', guidelines: null, systemPrompt: 'sys', toolSchemas: [],
    // deps only needs .state for the loop's escalation/submit checks; dispatchTool is mocked.
    deps: { state } as unknown as RunTaskOpts['deps'],
    authorModel: 'author-model', fixerModel: 'fixer-model',
    escalateAfter: 2, maxAuthorTurns: 20, maxFixerTurns: 6,
    reasoningEffort: 'off', taskId: 't1', runId: 'r1',
  };
}

beforeEach(() => {
  streamMock.mockReset();
  dispatchMock.mockReset();
});

describe('runTask no-submit recovery', () => {
  it('gives the author ONE forced submit-now recovery turn BEFORE escalating to the fixer', async () => {
    const state = { submitted: false };
    // Turn 1: author terminal text (no submit) -> should trigger author recovery, NOT fixer.
    // Turn 2: author still terminal text -> NOW escalate to fixer.
    // Turn 3: fixer terminal text -> loop ends.
    streamMock
      .mockResolvedValueOnce(sseTurn({ text: 'here is my analysis' }))
      .mockResolvedValueOnce(sseTurn({ text: 'still just prose' }))
      .mockResolvedValueOnce(sseTurn({ text: 'fixer gives up too' }));

    const r = await runTask(baseOpts(state));

    expect(r.authorRecoveryUsed).toBe(true);
    expect(r.escalated).toBe(true);
    expect(r.escalationReason).toMatch(/after recovery/);
    // Recovery happens on turn 2's model (still author), escalation on turn 3 (fixer).
    expect(streamMock.mock.calls[1][0].model).toBe('author-model'); // recovery turn re-runs the AUTHOR
    expect(streamMock.mock.calls[2][0].model).toBe('fixer-model'); // only then the fixer
  });

  it('recovery turn that submits ends the task WITHOUT escalating to the fixer', async () => {
    const state = { submitted: false };
    // Turn 1: terminal text -> author recovery.
    // Turn 2 (recovery): author calls submit_answer; dispatch marks submitted.
    streamMock
      .mockResolvedValueOnce(sseTurn({ text: 'oops forgot to submit' }))
      .mockResolvedValueOnce(sseTurn({ tool: { name: 'submit_answer', input: { source: 'x' } } }));
    dispatchMock.mockImplementation(async () => {
      state.submitted = true;
      return { content: 'Submitted. 1 row(s).', isError: false };
    });

    const r = await runTask(baseOpts(state));
    expect(r.authorRecoveryUsed).toBe(true);
    expect(r.submitted).toBe(true);
    expect(r.escalated).toBe(false); // never reached the fixer
  });

  it('repeated run_malloy errors still escalate to the fixer (not the recovery path)', async () => {
    const state = { submitted: false };
    // escalateAfter=2: two consecutive run_malloy errors -> escalate.
    streamMock
      .mockResolvedValueOnce(sseTurn({ tool: { name: 'run_malloy', input: { source: 'bad1' } } }))
      .mockResolvedValueOnce(sseTurn({ tool: { name: 'run_malloy', input: { source: 'bad2' } } }))
      .mockResolvedValueOnce(sseTurn({ text: 'fixer also stuck' }));
    dispatchMock.mockResolvedValue({ content: 'Malloy compile error', isError: true });

    const r = await runTask(baseOpts(state));
    expect(r.escalated).toBe(true);
    expect(r.escalationReason).toMatch(/consecutive tool errors/);
    expect(r.authorRecoveryUsed).toBe(false); // tool-error escalation, not the prose-recovery path
  });

  it('steerInsteadOfEscalate: consecutive errors steer the AUTHOR in place — no model switch', async () => {
    const state = { submitted: false };
    const events: { kind: string }[] = [];
    // Two consecutive run_malloy errors (would escalate by default); then a submit.
    streamMock
      .mockResolvedValueOnce(sseTurn({ tool: { name: 'run_malloy', input: { source: 'bad1' } } }))
      .mockResolvedValueOnce(sseTurn({ tool: { name: 'run_malloy', input: { source: 'bad2' } } }))
      .mockResolvedValueOnce(sseTurn({ tool: { name: 'submit_answer', input: { source: 'good' } } }));
    dispatchMock.mockImplementation(async (_deps: unknown, name: string) => {
      if (name === 'submit_answer') { state.submitted = true; return { content: 'Submitted. 1 row(s).', isError: false }; }
      return { content: "Malloy compile error:\n  - 'transaction_date' is not defined", isError: true };
    });

    const r = await runTask({
      ...baseOpts(state),
      steerInsteadOfEscalate: true,
      onEvent: (e) => events.push(e),
    });

    expect(r.escalated).toBe(false); // never failed over to the fixer model
    expect(r.submitted).toBe(true);
    expect(events.some((e) => e.kind === 'stuck_author_steer')).toBe(true);
    // EVERY turn ran on the author model — the fixer model was never used.
    for (const call of streamMock.mock.calls) expect(call[0].model).toBe('author-model');
  });

  it('a stream failure ends the loop with a streamFailureReason (not a silent hit-limit)', async () => {
    const state = { submitted: false };
    streamMock.mockRejectedValueOnce(new Error('stream setup exploded'));
    const r = await runTask(baseOpts(state));
    expect(r.streamFailureReason).toMatch(/stream setup exploded/);
    expect(r.submitted).toBe(false);
    expect(r.hitLimit).toBe(true);
  });
});
