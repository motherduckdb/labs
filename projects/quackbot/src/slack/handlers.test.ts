import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildTurnRunner, type TurnRunnerDeps } from './handlers';
import type { TurnSink } from '../core/turn-sink';

/**
 * A controllable deferred so tests can hold a turn "in flight" and assert the
 * per-thread mutex behavior.
 */
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function makeDeps(overrides: Partial<TurnRunnerDeps> = {}): {
  deps: TurnRunnerDeps;
  calls: {
    posts: Array<{ channel: string; thread_ts?: string; text?: string }>;
    reactions: Array<{ name: string; ts: string }>;
    setChannelDatabases: Array<{ channel: string; dbs: string[] }>;
    saved: Array<{ channel: string; threadTs: string }>;
    getConvKeys: string[];
    loopStarts: number;
  };
} {
  const calls = {
    posts: [] as Array<{ channel: string; thread_ts?: string; text?: string }>,
    reactions: [] as Array<{ name: string; ts: string }>,
    setChannelDatabases: [] as Array<{ channel: string; dbs: string[] }>,
    saved: [] as Array<{ channel: string; threadTs: string }>,
    getConvKeys: [] as string[],
    loopStarts: 0,
  };

  let postSeq = 0;
  const client = {
    chat: {
      postMessage: vi.fn(async (a: { channel: string; thread_ts?: string; text?: string }) => {
        calls.posts.push(a);
        postSeq += 1;
        return { ts: `posted-${postSeq}` };
      }),
    },
    reactions: {
      add: vi.fn(async (a: { name: string; timestamp: string }) => {
        calls.reactions.push({ name: a.name, ts: a.timestamp });
        return {};
      }),
      remove: vi.fn(async () => ({})),
    },
    users: { info: vi.fn(async () => ({ user: { real_name: 'Ada' } })) },
    auth: { test: vi.fn(async () => ({ user_id: 'BOT' })) },
  };

  const sink: TurnSink & { finalize: () => Promise<void> } = {
    onText: vi.fn(),
    onThinking: vi.fn(),
    onThinkingDone: vi.fn(),
    onToolStart: vi.fn(),
    onToolEnd: vi.fn(),
    onMvizPending: vi.fn(),
    onMvizBlock: vi.fn(),
    onUsage: vi.fn(),
    onError: vi.fn(),
    onAuthExpired: vi.fn(),
    onTurnComplete: vi.fn(),
    finalize: vi.fn(async () => {}),
  };

  const deps: TurnRunnerDeps = {
    client: client as never,
    createMCPClient: vi.fn(async () => ({ close: vi.fn(async () => {}) }) as never),
    getFilteredTools: vi.fn(async () => []) as never,
    mcpToolsToAnthropicFormat: vi.fn(() => []) as never,
    buildSystemPrompt: vi.fn(() => 'system') as never,
    getModelProfile: vi.fn(() => ({
      id: 'm',
      maxTokens: 1000,
      supportsReasoning: false,
      contextWindow: 100000,
    })) as never,
    runAgenticLoop: vi.fn(async () => {
      calls.loopStarts += 1;
      return {
        finishReason: 'done' as const,
        finalMessages: [{ role: 'user', content: 'q' }],
        newTurnMessages: [],
        turnToolNames: new Set<string>(),
      };
    }) as never,
    getConversation: vi.fn(async (_channel: string, threadTs: string) => {
      calls.getConvKeys.push(threadTs);
      return null;
    }) as never,
    saveConversation: vi.fn(async (channel: string, threadTs: string) => {
      calls.saved.push({ channel, threadTs });
    }) as never,
    resolveDatabases: vi.fn(async () => ['db1']) as never,
    setChannelDatabases: vi.fn(async (channel: string, dbs: string[]) => {
      calls.setChannelDatabases.push({ channel, dbs });
    }) as never,
    controllog: {
      createSession: vi.fn(() => ({ id: 's', events: [], postings: [] })) as never,
      runInSession: vi.fn((_s: unknown, fn: () => Promise<void>) => fn()) as never,
      flushSession: vi.fn(async () => {}) as never,
    },
    createSink: vi.fn(() => sink) as never,
    botUserId: 'BOT',
    thinkingLevel: 'medium',
    ...overrides,
  };

  return { deps, calls };
}

describe('buildTurnRunner command intercept', () => {
  it('sets channel databases and skips the LLM turn for `use db`', async () => {
    const { deps, calls } = makeDeps();
    const runner = buildTurnRunner(deps);
    await runner.handle({
      channel: 'C1',
      user: 'U1',
      text: '<@BOT> use db sales, marketing prod',
      ts: '1.1',
    });

    expect(calls.setChannelDatabases).toEqual([{ channel: 'C1', dbs: ['sales', 'marketing', 'prod'] }]);
    expect(calls.loopStarts).toBe(0); // no agentic turn ran
    expect(calls.posts.some((p) => p.text?.includes('Databases for this channel'))).toBe(true);
  });

  it('ignores trailing client junk after the database names (observed live: MCP attribution suffix)', async () => {
    const { deps, calls } = makeDeps();
    const runner = buildTurnRunner(deps);
    await runner.handle({
      channel: 'D1',
      user: 'U1',
      text: 'use database sample_data *Sent using* <@U09JNJ9UA5A>',
      ts: '1.2',
    });
    expect(calls.setChannelDatabases).toEqual([{ channel: 'D1', dbs: ['sample_data'] }]);

    await runner.handle({
      channel: 'D1',
      user: 'U1',
      text: 'use db my_db\nsome unrelated second line',
      ts: '1.3',
    });
    expect(calls.setChannelDatabases[1]).toEqual({ channel: 'D1', dbs: ['my_db'] });
  });
});

describe('buildTurnRunner dedupe', () => {
  it('ignores a redelivered event with the same (channel, ts)', async () => {
    const { deps, calls } = makeDeps();
    const runner = buildTurnRunner(deps);
    const msg = { channel: 'C1', user: 'U1', text: '<@BOT> hello', ts: '2.2' };
    await runner.handle(msg);
    await runner.handle(msg); // duplicate delivery
    expect(calls.loopStarts).toBe(1);
  });
});

describe('buildTurnRunner per-thread mutex', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects a second turn in the same thread while one is in flight', async () => {
    const gate = deferred();
    const { deps, calls } = makeDeps({
      runAgenticLoop: vi.fn(async () => {
        calls.loopStarts += 1;
        await gate.promise; // hold the first turn open
        return {
          finishReason: 'done' as const,
          finalMessages: [],
          newTurnMessages: [],
          turnToolNames: new Set<string>(),
        };
      }) as never,
    });
    const runner = buildTurnRunner(deps);

    const first = runner.handle({ channel: 'C1', user: 'U1', text: '<@BOT> one', ts: '3.1', threadTs: 'TT' });
    // Let the first turn get past the mutex acquire + placeholder post.
    await new Promise((r) => setTimeout(r, 0));

    await runner.handle({ channel: 'C1', user: 'U2', text: '<@BOT> two', ts: '3.2', threadTs: 'TT' });

    // The second turn is bounced: an hourglass reaction + "still working" note.
    expect(calls.reactions.some((r) => r.name === 'hourglass_flowing_sand')).toBe(true);
    expect(calls.posts.some((p) => p.text?.includes('still working'))).toBe(true);
    expect(calls.loopStarts).toBe(1);

    gate.resolve();
    await first;
    expect(calls.loopStarts).toBe(1);
  });
});

describe('buildTurnRunner reply threading', () => {
  it('posts to the DM main timeline (no thread_ts) for a fresh DM', async () => {
    const { deps, calls } = makeDeps();
    const runner = buildTurnRunner(deps);
    await runner.handle({ channel: 'D9', user: 'U1', text: 'hi there', ts: '4.1', channelType: 'im' });
    // placeholder + any messages posted without a thread_ts in a plain DM.
    expect(calls.posts.length).toBeGreaterThanOrEqual(1);
    expect(calls.posts.every((p) => p.thread_ts === undefined)).toBe(true);
  });

  it('threads replies under the mention in a channel', async () => {
    const { deps, calls } = makeDeps();
    const runner = buildTurnRunner(deps);
    await runner.handle({ channel: 'C1', user: 'U1', text: '<@BOT> hi', ts: '5.1' });
    expect(calls.posts.every((p) => p.thread_ts === '5.1')).toBe(true);
  });
});

describe('buildTurnRunner mutex race (finding 1)', () => {
  it('reserves the thread before the mention lookup so a racing event cannot double-run', async () => {
    const gate = deferred();
    const { deps, calls } = makeDeps({
      runAgenticLoop: vi.fn(async () => {
        calls.loopStarts += 1;
        await gate.promise; // hold the first turn open past all its awaits
        return {
          finishReason: 'done' as const,
          finalMessages: [],
          newTurnMessages: [],
          turnToolNames: new Set<string>(),
        };
      }) as never,
    });
    const runner = buildTurnRunner(deps);

    // Two same-thread events fired with NO await in between. Each message
    // contains a `<@U2>` mention, so handle() must await users.info — the
    // exact window where the pre-fix code let both pass the mutex check.
    const p1 = runner.handle({ channel: 'C1', user: 'U1', text: '<@BOT> <@U2> one', ts: '20.1', threadTs: 'TT' });
    const p2 = runner.handle({ channel: 'C1', user: 'U2', text: '<@BOT> <@U2> two', ts: '20.2', threadTs: 'TT' });

    await new Promise((r) => setTimeout(r, 0)); // drain microtasks
    expect(calls.loopStarts).toBe(1); // only one turn started

    gate.resolve();
    await Promise.all([p1, p2]);
    expect(calls.loopStarts).toBe(1);
  });
});

describe('buildTurnRunner DM history keying (finding 5)', () => {
  it('keys an unthreaded DM by a stable root so follow-ups share history', async () => {
    const { deps, calls } = makeDeps();
    const runner = buildTurnRunner(deps);
    await runner.handle({ channel: 'D9', user: 'U1', text: 'first question', ts: '10.1', channelType: 'im' });
    await runner.handle({ channel: 'D9', user: 'U1', text: 'follow up', ts: '10.2', channelType: 'im' });

    // Both turns resolve to ONE stable key — not their own per-message ts.
    expect(calls.saved.map((s) => s.threadTs)).toEqual(['dm-root', 'dm-root']);
    expect(new Set(calls.getConvKeys)).toEqual(new Set(['dm-root']));
  });

  it('keeps the real thread_ts for a user-threaded DM', async () => {
    const { deps, calls } = makeDeps();
    const runner = buildTurnRunner(deps);
    await runner.handle({ channel: 'D9', user: 'U1', text: 'in a thread', ts: '11.2', threadTs: '11.1', channelType: 'im' });
    expect(calls.saved.map((s) => s.threadTs)).toEqual(['11.1']);
  });
});

describe('buildTurnRunner loop-throws settlement (item B)', () => {
  it('finalizes the sink and still reports the error when runAgenticLoop throws', async () => {
    const finalize = vi.fn(async () => {});
    const onError = vi.fn();
    const sink = {
      onText: vi.fn(),
      onThinking: vi.fn(),
      onThinkingDone: vi.fn(),
      onToolStart: vi.fn(),
      onToolEnd: vi.fn(),
      onMvizPending: vi.fn(),
      onMvizBlock: vi.fn(),
      onUsage: vi.fn(),
      onError,
      onAuthExpired: vi.fn(),
      onTurnComplete: vi.fn(),
      finalize,
    };
    const { deps, calls } = makeDeps({
      createSink: vi.fn(() => sink) as never,
      runAgenticLoop: vi.fn(async () => {
        throw new Error('loop exploded');
      }) as never,
    });
    const runner = buildTurnRunner(deps);
    await runner.handle({ channel: 'C1', user: 'U1', text: '<@BOT> hi', ts: '40.1' });

    expect(finalize).toHaveBeenCalledTimes(1); // sink settled despite the throw
    expect(onError).toHaveBeenCalled(); // placeholder reaches a terminal render
    // Existing behavior preserved: a separate warning message + ⚠️ reaction.
    expect(calls.posts.some((p) => p.text?.includes('went wrong'))).toBe(true);
    expect(calls.reactions.some((r) => r.name === 'warning')).toBe(true);
  });
});
