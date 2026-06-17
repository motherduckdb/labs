import { describe, it, expect } from 'vitest';
import { runEvalTask, type EvalTaskCtx, type Question } from './cli.js';
import * as cl from './controllog.js';
import type { ScoreResult } from './score-client.js';
import type { TaskResult } from './agentic-loop.js';

// Per-task containment: one task throws during MCP setup, one during scoring,
// one succeeds; all three produce exactly one outcome (one row) and a terminal
// controllog state (DONE or FAILED). No throw escapes runEvalTask.

const okScore: ScoreResult = {
  is_correct: true, correctness: 'correct', score: 1, match_source: 'exact',
  reason: null, predicted_answer: '42', gold_answer: '42',
};

function fakeClient() {
  return { close: async () => {} } as unknown as Awaited<ReturnType<typeof import('./mcp-client.js').createMCPClient>>;
}

function fakeTaskResult(over: Partial<TaskResult> = {}): TaskResult {
  return {
    submitted: true, escalated: false, escalationReason: null, authorTurns: 1, fixerTurns: 0,
    toolCallCount: 1, usage: { promptTokens: 1, completionTokens: 1, cost: 0, cachedTokens: 0, cacheWriteTokens: 0 },
    authorModel: 'a', fixerModel: 'f', hitLimit: false, streamFailureReason: null,
    authorRecoveryUsed: false, retryCount: 0, ...over,
  };
}

function baseCtx(over: Partial<EvalTaskCtx>): EvalTaskCtx {
  return {
    systemPrompt: 'sys',
    runtime: {} as EvalTaskCtx['runtime'],
    store: {} as EvalTaskCtx['store'],
    symbols: new Set<string>(),
    scorer: { score: async () => okScore },
    database: 'db', author: 'a', fixer: 'f',
    escalateAfter: 2, maxAuthorTurns: 20, maxFixerTurns: 6, reasoning: 'off',
    runClass: 'smoke',
    prov: { malloy_provenance: 'model_authored', malloy_model_hash: 'h', manual_included: true, authoring_model: 'a', reason: 'r' },
    runId: 'r1', split: 'test',
    discoverTools: async () => [],
    ...over,
  };
}

const Q = (id: string): Question => ({ task_id: id, question: 'q', answer: '42' });

describe('runEvalTask containment', () => {
  it('runs three tasks (mcp-setup throw, scoring throw, success) — each yields one outcome + terminal state', async () => {
    const session = cl.createSession();
    cl.init({ project: 'test', logDir: '/tmp/asm-eval-test', agentId: 'agent:test' });

    const outcomes = await cl.runInSession(session, async () => {
      // Task A: MCP setup throws.
      const ctxA = baseCtx({
        createClient: async () => { throw new Error('connect refused'); },
        runTaskFn: async () => fakeTaskResult(),
      });
      // Task B: scoring throws.
      const ctxB = baseCtx({
        createClient: async () => fakeClient(),
        runTaskFn: async (opts) => { (opts.deps.state as { submitted: boolean; finalRows?: unknown[][] }).submitted = true; (opts.deps.state as { finalRows?: unknown[][] }).finalRows = [[42]]; return fakeTaskResult(); },
        scorer: { score: async () => { throw new Error('scorer died'); } },
      });
      // Task C: success.
      const ctxC = baseCtx({
        createClient: async () => fakeClient(),
        runTaskFn: async (opts) => { (opts.deps.state as { submitted: boolean; finalRows?: unknown[][] }).submitted = true; (opts.deps.state as { finalRows?: unknown[][] }).finalRows = [[42]]; return fakeTaskResult(); },
      });

      return [
        await runEvalTask(Q('A'), ctxA),
        await runEvalTask(Q('B'), ctxB),
        await runEvalTask(Q('C'), ctxC),
      ];
    });

    // Exactly three outcomes, one per task id.
    expect(outcomes.map((o) => o.taskId)).toEqual(['A', 'B', 'C']);

    // Task A: mcp_setup failure, FAILED.
    expect(outcomes[0].failureStage).toBe('mcp_setup');
    expect(outcomes[0].failureKind).toBe('mcp_connect_failed');
    expect(outcomes[0].terminalState).toBe('FAILED');

    // Task B: scoring failure, FAILED, score_error captured in the row.
    expect(outcomes[1].failureStage).toBe('scoring');
    expect(outcomes[1].failureKind).toBe('score_error');
    expect(outcomes[1].terminalState).toBe('FAILED');
    expect(outcomes[1].row.score_error).toMatch(/scorer died/);

    // Task C: success, DONE.
    expect(outcomes[2].failureStage).toBeNull();
    expect(outcomes[2].terminalState).toBe('DONE');
    expect(outcomes[2].isCorrect).toBe(true);

    // Every task reached exactly one terminal state_move (WIP -> DONE|FAILED),
    // and emitted exactly one evaluation_result + one task_complete.
    for (const id of ['A', 'B', 'C']) {
      const evalEvents = session.events.filter((e) => e.kind === 'evaluation_result' && e.actor_task_id === id);
      const completeEvents = session.events.filter((e) => e.kind === 'task_complete' && e.actor_task_id === id);
      expect(evalEvents).toHaveLength(1);
      expect(completeEvents).toHaveLength(1);
    }

    // The new failure fields are present in every JSONL row.
    for (const o of outcomes) {
      for (const f of ['failure_stage', 'failure_kind', 'submitted', 'hit_limit', 'retry_count', 'mcp_retry_count', 'score_error', 'escalation_reason']) {
        expect(o.row).toHaveProperty(f);
      }
    }
  });

  it('a stream failure in the loop surfaces as an agent_loop failure with the reason', async () => {
    const session = cl.createSession();
    const outcome = await cl.runInSession(session, async () =>
      runEvalTask(Q('S'), baseCtx({
        createClient: async () => fakeClient(),
        runTaskFn: async () => fakeTaskResult({ submitted: false, hitLimit: true, streamFailureReason: 'stream exploded' }),
        scorer: { score: async () => ({ ...okScore, is_correct: false, correctness: 'error', predicted_answer: null }) },
      })),
    );
    expect(outcome.failureStage).toBe('agent_loop');
    expect(outcome.failureKind).toBe('stream_failure');
    expect(outcome.row.error).toMatch(/stream exploded/);
  });
});
