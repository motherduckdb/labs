import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  makeConfirmRequester,
  registerConfirmationActions,
  describeWrite,
  __resolvePendingForTest,
  __pendingCount,
} from './confirm';

function fakeClient() {
  const postMessage = vi.fn(async () => ({ ok: true, ts: '111.222' }));
  const update = vi.fn(async () => ({ ok: true }));
  const postEphemeral = vi.fn(async () => ({ ok: true }));
  return { chat: { postMessage, update, postEphemeral } } as never;
}

/** Capture the two action handlers registered on a fake bolt app. */
function fakeApp() {
  const handlers = new Map<string, (a: unknown) => Promise<void>>();
  const app = { action: (id: string, fn: (a: unknown) => Promise<void>) => handlers.set(id, fn) } as never;
  return { app, handlers };
}

describe('describeWrite', () => {
  it('summarizes each write type with its path/title', () => {
    expect(describeWrite({ id: '1', name: 'create_guide', args: { path: 'users/x/quackbot/a.md' } })).toContain(
      'users/x/quackbot/a.md',
    );
    expect(describeWrite({ id: '1', name: 'update_guide', args: {} })).toContain('overwrite');
    expect(describeWrite({ id: '1', name: 'save_dive', args: { title: 'Q3' } })).toContain('Q3');
  });
});

describe('confirmation handshake', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('posts a prompt and resolves true when the initiating user approves', async () => {
    const client = fakeClient();
    const { app, handlers } = fakeApp();
    registerConfirmationActions(app);
    const requester = makeConfirmRequester({ client, channel: 'C1', threadTs: 'T1', initiatingUser: 'U1' });

    const promise = requester({ id: 'x', name: 'create_guide', args: { path: 'users/u/quackbot/a.md' } });
    await vi.waitFor(() => expect(__pendingCount()).toBe(1));

    // Simulate the initiating user clicking Approve.
    const approve = handlers.get('quackbot_confirm_approve')!;
    const value = (client as never as { chat: { postMessage: { mock: { calls: unknown[][] } } } }).chat.postMessage
      .mock.calls[0][0] as { blocks: Array<{ elements?: Array<{ action_id: string; value: string }> }> };
    const btnValue = value.blocks.find((b) => b.elements)!.elements!.find((e) => e.action_id === 'quackbot_confirm_approve')!.value;
    await approve({ ack: vi.fn(async () => {}), body: { user: { id: 'U1' } }, action: { value: btnValue }, client });

    expect(await promise).toBe(true);
    expect(__pendingCount()).toBe(0);
  });

  it('resolves false when denied', async () => {
    const client = fakeClient();
    const { app, handlers } = fakeApp();
    registerConfirmationActions(app);
    const requester = makeConfirmRequester({ client, channel: 'C1', initiatingUser: 'U1' });
    const promise = requester({ id: 'x', name: 'save_dive', args: {} });
    await vi.waitFor(() => expect(__pendingCount()).toBe(1));
    // Grab the pending id off the posted button and deny.
    const posted = (client as never as { chat: { postMessage: { mock: { calls: unknown[][] } } } }).chat.postMessage
      .mock.calls[0][0] as { blocks: Array<{ elements?: Array<{ action_id: string; value: string }> }> };
    const id = posted.blocks.find((b) => b.elements)!.elements![0].value;
    await handlers.get('quackbot_confirm_deny')!({
      ack: vi.fn(async () => {}),
      body: { user: { id: 'U1' } },
      action: { value: id },
      client,
    });
    expect(await promise).toBe(false);
  });

  it('ignores clicks from a non-initiating user and posts an ephemeral notice', async () => {
    const client = fakeClient();
    const { app, handlers } = fakeApp();
    registerConfirmationActions(app);
    const requester = makeConfirmRequester({ client, channel: 'C1', initiatingUser: 'U1' });
    void requester({ id: 'x', name: 'create_guide', args: { path: 'users/u/quackbot/a.md' } });
    await vi.waitFor(() => expect(__pendingCount()).toBe(1));
    const posted = (client as never as { chat: { postMessage: { mock: { calls: unknown[][] } }; postEphemeral: { mock: { calls: unknown[][] } } } });
    const id = (posted.chat.postMessage.mock.calls[0][0] as { blocks: Array<{ elements?: Array<{ value: string }> }> })
      .blocks.find((b) => b.elements)!.elements![0].value;
    await handlers.get('quackbot_confirm_approve')!({
      ack: vi.fn(async () => {}),
      body: { user: { id: 'INTRUDER' } },
      action: { value: id },
      client,
    });
    // Still pending — the wrong user cannot resolve it; an ephemeral was posted.
    expect(__pendingCount()).toBe(1);
    expect(posted.chat.postEphemeral).toHaveBeenCalled();
    __resolvePendingForTest(id, false); // cleanup
  });

  it('resolves false (fail-closed) when the prompt cannot be posted', async () => {
    const client = { chat: { postMessage: vi.fn(async () => { throw new Error('no chat:write'); }) } } as never;
    const requester = makeConfirmRequester({ client, channel: 'C1', initiatingUser: 'U1' });
    expect(await requester({ id: 'x', name: 'create_guide', args: {} })).toBe(false);
  });

  it('resolves false on timeout', async () => {
    vi.useFakeTimers();
    const client = fakeClient();
    const requester = makeConfirmRequester({ client, channel: 'C1', initiatingUser: 'U1' });
    const promise = requester({ id: 'x', name: 'create_guide', args: {} });
    // Flush the postMessage microtask so the timeout timer is registered.
    await vi.advanceTimersByTimeAsync(0);
    expect(__pendingCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(120_001);
    expect(await promise).toBe(false);
    expect(__pendingCount()).toBe(0);
  });
});
