import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebClient } from '@slack/web-api';

// Control the table/chart classification + PNG rendering so each test drives a
// deterministic branch.
vi.mock('./viz', () => ({
  classifyMvizBlock: vi.fn(),
  tableBlockToMarkdown: vi.fn(),
}));
vi.mock('./screenshot', () => ({
  renderHtmlToPng: vi.fn(),
}));

import { SlackTurnSink } from './sink';
import { classifyMvizBlock, tableBlockToMarkdown } from './viz';
import { renderHtmlToPng } from './screenshot';

const mockClassify = vi.mocked(classifyMvizBlock);
const mockTableMd = vi.mocked(tableBlockToMarkdown);
const mockRender = vi.mocked(renderHtmlToPng);

interface UpdateArg {
  channel: string;
  ts: string;
  text?: string;
  blocks?: object[];
}

function makeClient() {
  const attempts: UpdateArg[] = []; // every update attempt, including thrown
  const updates: UpdateArg[] = []; // successful updates only
  const posts: Array<{ channel: string; thread_ts?: string; text?: string }> = [];
  const uploads: Array<{ channel_id: string; thread_ts?: string; file: Buffer; filename: string }> = [];
  const statuses: Array<{ status: string }> = [];

  let postSeq = 0;
  const client = {
    chat: {
      update: vi.fn(async (a: UpdateArg) => {
        attempts.push(a);
        updates.push(a);
        return { ts: a.ts };
      }),
      postMessage: vi.fn(async (a: { channel: string; thread_ts?: string; text?: string }) => {
        posts.push(a);
        postSeq += 1;
        return { ts: `cont-${postSeq}` };
      }),
    },
    files: {
      uploadV2: vi.fn(async (a: { channel_id: string; thread_ts?: string; file: Buffer; filename: string }) => {
        uploads.push(a);
        return {};
      }),
    },
    assistant: {
      threads: {
        setStatus: vi.fn(async (a: { status: string }) => {
          statuses.push(a);
          return {};
        }),
      },
    },
  };

  return { client: client as unknown as WebClient, attempts, updates, posts, uploads, statuses };
}

function makeSink(client: WebClient, extra?: { isAssistant?: boolean; threadTs?: string }) {
  return new SlackTurnSink({
    client,
    channel: 'C1',
    threadTs: extra?.threadTs ?? 'T1',
    placeholderTs: 'P1',
    isAssistant: extra?.isAssistant,
  });
}

describe('SlackTurnSink throttling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('defers the first interim update behind the throttle and coalesces rapid text', async () => {
    const { client, updates } = makeClient();
    const sink = makeSink(client);

    sink.onText('hello');
    expect(updates.length).toBe(0); // throttled, not immediate

    await vi.advanceTimersByTimeAsync(1500);
    expect(updates.length).toBe(1);
    expect(updates[0].text).toContain('hello');

    // Three quick deltas within the window collapse into a single update.
    sink.onText(' a');
    sink.onText(' b');
    sink.onText(' c');
    expect(updates.length).toBe(1);

    await vi.advanceTimersByTimeAsync(1500);
    expect(updates.length).toBe(2);
    expect(updates[1].text).toContain('hello a b c');
  });
});

describe('SlackTurnSink final render + splitting', () => {
  it('splits an over-cap final message into a continuation and uses markdown blocks', async () => {
    const { client, updates, posts } = makeClient();
    const sink = makeSink(client);

    sink.onText('x'.repeat(13000));
    await sink.finalize();

    // One continuation posted (13000 > 12000 cap).
    expect(posts.length).toBe(1);
    // Final updates carry markdown blocks + a text fallback.
    const finalUpdates = updates.filter((u) => u.blocks);
    expect(finalUpdates.length).toBeGreaterThanOrEqual(1);
    for (const u of finalUpdates) {
      for (const b of u.blocks as Array<{ text: string }>) {
        expect(b.text.length).toBeLessThanOrEqual(12000);
      }
    }
  });

  it('retries the final message as plain text when the blocks update fails (any error)', async () => {
    const { client, attempts } = makeClient();
    // Reject the blocks update with a NON-invalid_blocks error (e.g. the API
    // complaining the message is too long) — the retry must still fire.
    (client.chat.update as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (a: UpdateArg) => {
        attempts.push(a);
        if (a.blocks) {
          const err = new Error('msg_too_long') as Error & { data?: { error: string } };
          err.data = { error: 'msg_too_long' };
          throw err;
        }
        return { ts: a.ts };
      },
    );
    const sink = makeSink(client);
    sink.onText('some answer');
    await sink.finalize();

    const withBlocks = attempts.filter((a) => a.blocks);
    expect(withBlocks.length).toBe(1); // exactly one blocks attempt (the final)
    // The last attempt is the plain-text retry carrying the answer.
    const last = attempts[attempts.length - 1];
    expect(last.blocks).toBeUndefined();
    expect(last.text).toContain('some answer');
  });

  it('keeps the head intact in the placeholder when continuation posts fail (finding 3)', async () => {
    const { client, updates, posts } = makeClient();
    // Every fresh post fails; the placeholder update must still succeed so the
    // head chunk is never clobbered or dropped.
    (client.chat.postMessage as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('rate_limited'),
    );
    const sink = makeSink(client);
    sink.onText('z'.repeat(26000)); // splits into 3 chunks (placeholder + 2 posts)
    await sink.finalize();

    // The placeholder (chunk 0) was updated with real content, not truncated
    // away or overwritten by a later chunk.
    const finalUpdates = updates.filter((u) => u.blocks);
    expect(finalUpdates.length).toBeGreaterThanOrEqual(1);
    const headText = (finalUpdates[0].blocks as Array<{ text: string }>).map((b) => b.text).join('');
    expect(headText.length).toBeGreaterThan(1000);
    expect(headText.startsWith('z')).toBe(true);
    expect(posts.length).toBe(0); // all continuation posts failed (and were logged)
  });

  it('re-posts the answer as a fresh message when the placeholder update fails (item A)', async () => {
    const { client, posts } = makeClient();
    // Simulate the placeholder having been deleted — every update rejects, but
    // posting works. The answer must land as a fresh message, never dropped.
    (client.chat.update as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('message_not_found'),
    );
    const sink = makeSink(client);
    sink.onText('the whole answer');
    await sink.finalize();

    expect(posts.some((p) => (p.text ?? '').includes('the whole answer'))).toBe(true);
  });

  it('sends the FULL chunk (not the 3.9k notification fallback) when blocks are rejected', async () => {
    const { client, attempts } = makeClient();
    // Reject blocks; accept plain text. The plain-text retry must carry the
    // full ~9k answer, not the truncated notification fallback.
    (client.chat.update as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (a: UpdateArg) => {
        attempts.push(a);
        if (a.blocks) throw new Error('invalid_blocks');
        return { ts: a.ts };
      },
    );
    const sink = makeSink(client);
    sink.onText('q'.repeat(9000));
    await sink.finalize();

    const textRetry = attempts.filter((a) => !a.blocks && (a.text ?? '').length > 4000);
    expect(textRetry.length).toBeGreaterThanOrEqual(1); // full content, not truncated to 3.9k
  });

  it('caps the plain-text retry when toMrkdwn expands a table chunk past the text limit (finding 1)', async () => {
    const { client, attempts } = makeClient();
    // Reject blocks so the plain-text path (which runs toMrkdwn) is exercised.
    (client.chat.update as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (a: UpdateArg) => {
        attempts.push(a);
        if (a.blocks) throw new Error('invalid_blocks');
        return { ts: a.ts };
      },
    );
    // A sparse wide table: one 600-char cell per column forces every other cell
    // in that column to pad to 600 — a ~5k markdown chunk that toMrkdwn expands
    // well past Slack's 40k text cap.
    const cols = 8;
    const row = (fill: string) => `| ${Array(cols).fill(fill).join(' | ')} |`;
    const table = [
      row('h'),
      `| ${Array(cols).fill('---').join(' | ')} |`,
      row('X'.repeat(600)),
      ...Array(60).fill(row('1')),
    ].join('\n');

    const sink = makeSink(client);
    sink.onText(table);
    await sink.finalize();

    const textSends = attempts.filter((a) => !a.blocks && a.text);
    expect(textSends.length).toBeGreaterThanOrEqual(1);
    for (const a of textSends) {
      expect((a.text ?? '').length).toBeLessThanOrEqual(38000); // capped under Slack's limit
    }
    expect(textSends.some((a) => (a.text ?? '').includes('truncated'))).toBe(true);
  });

  it('caps the interim update text when a small table expands past the limit after conversion', async () => {
    const { client, updates } = makeClient();
    // Full table well under the 3.9k markdown interim cap, but toMrkdwn's cell
    // padding expands it past Slack's text limit on the interim repaint.
    const cols = 8;
    const row = (fill: string) => `| ${Array(cols).fill(fill).join(' | ')} |`;
    const table = [
      row('h'),
      `| ${Array(cols).fill('---').join(' | ')} |`,
      row('X'.repeat(400)),
      ...Array(15).fill(row('1')),
    ].join('\n');
    expect(table.length).toBeLessThan(3900); // stays within the interim markdown cap

    const sink = makeSink(client);
    sink.onText(table);
    await sink.finalize();

    // Interim updates are text-only (no blocks); every one must be within limit.
    const interimSends = updates.filter((u) => !u.blocks && u.text);
    expect(interimSends.length).toBeGreaterThanOrEqual(1);
    for (const u of interimSends) {
      expect((u.text ?? '').length).toBeLessThanOrEqual(38000);
    }
    expect(interimSends.some((u) => (u.text ?? '').includes('truncated'))).toBe(true);
  });

  it('retries once, then records a dropped chunk and warns when posting keeps failing (finding 2)', async () => {
    const { client } = makeClient();
    (client.chat.update as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('message_not_found'),
    );
    const warnPosts: Array<{ text?: string }> = [];
    (client.chat.postMessage as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (a: { text?: string }) => {
        if ((a.text ?? '').includes('failed to post')) {
          warnPosts.push(a);
          return { ts: 'warn' };
        }
        throw new Error('rate_limited'); // every content post fails
      },
    );
    const sink = new SlackTurnSink({
      client,
      channel: 'C',
      threadTs: 'T',
      placeholderTs: 'P',
      postRetryDelayMs: 0, // no real delay in tests
    });
    sink.onText('an answer that cannot be delivered');
    await sink.finalize();

    expect(sink.getDroppedChunks()).toBe(1); // loss is observable, not silent
    expect(warnPosts.length).toBe(1); // best-effort "part of this answer failed" note
  });

  it('completion-based throttle: a slow update never overlaps the next', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const seen: UpdateArg[] = [];
      let release: () => void = () => {};
      const client = {
        chat: {
          update: vi.fn((a: UpdateArg) => {
            seen.push(a);
            return new Promise<{ ts?: string }>((resolve) => {
              release = () => resolve({ ts: a.ts });
            });
          }),
          postMessage: vi.fn(async () => ({ ts: 'cont' })),
        },
        files: { uploadV2: vi.fn(async () => ({})) },
        assistant: { threads: { setStatus: vi.fn(async () => ({})) } },
      } as unknown as WebClient;
      const sink = new SlackTurnSink({ client, channel: 'C', threadTs: 'T', placeholderTs: 'P' });

      sink.onText('a');
      await vi.advanceTimersByTimeAsync(1500); // first update starts, then blocks
      expect(seen.length).toBe(1);

      sink.onText('b');
      sink.onText('c');
      await vi.advanceTimersByTimeAsync(10_000); // lots of time, but #1 still in flight
      expect(seen.length).toBe(1); // no overlap

      release(); // #1 completes → lastUpdateAt stamped on completion
      await vi.advanceTimersByTimeAsync(0); // flush finally + arm trailing timer
      await vi.advanceTimersByTimeAsync(1500); // throttle-from-completion elapses
      expect(seen.length).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('caps the notification fallback text well under Slack limits', async () => {
    const { client, attempts } = makeClient();
    (client.chat.update as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (a: UpdateArg) => {
        attempts.push(a);
        return { ts: a.ts };
      },
    );
    const sink = makeSink(client);
    sink.onText('y'.repeat(9000)); // one line, no split, but large
    await sink.finalize();

    const finalBlocks = attempts.filter((a) => a.blocks);
    expect(finalBlocks.length).toBeGreaterThanOrEqual(1);
    for (const a of finalBlocks) {
      expect((a.text ?? '').length).toBeLessThanOrEqual(3900);
    }
  });
});

describe('SlackTurnSink mviz dispatch', () => {
  beforeEach(() => {
    mockClassify.mockReset();
    mockTableMd.mockReset();
    mockRender.mockReset();
  });

  it('splices a table into the message and never uploads an image', async () => {
    mockClassify.mockReturnValue('table');
    mockTableMd.mockReturnValue('| A |\n| --- |\n| 1 |');
    const { client, updates, uploads } = makeClient();
    const sink = makeSink(client);

    sink.onText('Here is the table:');
    sink.onMvizPending('m1');
    sink.onMvizBlock({ id: 'm1', source: '```table\n{}\n```', html: '<div/>' });
    await sink.finalize();

    expect(uploads.length).toBe(0);
    const last = updates[updates.length - 1];
    const joined = (last.blocks as Array<{ text: string }>).map((b) => b.text).join('\n');
    expect(joined).toContain('| A |');
    expect(joined).not.toContain('MVIZ:'); // marker fully resolved
  });

  it('splits the final message correctly when a fence resolved to a table mid-stream (finding 4)', async () => {
    mockClassify.mockReturnValue('table');
    mockTableMd.mockReturnValue('| col |\n| --- |\n| v |');
    const { client, updates, posts } = makeClient();
    const sink = makeSink(client);

    // Marker sits between two large text runs; total resolved body exceeds the
    // 12k final cap, forcing a split AFTER the marker has collapsed to a table.
    sink.onText('A'.repeat(7000));
    sink.onMvizPending('m1');
    sink.onText('B'.repeat(7000));
    sink.onMvizBlock({ id: 'm1', source: '```table\n{}\n```', html: '<div/>' });
    await sink.finalize();

    expect(posts.length).toBe(1); // split into placeholder + one continuation
    const allText = updates
      .flatMap((u) => (u.blocks ? (u.blocks as Array<{ text: string }>).map((b) => b.text) : [u.text ?? '']))
      .join('\n');
    expect(allText).not.toContain('@@MVIZ'); // no marker leaked into any message
    expect(allText).toContain('| col |'); // the table survived intact
  });

  it('renders a chart to PNG and uploads it, leaving no marker in the text', async () => {
    mockClassify.mockReturnValue('chart');
    mockRender.mockResolvedValue(Buffer.from('png-bytes'));
    const { client, updates, uploads } = makeClient();
    const sink = makeSink(client);

    sink.onText('Here is the chart:');
    sink.onMvizPending('c1');
    sink.onMvizBlock({ id: 'c1', source: '```bar\n{}\n```', html: '<div/>' });
    await sink.finalize();

    expect(uploads.length).toBe(1);
    expect(uploads[0].filename).toBe('chart.png');
    expect(uploads[0].file).toBeInstanceOf(Buffer);
    const last = updates[updates.length - 1];
    const joined = (last.blocks as Array<{ text: string }>).map((b) => b.text).join('\n');
    expect(joined).not.toContain('MVIZ:');
  });

  it('recovers a table from a fallback block that still carries real source', async () => {
    mockClassify.mockReturnValue('table');
    mockTableMd.mockReturnValue('| A |\n| --- |\n| 1 |');
    const { client, updates, uploads } = makeClient();
    const sink = makeSink(client);

    sink.onMvizPending('m1');
    // fallback: true but source is present — the HTML render failed upstream,
    // yet the table spec is intact and should be recovered natively.
    sink.onMvizBlock({ id: 'm1', source: '```table\n{}\n```', html: '<error/>', fallback: true });
    await sink.finalize();

    expect(mockRender).not.toHaveBeenCalled();
    expect(uploads.length).toBe(0);
    const last = updates[updates.length - 1];
    const joined = (last.blocks as Array<{ text: string }>).map((b) => b.text).join('\n');
    expect(joined).toContain('| A |');
  });

  it('shows an error note for a non-table fallback without launching the renderer', async () => {
    mockClassify.mockReturnValue('chart');
    const { client, updates, uploads } = makeClient();
    const sink = makeSink(client);

    sink.onMvizPending('c1');
    sink.onMvizBlock({ id: 'c1', source: '```bar\n{}\n```', html: '<error/>', fallback: true });
    await sink.finalize();

    expect(mockRender).not.toHaveBeenCalled(); // no Chromium for an error card
    expect(uploads.length).toBe(0);
    const last = updates[updates.length - 1];
    const joined = (last.blocks as Array<{ text: string }>).map((b) => b.text).join('\n');
    expect(joined).toContain('chart failed to render');
  });

  it('replaces the marker with an error note when the chart fails to render', async () => {
    mockClassify.mockReturnValue('chart');
    mockRender.mockRejectedValue(new Error('no chromium'));
    const { client, updates, uploads } = makeClient();
    const sink = makeSink(client);

    sink.onMvizPending('c1');
    sink.onMvizBlock({ id: 'c1', source: '```bar\n{}\n```', html: '<div/>' });
    await sink.finalize();

    expect(uploads.length).toBe(0);
    const last = updates[updates.length - 1];
    const joined = (last.blocks as Array<{ text: string }>).map((b) => b.text).join('\n');
    expect(joined).toContain('chart failed to render');
  });
});

describe('SlackTurnSink finalize ordering', () => {
  beforeEach(() => {
    mockClassify.mockReset();
    mockRender.mockReset();
  });

  it('awaits pending chart uploads before finalize resolves', async () => {
    mockClassify.mockReturnValue('chart');
    let releaseRender: (buf: Buffer) => void = () => {};
    mockRender.mockReturnValue(
      new Promise<Buffer>((resolve) => {
        releaseRender = resolve;
      }),
    );
    const { client, uploads } = makeClient();
    const sink = makeSink(client);

    sink.onMvizPending('c1');
    sink.onMvizBlock({ id: 'c1', source: '```bar\n{}\n```', html: '<div/>' });

    let finalized = false;
    const finalizeP = sink.finalize().then(() => {
      finalized = true;
    });

    await Promise.resolve();
    expect(finalized).toBe(false); // still blocked on the upload
    expect(uploads.length).toBe(0);

    releaseRender(Buffer.from('png'));
    await finalizeP;
    expect(finalized).toBe(true);
    expect(uploads.length).toBe(1);
  });
});

describe('SlackTurnSink error handling', () => {
  it('appends a warning-prefixed error to the final message', async () => {
    const { client, updates } = makeClient();
    const sink = makeSink(client);
    sink.onText('partial answer');
    sink.onError('the model stopped early');
    await sink.finalize();

    const last = updates[updates.length - 1];
    const joined = (last.blocks as Array<{ text: string }>).map((b) => b.text).join('\n');
    expect(joined).toContain(':warning:');
    expect(joined).toContain('the model stopped early');
  });

  it('never throws into the loop when a Slack call rejects', async () => {
    const { client } = makeClient();
    (client.chat.update as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('network'));
    const sink = makeSink(client);
    sink.onText('hi');
    // finalize must resolve despite the update rejecting.
    await expect(sink.finalize()).resolves.toBeUndefined();
  });
});
