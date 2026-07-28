import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * These cover the worker's decision functions — which events become turns, what
 * env must exist, where a failure notice goes, and the two `kv_cache` lookups
 * that replaced bolt's module-scope state. The `main()` path is not exercised
 * here: it needs stdin, Postgres, Slack and an LLM, so the useful test of it is
 * the synthetic signed-event smoke against a deployed app (PLAN.md §7).
 *
 * The filtering is worth real tests rather than eyeballing, because every one of
 * these predicates fails in the same direction — an event that should have been
 * dropped gets answered — and the two worst cases (the bot answering itself in a
 * DM, the bot answering every message in a channel it was invited to) are both
 * loops that are visible to the whole workspace before anyone can stop them.
 *
 * `src/store/kv` is mocked because these tests are about what the worker does
 * with a hit, a miss and a failure, not about whether Postgres stores what it is
 * handed — store/kv has its own tests for that.
 *
 * Importing `./worker` at all is only safe because of its `isEntrypoint()`
 * guard. Without it this import would run a turn: read stdin, throw on the
 * missing env, and set a nonzero `process.exitCode` that fails the vitest run
 * whatever the assertions below say. If that guard is ever dropped, this is the
 * file where it surfaces.
 */
vi.mock('./store/kv', () => ({ kvGet: vi.fn(), kvSet: vi.fn() }));

import { kvGet, kvSet } from './store/kv';
import {
  assistantKey,
  errorNoticeThreadTs,
  isAssistantChannel,
  missingEnv,
  resolveBotUserId,
  toIncomingMessage,
  type SlackEvent,
} from './worker';

const mockKvGet = vi.mocked(kvGet);
const mockKvSet = vi.mocked(kvSet);

beforeEach(() => {
  vi.clearAllMocks();
  mockKvGet.mockResolvedValue(null);
  mockKvSet.mockResolvedValue(undefined);
});

const BOT = 'UBOT';

/** A DM message event, before any filter has looked at it. */
function dm(over: Partial<SlackEvent> = {}): SlackEvent {
  return { type: 'message', channel: 'D1', channel_type: 'im', user: 'U1', text: 'hi', ts: '1.1', ...over };
}

/** An in-channel mention event. */
function mention(over: Partial<SlackEvent> = {}): SlackEvent {
  return { type: 'app_mention', channel: 'C1', user: 'U1', text: `<@${BOT}> hi`, ts: '1.1', ...over };
}

describe('toIncomingMessage — which events are turns', () => {
  it('accepts a plain DM and carries the fields the runner needs', () => {
    expect(toIncomingMessage(dm(), { botUserId: BOT })).toEqual({
      channel: 'D1',
      user: 'U1',
      text: 'hi',
      ts: '1.1',
      threadTs: undefined,
      channelType: 'im',
      isAssistant: undefined,
    });
  });

  it('accepts an app_mention in a channel', () => {
    expect(toIncomingMessage(mention(), { botUserId: BOT })?.channel).toBe('C1');
  });

  it('preserves thread_ts so a threaded reply stays in its thread', () => {
    expect(toIncomingMessage(dm({ thread_ts: '0.9' }), { botUserId: BOT })?.threadTs).toBe('0.9');
  });

  it('drops a non-DM message event — channel messages arrive as app_mention', () => {
    // Without this the bot answers every message in any channel it is in.
    expect(toIncomingMessage(dm({ channel: 'C1', channel_type: 'channel' }), { botUserId: BOT })).toBeNull();
  });

  it('drops an edited message rather than re-answering the original text', () => {
    // message_changed carries the ORIGINAL text, so answering it looks like the
    // bot spontaneously repeating itself.
    expect(toIncomingMessage(dm({ subtype: 'message_changed' }), { botUserId: BOT })).toBeNull();
  });

  it.each(['message_deleted', 'channel_join', 'thread_broadcast', 'file_share'])(
    'drops the %s subtype',
    (subtype) => {
      expect(toIncomingMessage(dm({ subtype }), { botUserId: BOT })).toBeNull();
    },
  );

  it('drops any bot message, in DMs and in mentions — this is the self-reply loop guard', () => {
    expect(toIncomingMessage(dm({ bot_id: 'B1', user: undefined }), { botUserId: BOT })).toBeNull();
    expect(toIncomingMessage(mention({ bot_id: 'B1', user: undefined }), { botUserId: BOT })).toBeNull();
  });

  it('drops our own message even when it arrives with a user id instead of a bot_id', () => {
    expect(toIncomingMessage(dm({ user: BOT }), { botUserId: BOT })).toBeNull();
    expect(toIncomingMessage(mention({ user: BOT }), { botUserId: BOT })).toBeNull();
  });

  it('still drops a bot_id message when the bot user id could not be resolved', () => {
    // resolveBotUserId returns undefined on an auth.test failure; the loop guard
    // must not depend on it, or an outage turns into the bot talking to itself.
    expect(toIncomingMessage(dm({ bot_id: 'B1', user: undefined }), {})).toBeNull();
  });

  it('ignores event types that are not messages', () => {
    for (const type of ['reaction_added', 'assistant_thread_started', 'app_home_opened', undefined]) {
      expect(toIncomingMessage(dm({ type }), { botUserId: BOT })).toBeNull();
    }
  });

  it('rejects an event missing channel or ts instead of shaping a half-message', () => {
    expect(toIncomingMessage(dm({ channel: undefined }), { botUserId: BOT })).toBeNull();
    expect(toIncomingMessage(dm({ ts: undefined }), { botUserId: BOT })).toBeNull();
  });

  it('defaults absent text to empty rather than undefined', () => {
    expect(toIncomingMessage(dm({ text: undefined }), { botUserId: BOT })?.text).toBe('');
  });

  it('passes isAssistant through untouched', () => {
    expect(toIncomingMessage(dm(), { botUserId: BOT, isAssistant: true })?.isAssistant).toBe(true);
  });
});

describe('missingEnv', () => {
  const ok = {
    SLACK_BOT_TOKEN: 'x',
    MOTHERDUCK_TOKEN: 'x',
    DATABASE_URL: 'x',
    MODAL_INFERENCE_BASE_URL: 'x',
  };

  it('passes a complete environment', () => {
    expect(missingEnv(ok)).toEqual([]);
  });

  it('names every missing variable, not just the first', () => {
    expect(missingEnv({ SLACK_BOT_TOKEN: 'x' })).toEqual([
      'MOTHERDUCK_TOKEN',
      'DATABASE_URL',
      'MODAL_INFERENCE_BASE_URL',
    ]);
  });

  it('treats an empty string as missing — an unset Modal secret arrives as one', () => {
    expect(missingEnv({ ...ok, DATABASE_URL: '' })).toEqual(['DATABASE_URL']);
  });

  it('does not require the Socket Mode or OpenRouter variables that the migration retired', () => {
    // Regression guard: re-adding either to REQUIRED_ENV would make every
    // container fail to start on a secret that is correct for Modal.
    expect(missingEnv(ok)).not.toContain('SLACK_APP_TOKEN');
    expect(missingEnv(ok)).not.toContain('OPENROUTER_API_KEY');
  });

  it('does not require SLACK_SIGNING_SECRET — the Python edge verifies, not the worker', () => {
    expect(missingEnv(ok)).not.toContain('SLACK_SIGNING_SECRET');
  });
});

describe('errorNoticeThreadTs', () => {
  const base = { channel: 'D1', text: '', ts: '1.1' };

  it('posts to the main timeline of an unthreaded DM, where the conversation is', () => {
    // Threading here would hide the notice under a message the user is not
    // looking at — the precise failure the notice exists to avoid.
    expect(errorNoticeThreadTs({ ...base })).toBeUndefined();
  });

  it('stays in the thread when the user was already threading a DM', () => {
    expect(errorNoticeThreadTs({ ...base, threadTs: '0.9' })).toBe('0.9');
  });

  it('threads off the triggering message in a channel', () => {
    expect(errorNoticeThreadTs({ ...base, channel: 'C1' })).toBe('1.1');
  });

  it('uses the existing thread for a threaded channel message', () => {
    expect(errorNoticeThreadTs({ ...base, channel: 'C1', threadTs: '0.9' })).toBe('0.9');
  });
});

/** Stand-in for the single WebClient method resolveBotUserId touches. */
function fakeClient(test: () => Promise<{ user_id?: string }>) {
  return { auth: { test: vi.fn(test) } };
}

describe('resolveBotUserId', () => {
  it('serves the cached id without an auth.test round trip', () => {
    // The whole point of the cache: this runs once per Slack message the bot
    // ever receives, to learn a value that cannot change.
    mockKvGet.mockResolvedValue('UCACHED');
    const client = fakeClient(async () => ({ user_id: 'UFRESH' }));

    return resolveBotUserId(client as never).then((id) => {
      expect(id).toBe('UCACHED');
      expect(client.auth.test).not.toHaveBeenCalled();
    });
  });

  it('falls back to auth.test on a miss and caches what it learns', async () => {
    const client = fakeClient(async () => ({ user_id: 'UFRESH' }));

    expect(await resolveBotUserId(client as never)).toBe('UFRESH');
    expect(client.auth.test).toHaveBeenCalledTimes(1);
    const [key, value, ttlMs] = mockKvSet.mock.calls[0];
    expect(key).toBe('slack:bot_user_id');
    expect(value).toBe('UFRESH');
    expect(ttlMs).toBeGreaterThanOrEqual(60 * 60 * 1000);
  });

  it('asks Slack when the cache read throws, rather than losing the id', async () => {
    mockKvGet.mockRejectedValue(new Error('pg down'));
    const client = fakeClient(async () => ({ user_id: 'UFRESH' }));

    expect(await resolveBotUserId(client as never)).toBe('UFRESH');
  });

  it('returns the id even when the cache WRITE fails', async () => {
    mockKvSet.mockRejectedValue(new Error('pg down'));
    const client = fakeClient(async () => ({ user_id: 'UFRESH' }));

    expect(await resolveBotUserId(client as never)).toBe('UFRESH');
  });

  it('degrades to undefined instead of throwing when auth.test fails', async () => {
    // An unstripped `<@UBOT>` in the prompt is cosmetic; refusing the turn is not.
    const client = fakeClient(async () => {
      throw new Error('slack down');
    });

    expect(await resolveBotUserId(client as never)).toBeUndefined();
  });

  it('does not cache an auth.test response with no user_id', async () => {
    const client = fakeClient(async () => ({}));

    expect(await resolveBotUserId(client as never)).toBeUndefined();
    expect(mockKvSet).not.toHaveBeenCalled();
  });
});

describe('isAssistantChannel', () => {
  it('reads the flag the assistant_thread_started invocation wrote', async () => {
    mockKvGet.mockResolvedValue(true);

    expect(await isAssistantChannel('D1')).toBe(true);
    expect(mockKvGet).toHaveBeenCalledWith(assistantKey('D1'));
  });

  it('is false for a channel nothing has marked', async () => {
    expect(await isAssistantChannel('D1')).toBe(false);
  });

  it('is false — not a failed turn — when the lookup throws', async () => {
    // Losing the native status affordance is a cosmetic downgrade; losing the
    // answer is not. See the note on the function.
    mockKvGet.mockRejectedValue(new Error('pg down'));

    expect(await isAssistantChannel('D1')).toBe(false);
  });

  it('keys per channel, so one assistant thread does not mark the workspace', () => {
    expect(assistantKey('D1')).not.toBe(assistantKey('D2'));
  });
});
