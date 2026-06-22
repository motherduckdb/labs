import { describe, it, expect } from 'vitest';
import * as cl from './controllog.js';

// Confirms the spec's single-source-of-truth ownership: each quantity is posted
// by exactly one event kind, and task_complete carries no postings.
describe('controllog no-double-counting', () => {
  it('assigns each quantity to a single event kind', async () => {
    cl.init({ project: 'test', logDir: '/tmp/asm-test', agentId: 'agent:test' });
    const session = cl.createSession();
    await cl.runInSession(session, async () => {
      const ex = cl.newId();
      cl.modelPrompt({ taskId: 't1', runId: 'r', provider: 'openrouter', model: 'm', promptTokens: 100, exchangeId: ex, role: 'author' });
      cl.modelCompletion({ taskId: 't1', runId: 'r', provider: 'openrouter', model: 'm', completionTokens: 50, wallMs: 1200, exchangeId: ex, costMoney: 0.01, role: 'author' });
      cl.toolCall({ taskId: 't1', runId: 'r', name: 'query', callId: 'c1', model: 'm' });
      cl.toolResult({ taskId: 't1', runId: 'r', name: 'query', callId: 'c1', ok: true, durationMs: 300, model: 'm' });
      cl.stateMove({ taskId: 't1', from: 'NEW', to: 'WIP', runId: 'r' });
      cl.utility({ taskId: 't1', metric: 'reward', value: 1, runId: 'r' });
      cl.event({ kind: 'task_complete', taskId: 't1', runId: 'r', payload: { correctness: 'correct' } });
    });

    const kindOf = new Map(session.events.map((e) => [e.event_id, e.kind]));
    const kindsFor = (acc: string, dimPred?: (d: Record<string, unknown>) => boolean): Set<string> =>
      new Set(
        session.postings
          .filter((p) => p.account_type === acc && (!dimPred || dimPred(p.dims_json)))
          .map((p) => kindOf.get(p.event_id)!),
      );

    // tokens, cost, model-wall: only on model events.
    expect(kindsFor('resource.tokens')).toEqual(new Set(['model_prompt', 'model_completion']));
    expect(kindsFor('truth.money')).toEqual(new Set(['model_completion']));
    expect(kindsFor('truth.time', (d) => d.kind === 'wall')).toEqual(new Set(['model_completion']));
    // tool latency: only on tool_result.
    expect(kindsFor('truth.time', (d) => d.kind === 'tool')).toEqual(new Set(['tool_result']));
    // state / utility: only on their own events.
    expect(kindsFor('truth.state')).toEqual(new Set(['state_move']));
    expect(kindsFor('truth.utility')).toEqual(new Set(['utility']));

    // task_complete carries NO postings.
    const taskCompleteId = session.events.find((e) => e.kind === 'task_complete')!.event_id;
    expect(session.postings.filter((p) => p.event_id === taskCompleteId)).toHaveLength(0);
  });
});
