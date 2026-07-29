import { describe, expect, it, vi } from 'vitest';
import {
  makeConfirmRequester,
  registerConfirmationActions,
  describeWrite,
  type ConfirmStore,
  type ConfirmStatus,
  type DecisionResult,
} from './confirm';

/**
 * An in-memory `confirmations` table. Not a mock — it reproduces the two
 * semantics the handshake actually leans on: the decision UPDATE is conditional
 * on `status = 'pending'` (first click wins, later clicks are no-ops) and on
 * the initiating user (a bystander cannot approve someone else's write). The
 * SQL in `pgConfirmStore.decide` and the Python edge must behave identically;
 * this is where that behaviour is pinned down. No database is involved.
 */
interface Row {
  channel: string;
  threadTs: string;
  status: ConfirmStatus;
  decidedBy?: string;
  initiatingUser?: string;
  payload: Record<string, unknown>;
}

/**
 * `log` records store and Slack calls in the order they happen, so the tests
 * that care about ORDERING (insert before post, expire before rendering the
 * timeout) can assert it directly rather than inferring it from end state.
 */
function fakeStore(log: string[] = []) {
  const rows = new Map<string, Row>();

  const store: ConfirmStore = {
    async create({ confirmId, channel, threadTs, payload }) {
      log.push('store.create');
      rows.set(confirmId, {
        channel,
        // thread_ts is NOT NULL in the schema; an unthreaded DM stores ''.
        threadTs: threadTs ?? '',
        status: 'pending',
        initiatingUser: (payload.initiating_user as string | null) ?? undefined,
        payload,
      });
    },

    async read(confirmId) {
      const row = rows.get(confirmId);
      if (!row) return null;
      return { status: row.status, decidedBy: row.decidedBy };
    },

    async decide(confirmId, approved, decidedBy): Promise<DecisionResult> {
      const row = rows.get(confirmId);
      if (!row) return { outcome: 'missing' };
      if (row.status !== 'pending') return { outcome: 'already-decided', status: row.status };
      if (row.initiatingUser && row.initiatingUser !== decidedBy) {
        return { outcome: 'not-initiator', initiatingUser: row.initiatingUser };
      }
      row.status = approved ? 'approved' : 'denied';
      row.decidedBy = decidedBy;
      return { outcome: 'recorded' };
    },

    async expire(confirmId) {
      log.push('store.expire');
      const row = rows.get(confirmId);
      if (!row || row.status !== 'pending') return;
      row.status = 'denied'; // decidedBy stays undefined — the timeout marker
    },
  };

  return { store, rows, log, only: () => Array.from(rows.keys())[0] };
}

function fakeClient(log: string[] = []) {
  const postMessage = vi.fn(async () => {
    log.push('chat.postMessage');
    return { ok: true, ts: '111.222' };
  });
  const update = vi.fn(async () => {
    log.push('chat.update');
    return { ok: true };
  });
  const postEphemeral = vi.fn(async () => {
    log.push('chat.postEphemeral');
    return { ok: true };
  });
  return { chat: { postMessage, update, postEphemeral } } as never;
}

type ChatSpies = {
  chat: {
    postMessage: { mock: { calls: unknown[][] } };
    update: { mock: { calls: unknown[][] } };
    postEphemeral: { mock: { calls: unknown[][] } };
  };
};

/** Capture the two action handlers registered on a fake bolt app. */
function fakeApp() {
  const handlers = new Map<string, (a: unknown) => Promise<void>>();
  const app = { action: (id: string, fn: (a: unknown) => Promise<void>) => handlers.set(id, fn) } as never;
  return { app, handlers };
}

/** Fast timings so the poll loop runs for real without slowing the suite. */
const FAST = { pollIntervalMs: 2, timeoutMs: 500 };

describe('describeWrite', () => {
  it('names a create_guide by its title and topic (post-migration fields, not the dead `path`)', () => {
    const s = describeWrite({
      id: '1',
      name: 'create_guide',
      args: { title: 'Revenue definition', topic: 'quackbot/metrics', content: 'x' },
    });
    expect(s).toContain('Revenue definition');
    expect(s).toContain('quackbot/metrics');
    // The pre-migration `path` field must no longer leak through.
    expect(describeWrite({ id: '1', name: 'create_guide', args: { path: 'users/x/quackbot/a.md' } })).not.toContain(
      'users/x/quackbot/a.md',
    );
  });

  it('names an update_guide by its RESOLVED target (title + topic + uuid), not a bare uuid', () => {
    const s = describeWrite({
      id: '1',
      name: 'update_guide',
      args: { uuid: 'b00542d5-abcd', content: 'x' },
      target: { title: 'Taxi data table', topic: 'quackbot/taxi', uuid: 'b00542d5-abcd' },
    });
    expect(s).toContain('overwrite');
    expect(s).toContain('Taxi data table');
    expect(s).toContain('quackbot/taxi');
    expect(s).toContain('b00542d5-abcd');
  });

  it('summarizes an edit_guide_content change: target + edit count + first old_string snippet', () => {
    const s = describeWrite({
      id: '1',
      name: 'edit_guide_content',
      args: { uuid: 'u', edits: [{ old_string: 'joins customers.user_id', new_string: 'joins customers.id' }, { old_string: 'a', new_string: 'b' }] },
      target: { title: 'Join keys', topic: 'quackbot/joins', uuid: 'u' },
    });
    expect(s).toContain('Join keys');
    expect(s).toContain('quackbot/joins');
    expect(s).toContain('2 edits');
    expect(s).toContain('joins customers.user_id');
  });

  it('truncates a long first old_string snippet to ~80 chars', () => {
    const long = 'x'.repeat(200);
    const s = describeWrite({
      id: '1',
      name: 'edit_guide_content',
      args: { uuid: 'u', edits: [{ old_string: long, new_string: 'y' }] },
      target: { title: 'T', topic: 'quackbot/x', uuid: 'u' },
    });
    expect(s).toContain('1 edit');
    expect(s).toContain('…');
    expect(s).not.toContain(long);
  });

  it('summarizes save_dive by its title', () => {
    expect(describeWrite({ id: '1', name: 'save_dive', args: { title: 'Q3' } })).toContain('Q3');
  });
});

describe('confirmation handshake (Postgres rendezvous)', () => {
  it('records the row BEFORE posting the prompt', async () => {
    // If the post came first, an instant click could hit /slack/interactive
    // before the row it needs to update exists. Ordering closes that window.
    const log: string[] = [];
    const { store } = fakeStore(log);
    const client = fakeClient(log);
    const requester = makeConfirmRequester({ client, channel: 'C1', initiatingUser: 'U1', store, pollIntervalMs: 2, timeoutMs: 20 });

    await requester({ id: 'x', name: 'save_dive', args: {} });

    expect(log.slice(0, 2)).toEqual(['store.create', 'chat.postMessage']);
  });

  it('stores the initiating user in the payload — the edge reads it to authorize the click', async () => {
    const { store, rows, only } = fakeStore();
    const client = fakeClient();
    const requester = makeConfirmRequester({ client, channel: 'C1', threadTs: 'T1', initiatingUser: 'U1', store, ...FAST });
    const promise = requester({ id: 'x', name: 'create_guide', args: { title: 'G', content: 'body' } });
    await vi.waitFor(() => expect(rows.size).toBe(1));

    const row = rows.get(only())!;
    expect(row.payload.initiating_user).toBe('U1');
    expect(row.payload.tool).toBe('create_guide');
    expect(row.channel).toBe('C1');
    expect(row.threadTs).toBe('T1');
    // The raw args are NOT archived — a guide `content` can be tens of KB.
    expect(row.payload).not.toHaveProperty('args');
    await promise;
  });

  it('resolves true when the initiating user approves', async () => {
    const { store, rows, only } = fakeStore();
    const client = fakeClient();
    const requester = makeConfirmRequester({ client, channel: 'C1', initiatingUser: 'U1', store, ...FAST });

    const promise = requester({ id: 'x', name: 'create_guide', args: { title: 'G' } });
    await vi.waitFor(() => expect(rows.size).toBe(1));
    // The click lands in another process; all it does is write the row.
    expect(await store.decide(only(), true, 'U1')).toEqual({ outcome: 'recorded' });

    expect(await promise).toBe(true);
  });

  it('resolves false when denied', async () => {
    const { store, rows, only } = fakeStore();
    const client = fakeClient();
    const requester = makeConfirmRequester({ client, channel: 'C1', initiatingUser: 'U1', store, ...FAST });

    const promise = requester({ id: 'x', name: 'save_dive', args: {} });
    await vi.waitFor(() => expect(rows.size).toBe(1));
    await store.decide(only(), false, 'U1');

    expect(await promise).toBe(false);
  });

  it('removes the Approve/Deny buttons once a decision lands, naming who decided', async () => {
    const { store, rows, only } = fakeStore();
    const client = fakeClient();
    const requester = makeConfirmRequester({ client, channel: 'C1', initiatingUser: 'U1', store, ...FAST });

    const promise = requester({ id: 'x', name: 'save_dive', args: {} });
    await vi.waitFor(() => expect(rows.size).toBe(1));
    await store.decide(only(), true, 'U1');
    await promise;

    const spies = client as never as ChatSpies;
    const edit = spies.chat.update.mock.calls[0][0] as { blocks: Array<{ type: string }>; text: string };
    expect(edit.text).toContain('Approved');
    expect(edit.text).toContain('<@U1>');
    // One plain section — no `actions` block means no clickable stale buttons.
    expect(edit.blocks).toHaveLength(1);
    expect(edit.blocks.every((b) => b.type !== 'actions')).toBe(true);
  });

  it('resolves false on timeout, fails the row CLOSED, and clears the buttons', async () => {
    const log: string[] = [];
    const { store, rows, only } = fakeStore(log);
    const client = fakeClient(log);
    const requester = makeConfirmRequester({ client, channel: 'C1', initiatingUser: 'U1', store, pollIntervalMs: 2, timeoutMs: 20 });

    expect(await requester({ id: 'x', name: 'create_guide', args: {} })).toBe(false);

    // Expire BEFORE the message is rewritten. The gap between the two is a
    // window where the buttons are still live; closing the row first means a
    // click landing in it is rejected rather than approving a write the worker
    // has already given up on.
    expect(log.indexOf('store.expire')).toBeLessThan(log.lastIndexOf('chat.update'));
    expect(log.filter((e) => e === 'store.expire')).toHaveLength(1);

    // Expired, not left pending: a click arriving now must not approve a write
    // nobody is waiting to run. `decidedBy` stays unset — that is how an audit
    // tells a timeout apart from a human deny.
    const row = rows.get(only())!;
    expect(row.status).toBe('denied');
    expect(row.decidedBy).toBeUndefined();

    const spies = client as never as ChatSpies;
    const edit = spies.chat.update.mock.calls[0][0] as { blocks: unknown[]; text: string };
    expect(edit.text).toContain('timed out');
    expect(edit.blocks).toHaveLength(1);
  });

  it('rejects a click that arrives after the timeout', async () => {
    const { store, rows, only } = fakeStore();
    const client = fakeClient();
    const requester = makeConfirmRequester({ client, channel: 'C1', initiatingUser: 'U1', store, pollIntervalMs: 2, timeoutMs: 20 });
    await requester({ id: 'x', name: 'create_guide', args: {} });
    await vi.waitFor(() => expect(rows.size).toBe(1));

    expect(await store.decide(only(), true, 'U1')).toEqual({ outcome: 'already-decided', status: 'denied' });
  });

  it('resolves false (fail-closed) when the prompt cannot be posted, and closes the row', async () => {
    const { store, rows, only } = fakeStore();
    const client = { chat: { postMessage: vi.fn(async () => { throw new Error('no chat:write'); }) } } as never;
    const requester = makeConfirmRequester({ client, channel: 'C1', initiatingUser: 'U1', store, ...FAST });

    expect(await requester({ id: 'x', name: 'create_guide', args: {} })).toBe(false);
    // No orphaned 'pending' row waiting for a click on a message that was
    // never posted.
    expect(rows.get(only())!.status).toBe('denied');
  });

  it('resolves false (fail-closed) when the row cannot be written at all', async () => {
    const { store } = fakeStore();
    const client = fakeClient();
    const failing: ConfirmStore = { ...store, create: async () => { throw new Error('pg down'); } };
    const requester = makeConfirmRequester({ client, channel: 'C1', initiatingUser: 'U1', store: failing, ...FAST });

    expect(await requester({ id: 'x', name: 'create_guide', args: {} })).toBe(false);
    // Without a rendezvous row there is nothing to wait on — don't even ask.
    expect((client as never as ChatSpies).chat.postMessage.mock.calls).toHaveLength(0);
  });

  it('keeps polling through a transient read failure', async () => {
    const { store, rows, only } = fakeStore();
    const client = fakeClient();
    let reads = 0;
    const flaky: ConfirmStore = {
      ...store,
      read: async (id) => {
        reads += 1;
        if (reads <= 2) throw new Error('connection reset');
        return store.read(id);
      },
    };
    const requester = makeConfirmRequester({ client, channel: 'C1', initiatingUser: 'U1', store: flaky, ...FAST });

    const promise = requester({ id: 'x', name: 'save_dive', args: {} });
    await vi.waitFor(() => expect(reads).toBeGreaterThan(2));
    await store.decide(only(), true, 'U1');
    expect(await promise).toBe(true);
    expect(rows.get(only())!.status).toBe('approved');
  });

  it('fails closed immediately if the row disappears, without waiting out the timeout', async () => {
    const { store, rows } = fakeStore();
    const client = fakeClient();
    const vanishing: ConfirmStore = { ...store, read: async () => null };
    // A 60s timeout: if the short-circuit regresses, this test hangs rather
    // than quietly passing, and the elapsed assertion names why.
    const requester = makeConfirmRequester({ client, channel: 'C1', initiatingUser: 'U1', store: vanishing, timeoutMs: 60_000, pollIntervalMs: 2 });

    const started = Date.now();
    expect(await requester({ id: 'x', name: 'save_dive', args: {} })).toBe(false);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(rows.size).toBe(1);

    // The user is told the state was lost, not left staring at live buttons.
    const edit = (client as never as ChatSpies).chat.update.mock.calls[0][0] as { text: string; blocks: unknown[] };
    expect(edit.text).toContain('lost');
    expect(edit.blocks).toHaveLength(1);
  });
});

describe('decision authorization (the contract the Python edge implements)', () => {
  it('lets only the initiating user decide', async () => {
    const { store, rows, only } = fakeStore();
    const client = fakeClient();
    const requester = makeConfirmRequester({ client, channel: 'C1', initiatingUser: 'U1', store, ...FAST });
    const promise = requester({ id: 'x', name: 'create_guide', args: {} });
    await vi.waitFor(() => expect(rows.size).toBe(1));

    expect(await store.decide(only(), true, 'INTRUDER')).toEqual({ outcome: 'not-initiator', initiatingUser: 'U1' });
    expect(rows.get(only())!.status).toBe('pending'); // still open for the right user

    await store.decide(only(), true, 'U1');
    expect(await promise).toBe(true);
  });

  it('makes the first decision win — a second click is a no-op', async () => {
    const { store, rows, only } = fakeStore();
    const client = fakeClient();
    const requester = makeConfirmRequester({ client, channel: 'C1', initiatingUser: 'U1', store, ...FAST });
    const promise = requester({ id: 'x', name: 'save_dive', args: {} });
    await vi.waitFor(() => expect(rows.size).toBe(1));

    await store.decide(only(), false, 'U1');
    expect(await store.decide(only(), true, 'U1')).toEqual({ outcome: 'already-decided', status: 'denied' });
    expect(await promise).toBe(false);
  });

  it('reports a missing confirmation rather than inventing one', async () => {
    const { store } = fakeStore();
    expect(await store.decide('nope', true, 'U1')).toEqual({ outcome: 'missing' });
  });
});

describe('registerConfirmationActions (bolt bridge / reference implementation)', () => {
  it('records the decision and leaves the message to the waiting worker', async () => {
    const { store, rows, only } = fakeStore();
    const client = fakeClient();
    const { app, handlers } = fakeApp();
    registerConfirmationActions(app, store);

    const requester = makeConfirmRequester({ client, channel: 'C1', initiatingUser: 'U1', store, ...FAST });
    const promise = requester({ id: 'x', name: 'create_guide', args: {} });
    await vi.waitFor(() => expect(rows.size).toBe(1));

    // The button `value` is the confirm id — that is the whole handoff.
    const posted = (client as never as ChatSpies).chat.postMessage.mock.calls[0][0] as {
      blocks: Array<{ elements?: Array<{ action_id: string; value: string }> }>;
    };
    const btn = posted.blocks.find((b) => b.elements)!.elements!.find((e) => e.action_id === 'quackbot_confirm_approve')!;
    expect(btn.value).toBe(only());

    const ack = vi.fn(async () => {});
    const updatesBeforeClick = (client as never as ChatSpies).chat.update.mock.calls.length;
    await handlers.get('quackbot_confirm_approve')!({
      ack,
      body: { user: { id: 'U1' }, channel: { id: 'C1' } },
      action: { value: btn.value },
      client,
    } as never);

    expect(ack).toHaveBeenCalled();
    expect(rows.get(only())!.status).toBe('approved');

    // The bridge writes the row and acks — nothing else. Rendering belongs to
    // the polling worker, so that one writer owns the message and the Python
    // edge (which has no chat.update in its contract) behaves identically.
    expect((client as never as ChatSpies).chat.update.mock.calls).toHaveLength(updatesBeforeClick);

    expect(await promise).toBe(true);
    // ...and only once the worker's poll observes the decision does it render.
    expect((client as never as ChatSpies).chat.update.mock.calls.length).toBeGreaterThan(updatesBeforeClick);
  });

  it('denies via the deny action', async () => {
    const { store, rows, only } = fakeStore();
    const client = fakeClient();
    const { app, handlers } = fakeApp();
    registerConfirmationActions(app, store);
    const requester = makeConfirmRequester({ client, channel: 'C1', initiatingUser: 'U1', store, ...FAST });
    const promise = requester({ id: 'x', name: 'save_dive', args: {} });
    await vi.waitFor(() => expect(rows.size).toBe(1));

    await handlers.get('quackbot_confirm_deny')!({
      ack: vi.fn(async () => {}),
      body: { user: { id: 'U1' }, channel: { id: 'C1' } },
      action: { value: only() },
      client,
    } as never);

    expect(await promise).toBe(false);
    expect(rows.get(only())!.decidedBy).toBe('U1');
  });

  it('ignores a click from a non-initiating user and posts an ephemeral notice', async () => {
    const { store, rows, only } = fakeStore();
    const client = fakeClient();
    const { app, handlers } = fakeApp();
    registerConfirmationActions(app, store);
    const requester = makeConfirmRequester({ client, channel: 'C1', initiatingUser: 'U1', store, ...FAST });
    const promise = requester({ id: 'x', name: 'create_guide', args: {} });
    await vi.waitFor(() => expect(rows.size).toBe(1));

    await handlers.get('quackbot_confirm_approve')!({
      ack: vi.fn(async () => {}),
      body: { user: { id: 'INTRUDER' }, channel: { id: 'C1' } },
      action: { value: only() },
      client,
    } as never);

    expect(rows.get(only())!.status).toBe('pending');
    expect((client as never as ChatSpies).chat.postEphemeral.mock.calls).toHaveLength(1);

    await store.decide(only(), false, 'U1'); // let the requester finish
    expect(await promise).toBe(false);
  });

  it('treats a stale click as a silent no-op — no ephemeral, no message edit, no throw', async () => {
    // 'already-decided' and 'missing' both land here: the confirmation is over
    // and the clicker gets nothing, because anything else would be noise on a
    // message whose buttons are about to vanish anyway.
    const { store, rows } = fakeStore();
    const client = fakeClient();
    const { app, handlers } = fakeApp();
    registerConfirmationActions(app, store);

    await expect(
      handlers.get('quackbot_confirm_approve')!({
        ack: vi.fn(async () => {}),
        body: { user: { id: 'U1' }, channel: { id: 'C1' } },
        action: { value: 'no-such-confirmation' },
        client,
      } as never),
    ).resolves.toBeUndefined();

    const spies = client as never as ChatSpies;
    expect(spies.chat.postEphemeral.mock.calls).toHaveLength(0);
    expect(spies.chat.update.mock.calls).toHaveLength(0);
    expect(rows.size).toBe(0);
  });

  it('acks and gives up quietly when the decision write fails', async () => {
    // Slack retries an un-acked interaction; a database blip must not turn one
    // click into a retry storm. Ack first, log, drop.
    const { store } = fakeStore();
    const client = fakeClient();
    const { app, handlers } = fakeApp();
    const failing: ConfirmStore = { ...store, decide: async () => { throw new Error('pg down'); } };
    registerConfirmationActions(app, failing);

    const ack = vi.fn(async () => {});
    await expect(
      handlers.get('quackbot_confirm_deny')!({
        ack,
        body: { user: { id: 'U1' }, channel: { id: 'C1' } },
        action: { value: 'anything' },
        client,
      } as never),
    ).resolves.toBeUndefined();
    expect(ack).toHaveBeenCalled();
  });
});
