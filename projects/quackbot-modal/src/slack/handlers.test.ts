import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildTurnRunner, makeWorkerDeps, type TurnRunnerDeps } from './handlers';
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

/**
 * In-memory stand-ins for src/store/{events,locks}. These are fakes, not mocks:
 * they reproduce the two properties the handler actually depends on — the
 * dedupe claim is atomic (check-and-insert in one step) and the lock is
 * non-blocking (a second acquire of a held key fails immediately rather than
 * queueing). Both check-and-set synchronously before their first await, which
 * is what makes the racing-events test below meaningful. No database anywhere.
 */
function makeStoreFakes() {
  const seenEvents = new Set<string>();
  const heldLocks = new Set<string>();
  const dedupeKeys: string[] = [];
  const lockKeys: string[] = [];

  const markEventSeen = vi.fn(async (eventId: string) => {
    dedupeKeys.push(eventId);
    if (seenEvents.has(eventId)) return false;
    seenEvents.add(eventId);
    return true;
  });

  const withThreadLock = vi.fn(async <T,>(key: string, fn: () => Promise<T>) => {
    lockKeys.push(key);
    if (heldLocks.has(key)) return { acquired: false as const };
    heldLocks.add(key);
    try {
      return { acquired: true as const, result: await fn() };
    } finally {
      heldLocks.delete(key);
    }
  });

  return { markEventSeen, withThreadLock, dedupeKeys, lockKeys };
}

function makeDeps(overrides: Partial<TurnRunnerDeps> = {}): {
  deps: TurnRunnerDeps;
  calls: {
    posts: Array<{ channel: string; thread_ts?: string; text?: string }>;
    reactions: Array<{ name: string; ts: string }>;
    setChannelDatabases: Array<{ channel: string; dbs: string[] }>;
    saved: Array<{ channel: string; threadTs: string }>;
    getConvKeys: string[];
    dedupeKeys: string[];
    lockKeys: string[];
    loopStarts: number;
  };
} {
  const store = makeStoreFakes();
  const calls = {
    posts: [] as Array<{ channel: string; thread_ts?: string; text?: string }>,
    reactions: [] as Array<{ name: string; ts: string }>,
    setChannelDatabases: [] as Array<{ channel: string; dbs: string[] }>,
    saved: [] as Array<{ channel: string; threadTs: string }>,
    getConvKeys: [] as string[],
    dedupeKeys: store.dedupeKeys,
    lockKeys: store.lockKeys,
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
    fetchQueryGuideBlock: vi.fn(async () => 'ORG GUIDE BLOCK') as never,
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
    makeConfirmRequester: vi.fn(() => async () => true) as never,
    markEventSeen: store.markEventSeen as never,
    withThreadLock: store.withThreadLock as never,
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

  it('claims on (channel, ts) — NOT Slack event_id — so a DM @-mention fires once', async () => {
    // A DM @-mention arrives twice: once as `message.im`, once as
    // `app_mention`, carrying two DIFFERENT Slack event_ids for one human
    // utterance. Only (channel, ts) is stable across the pair, so that is what
    // the dedupe row keys on. Deduping on the real event_id would let both
    // through and the bot would answer itself twice.
    const { deps, calls } = makeDeps();
    const runner = buildTurnRunner(deps);

    // Ev0AAA — delivered as message.im
    await runner.handle({ channel: 'D9', user: 'U1', text: '<@BOT> hello', ts: '99.1', channelType: 'im' });
    // Ev0BBB — the same utterance, delivered again as app_mention
    await runner.handle({ channel: 'D9', user: 'U1', text: '<@BOT> hello', ts: '99.1' });

    expect(calls.loopStarts).toBe(1);
    expect(calls.dedupeKeys).toEqual(['D9:99.1', 'D9:99.1']);
    expect(calls.dedupeKeys.every((k) => !/^Ev/.test(k))).toBe(true);
  });

  it('checks dedupe BEFORE taking the lock, so a redelivery never consumes an acquire', async () => {
    const { deps, calls } = makeDeps();
    const runner = buildTurnRunner(deps);
    const msg = { channel: 'C1', user: 'U1', text: '<@BOT> hello', ts: '98.1' };
    await runner.handle(msg);
    await runner.handle(msg);

    expect(calls.dedupeKeys).toHaveLength(2); // both deliveries checked
    expect(calls.lockKeys).toEqual(['C1:98.1']); // only the first reached the lock
  });

  it('proceeds when the dedupe claim itself fails (fail open, not silence)', async () => {
    const { deps, calls } = makeDeps({
      markEventSeen: vi.fn(async () => {
        throw new Error('pg down');
      }) as never,
    });
    const runner = buildTurnRunner(deps);
    await runner.handle({ channel: 'C1', user: 'U1', text: '<@BOT> hello', ts: '97.1' });
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

  it('posts the busy reply when another WORKER holds the lock (no promise to queue behind)', async () => {
    // The cross-container case: the lock is held by a process this one shares
    // nothing with, so all we get back is `{acquired: false}`. Exactly one
    // human-readable reply, and no retry.
    const { deps, calls } = makeDeps({
      withThreadLock: vi.fn(async () => ({ acquired: false })) as never,
    });
    const runner = buildTurnRunner(deps);
    await runner.handle({ channel: 'C1', user: 'U1', text: '<@BOT> hi', ts: '6.1', threadTs: 'TT' });

    expect(calls.loopStarts).toBe(0);
    expect(calls.reactions.filter((r) => r.name === 'hourglass_flowing_sand')).toHaveLength(1);
    expect(calls.posts.filter((p) => p.text?.includes('still working'))).toHaveLength(1);
  });

  it('locks on (channel, conversation key) — an unthreaded DM uses the stable dm-root key', async () => {
    const { deps, calls } = makeDeps();
    const runner = buildTurnRunner(deps);
    await runner.handle({ channel: 'D9', user: 'U1', text: 'hi', ts: '7.1', channelType: 'im' });
    await runner.handle({ channel: 'C1', user: 'U1', text: '<@BOT> hi', ts: '7.2', threadTs: 'TT' });
    expect(calls.lockKeys).toEqual(['D9:dm-root', 'C1:TT']);
  });

  it('reports a lock failure to the user instead of throwing into the listener', async () => {
    const { deps, calls } = makeDeps({
      withThreadLock: vi.fn(async () => {
        throw new Error('pg down');
      }) as never,
    });
    const runner = buildTurnRunner(deps);
    await expect(
      runner.handle({ channel: 'C1', user: 'U1', text: '<@BOT> hi', ts: '8.1' }),
    ).resolves.toBeUndefined();
    expect(calls.posts.some((p) => p.text?.includes('went wrong'))).toBe(true);
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

describe('buildTurnRunner query-guide injection', () => {
  it('fetches the query guide with the MCP client and passes it into buildSystemPrompt', async () => {
    const mcpClient = { close: vi.fn(async () => {}) };
    const fetchQueryGuideBlock = vi.fn(async () => 'ORG GUIDE BLOCK');
    const buildSystemPrompt = vi.fn(() => 'system');
    const { deps } = makeDeps({
      createMCPClient: vi.fn(async () => mcpClient) as never,
      fetchQueryGuideBlock: fetchQueryGuideBlock as never,
      buildSystemPrompt: buildSystemPrompt as never,
    });
    const runner = buildTurnRunner(deps);
    await runner.handle({ channel: 'C1', user: 'U1', text: '<@BOT> hi', ts: '50.1' });

    expect(fetchQueryGuideBlock).toHaveBeenCalledWith(mcpClient);
    expect(buildSystemPrompt).toHaveBeenCalledWith(['db1'], 'ORG GUIDE BLOCK');
  });

  it('still builds the prompt (with null guide) when the fetch fails', async () => {
    const fetchQueryGuideBlock = vi.fn(async () => null);
    const buildSystemPrompt = vi.fn(() => 'system');
    const { deps, calls } = makeDeps({
      fetchQueryGuideBlock: fetchQueryGuideBlock as never,
      buildSystemPrompt: buildSystemPrompt as never,
    });
    const runner = buildTurnRunner(deps);
    await runner.handle({ channel: 'C1', user: 'U1', text: '<@BOT> hi', ts: '51.1' });

    expect(buildSystemPrompt).toHaveBeenCalledWith(['db1'], null);
    expect(calls.loopStarts).toBe(1); // turn still ran
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

describe('reasoning effort default', () => {
  const KEY = 'QUACKBOT_THINKING_LEVEL';
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env[KEY];
  });

  afterEach(() => {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
  });

  it('falls back to `low`, not `medium`, when QUACKBOT_THINKING_LEVEL is unset', () => {
    // This is the value that becomes `reasoning_effort`, which on Kimi K3 costs
    // both $15/MTok and wall-clock decode before the user sees anything. It was
    // `medium` — inherited from the OpenRouter/Gemini-Flash era — while
    // toReasoningEffort, README.md and .env.example all documented `low`. The
    // documented default was unreachable, because this path always supplied a
    // valid level and toReasoningEffort's own fallback never fired.
    delete process.env[KEY];
    expect(makeWorkerDeps({} as never).thinkingLevel).toBe('low');
  });

  it('still falls back to `low` for an unrecognised value', () => {
    process.env[KEY] = 'ultra';
    expect(makeWorkerDeps({} as never).thinkingLevel).toBe('low');
  });

  it('passes an explicit level through unchanged', () => {
    process.env[KEY] = 'xhigh';
    expect(makeWorkerDeps({} as never).thinkingLevel).toBe('xhigh');
  });

  it('hands the resolved level to the agentic loop', () => {
    const { deps } = makeDeps({ thinkingLevel: undefined });
    const runner = buildTurnRunner(deps);
    return runner
      .handle({ channel: 'C1', user: 'U1', text: '<@BOT> hi', ts: '90.1' })
      .then(() => {
        const loop = deps.runAgenticLoop as unknown as { mock: { calls: Array<[{ thinkingLevel: string }]> } };
        expect(loop.mock.calls[0][0].thinkingLevel).toBe('low');
      });
  });
});
