import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * controllog used to append JSONL to local disk; this suite is entirely about
 * proving the Postgres replacement, so it mocks `../store/pg` the same way
 * src/store/kv.test.ts and src/store/events.test.ts mock it — a bare
 * `{ query: queryMock }` stand-in for the pool, never a live database.
 */
const queryMock = vi.fn();
vi.mock('../store/pg', () => ({
  getPool: () => ({ query: queryMock }),
}));

import * as cl from './controllog';

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockResolvedValue({ rows: [], rowCount: 0 });
  cl.init('quackbot-test');
  delete process.env.NEXT_PUBLIC_DISABLE_LOGGING;
});
afterEach(() => {
  delete process.env.NEXT_PUBLIC_DISABLE_LOGGING;
});

/** Build a session with one model_prompt event (1 event, 2 postings) and one tool_end event (1 event, 2 postings). */
async function sessionWithRows(): Promise<cl.Session> {
  const session = cl.createSession('C1:1700000000.000100');
  await cl.runInSession(session, async () => {
    cl.modelPrompt({
      taskId: 'chat:run1', runId: 'run1', provider: 'modal', model: 'kimi-k3',
      promptTokens: 100, exchangeId: 'ex1',
    });
    cl.toolEnd({
      taskId: 'chat:run1', runId: 'run1', toolName: 'query', toolUseId: 'tu1',
      ok: true, durationMs: 50,
    });
  });
  return session;
}

describe('createSession / runInSession / emit', () => {
  it('assigns a fresh session id and buffers events/postings under it', async () => {
    const session = await sessionWithRows();
    expect(session.id).toBeTruthy();
    expect(session.events).toHaveLength(2); // model_prompt, tool_end
    expect(session.postings).toHaveLength(4); // 2 from modelPrompt, 2 from toolEnd
  });

  it('drops emits with no active session rather than throwing', () => {
    // modelPrompt called outside runInSession — als.getStore() is undefined.
    expect(() => cl.modelPrompt({
      taskId: 't', runId: 'r', provider: 'modal', model: 'kimi-k3',
      promptTokens: 1, exchangeId: 'ex',
    })).not.toThrow();
  });

  it('honors the logging kill switch — no rows buffered at all', async () => {
    process.env.NEXT_PUBLIC_DISABLE_LOGGING = 'true';
    const session = await sessionWithRows();
    expect(session.events).toHaveLength(0);
    expect(session.postings).toHaveLength(0);
  });

  it('stamps events with the project id set by init()', async () => {
    cl.init('some-other-project');
    const session = await sessionWithRows();
    expect(session.events[0].project_id).toBe('some-other-project');
  });
});

describe('flushSession', () => {
  it('does nothing (no query) for an empty session', async () => {
    const session = cl.createSession();
    await cl.flushSession(session);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('does nothing (no query) when logging is disabled', async () => {
    const session = await sessionWithRows();
    // Rows would be empty anyway per the kill-switch test above, but assert
    // flushSession itself also short-circuits given a (hypothetically)
    // populated session, in case emit()'s own guard is ever removed.
    process.env.NEXT_PUBLIC_DISABLE_LOGGING = '1';
    await cl.flushSession(session);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('issues exactly one batched insert per table, not one per row', async () => {
    const session = await sessionWithRows();
    await cl.flushSession(session);
    expect(queryMock).toHaveBeenCalledTimes(2);
  });

  it('inserts events with session_id and emission-order ordinal, on conflict do nothing', async () => {
    const session = await sessionWithRows();
    await cl.flushSession(session);

    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/insert into controllog_events/i);
    expect(sql).toMatch(/on conflict \(event_id\) do nothing/i);
    // Two events => two parenthesized value groups.
    expect(sql.match(/\(\$/g)).toHaveLength(2);
    // 13 columns × 2 rows.
    expect(params).toHaveLength(26);

    // Row 0: event_id, session_id, ordinal, event_time, ingest_time, kind, ...
    expect(params[0]).toBe(session.events[0].event_id);
    expect(params[1]).toBe(session.id);
    expect(params[2]).toBe(0); // ordinal — first event emitted
    expect(params[5]).toBe('model_prompt'); // kind
    // Row 1 starts at index 13; ordinal is 1, matching its position in session.events.
    expect(params[13]).toBe(session.events[1].event_id);
    expect(params[14]).toBe(session.id);
    expect(params[15]).toBe(1);
    expect(params[18]).toBe('tool_end');
    // payload_json is stringified for the jsonb param, same convention as kv.ts.
    expect(typeof params[12]).toBe('string');
    expect(() => JSON.parse(params[12] as string)).not.toThrow();
  });

  it('inserts postings with session_id and emission-order ordinal, on conflict do nothing', async () => {
    const session = await sessionWithRows();
    await cl.flushSession(session);

    const [sql, params] = queryMock.mock.calls[1];
    expect(sql).toMatch(/insert into controllog_postings/i);
    expect(sql).toMatch(/on conflict \(posting_id\) do nothing/i);
    // 4 postings => 4 value groups, 9 columns each.
    expect(sql.match(/\(\$/g)).toHaveLength(4);
    expect(params).toHaveLength(36);

    // Row 0: posting_id, event_id, session_id, ordinal, account_type, ...
    expect(params[0]).toBe(session.postings[0].posting_id);
    expect(params[1]).toBe(session.postings[0].event_id);
    expect(params[2]).toBe(session.id);
    expect(params[3]).toBe(0);
    // Row 3 (last posting) carries ordinal 3, matching its array index.
    expect(params[27]).toBe(session.postings[3].posting_id);
    expect(params[30]).toBe(3);
    // dims_json is stringified.
    expect(typeof params[8]).toBe('string');
  });

  it('never throws when the events insert fails — swallows and still attempts postings', async () => {
    const session = await sessionWithRows();
    queryMock.mockRejectedValueOnce(new Error('events insert failed'));
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 4 });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(cl.flushSession(session)).resolves.toBeUndefined();

    expect(queryMock).toHaveBeenCalledTimes(2); // postings insert still ran
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('events flush failed'), expect.any(Error));
    warn.mockRestore();
  });

  it('never throws when the postings insert fails — the events insert is unaffected', async () => {
    const session = await sessionWithRows();
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 2 });
    queryMock.mockRejectedValueOnce(new Error('postings insert failed'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(cl.flushSession(session)).resolves.toBeUndefined();

    expect(queryMock).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('postings flush failed'), expect.any(Error));
    warn.mockRestore();
  });

  it('never throws when BOTH inserts fail', async () => {
    const session = await sessionWithRows();
    queryMock.mockRejectedValue(new Error('db is down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(cl.flushSession(session)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});
