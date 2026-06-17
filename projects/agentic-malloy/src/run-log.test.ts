/**
 * run-log unit tests — the controllog reader that supplies layer-improve's
 * deeper triage: correlating a results JSONL to its controllog run, the per-task
 * tool TRACE (manner-of-failure evidence), per-tool error rates (the >15%
 * meta-analysis trigger), and answer-shape (over/under-specification, gold-free).
 * Pure functions over synthetic events — no controllog on disk needed.
 */
import { describe, it, expect } from 'vitest';
import { correlateRun, taskTrace, toolErrorStats, answerShape, parseEvents, type ControllogEvent } from './run-log.js';

function evalEvent(runId: string, taskId: string, malloy: string | null, predicted: string): ControllogEvent {
  return { kind: 'evaluation_result', run_id: runId, actor_task_id: taskId, payload_json: { question_id: taskId, malloy_source: malloy, predicted_result: predicted } };
}
function toolCall(runId: string, taskId: string, callId: string, name: string, args: unknown): ControllogEvent {
  return { kind: 'tool_call', run_id: runId, actor_task_id: taskId, payload_json: { call_id: callId, name, arguments: args } };
}
function toolResult(runId: string, taskId: string, callId: string, name: string, status: 'ok' | 'error', output?: string): ControllogEvent {
  return { kind: 'tool_result', run_id: runId, actor_task_id: taskId, payload_json: { call_id: callId, name, status, output } };
}

describe('correlateRun', () => {
  it('picks the run whose evaluation_result events best match the JSONL rows', () => {
    const rows = [
      { task_id: '1', malloy_source: 'run: a -> b', predicted_answer: 'x' },
      { task_id: '2', malloy_source: 'run: c -> d', predicted_answer: 'y' },
      { task_id: '3', malloy_source: null, predicted_answer: 'z' }, // non-submission → matched by predicted
    ];
    const events: ControllogEvent[] = [
      evalEvent('R1', '1', 'run: a -> b', 'x'),
      evalEvent('R1', '2', 'run: c -> d', 'y'),
      evalEvent('R1', '3', null, 'z'),
      evalEvent('R2', '1', 'run: a -> b', 'x'), // R2 only matches one row
    ];
    const c = correlateRun(events, rows);
    expect(c.runId).toBe('R1');
    expect(c.matched).toBe(3);
    expect(c.total).toBe(3);
  });

  it('returns null when nothing matches', () => {
    const c = correlateRun([evalEvent('R1', '9', 'run: z', 'q')], [{ task_id: '1', malloy_source: 'run: a', predicted_answer: 'x' }]);
    expect(c.runId).toBeNull();
    expect(c.matched).toBe(0);
  });
});

describe('toolErrorStats (>15% trigger)', () => {
  const events: ControllogEvent[] = [
    // run_malloy: 10 calls, 2 errors = 20% → flagged (rate>15% AND calls>=5)
    ...Array.from({ length: 8 }, (_, i) => toolResult('R1', 't', `m${i}`, 'run_malloy', 'ok')),
    toolResult('R1', 't', 'm8', 'run_malloy', 'error', 'Use of select is not allowed in a grouping query'),
    toolResult('R1', 't', 'm9', 'run_malloy', 'error', 'Use of select is not allowed in a grouping query'),
    // query: 4 calls, 2 errors = 50% but <5 calls → NOT flagged
    toolResult('R1', 't', 'q0', 'query', 'ok'),
    toolResult('R1', 't', 'q1', 'query', 'ok'),
    toolResult('R1', 't', 'q2', 'query', 'error', 'binder error'),
    toolResult('R1', 't', 'q3', 'query', 'error', 'binder error'),
    // list_malloy_files: 6 clean calls
    ...Array.from({ length: 6 }, (_, i) => toolResult('R1', 't', `l${i}`, 'list_malloy_files', 'ok')),
    // a different run's errors must not bleed in
    toolResult('R2', 't', 'x0', 'run_malloy', 'error', 'other run'),
  ];

  it('flags only tools over the threshold with enough calls', () => {
    const stats = toolErrorStats(events, 'R1', { threshold: 0.15, minCalls: 5 });
    const rm = stats.find((s) => s.tool === 'run_malloy')!;
    const q = stats.find((s) => s.tool === 'query')!;
    const l = stats.find((s) => s.tool === 'list_malloy_files')!;
    expect(rm.calls).toBe(10);
    expect(rm.errors).toBe(2);
    expect(rm.rate).toBeCloseTo(0.2);
    expect(rm.flagged).toBe(true);
    expect(rm.samples).toContain('Use of select is not allowed in a grouping query'); // deduped
    expect(rm.samples.length).toBe(1);
    expect(q.flagged).toBe(false); // 50% but only 4 calls
    expect(l.flagged).toBe(false);
  });
});

describe('taskTrace', () => {
  it('joins tool_call args to tool_result status and derives signals', () => {
    const events: ControllogEvent[] = [
      toolCall('R1', '5', 'c0', 'list_malloy_files', {}),
      toolResult('R1', '5', 'c0', 'list_malloy_files', 'ok'),
      toolCall('R1', '5', 'c1', 'get_file', { files: ['dabstep.malloy'] }),
      toolResult('R1', '5', 'c1', 'get_file', 'ok'),
      toolCall('R1', '5', 'c2', 'run_malloy', { source: 'run: x' }),
      toolResult('R1', '5', 'c2', 'run_malloy', 'error', 'compile error'),
      toolCall('R1', '5', 'c3', 'submit_answer', { source: 'run: y' }),
      toolResult('R1', '5', 'c3', 'submit_answer', 'ok'),
      toolResult('R1', '6', 'z', 'run_malloy', 'error'), // a different task
    ];
    const t = taskTrace(events, 'R1', '5');
    expect(t.toolCalls).toBe(4);
    expect(t.exploredLayer).toBe(true);
    expect(t.runMalloyErrors).toBe(1);
    expect(t.submitErrors).toBe(0);
    expect(t.steps[1]).toMatchObject({ name: 'get_file', ok: true, args: { files: ['dabstep.malloy'] } });
    expect(t.steps[2]).toMatchObject({ name: 'run_malloy', ok: false, output: 'compile error' });
  });
});

describe('answerShape (gold-free over/under-specification signal)', () => {
  it('classifies scalars, lists, bracketed lists, and empties', () => {
    expect(answerShape('5.715872')).toEqual({ kind: 'scalar', count: 1 });
    expect(answerShape('a, b, c')).toEqual({ kind: 'list', count: 3 });
    expect(answerShape('[B]')).toEqual({ kind: 'bracketed-list', count: 1 });
    expect(answerShape('[a, b]')).toEqual({ kind: 'bracketed-list', count: 2 });
    expect(answerShape('')).toEqual({ kind: 'none', count: 0 });
    expect(answerShape(null)).toEqual({ kind: 'none', count: 0 });
  });
});

describe('parseEvents', () => {
  it('skips malformed lines', () => {
    expect(parseEvents('{"kind":"a"}\nnot json\n{"kind":"b"}\n')).toHaveLength(2);
  });
});
