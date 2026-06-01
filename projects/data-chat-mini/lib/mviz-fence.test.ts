import { describe, it, expect } from 'vitest';
import {
  createMvizFenceState,
  stepMvizFence,
  flushMvizFence,
  findNextMvizBlock,
  findFenceOpener,
  buildMvizFallbackHtml,
  type MvizFenceState,
  type MvizFenceEvent,
} from './mviz-fence';
import { MAX_MVIZ_OPENER_LEN } from './mviz-types';

type TextEvent = Extract<MvizFenceEvent, { kind: 'text' }>;
type PendingEvent = Extract<MvizFenceEvent, { kind: 'mviz_pending' }>;
type BlockEvent = Extract<MvizFenceEvent, { kind: 'mviz_block' }>;
type FallbackEvent = Extract<MvizFenceEvent, { kind: 'mviz_fallback' }>;

const isText = (e: MvizFenceEvent): e is TextEvent => e.kind === 'text';
const isPending = (e: MvizFenceEvent): e is PendingEvent => e.kind === 'mviz_pending';
const isBlock = (e: MvizFenceEvent): e is BlockEvent => e.kind === 'mviz_block';
const isFallback = (e: MvizFenceEvent): e is FallbackEvent => e.kind === 'mviz_fallback';

// Deterministic id generator for assertions. Mirrors the default randomUUID
// contract (each call returns a unique string) without the nondeterminism.
function makeIdFactory(prefix = 'id'): () => string {
  let n = 0;
  return () => `${prefix}-${n++}`;
}

// Helper: drain one streaming session by calling stepMvizFence once per
// cumulative text chunk. Returns the ordered event list across all steps plus
// the final state (before flush).
function runStream(chunks: string[], initial?: MvizFenceState) {
  let state = initial ?? createMvizFenceState();
  const makeId = makeIdFactory();
  const allEvents: MvizFenceEvent[] = [];
  let cumulative = '';
  for (const chunk of chunks) {
    cumulative += chunk;
    const { events, newState } = stepMvizFence(cumulative, state, makeId);
    state = newState;
    allEvents.push(...events);
  }
  return { events: allEvents, state, cumulative };
}

// Full drain: step then flush. Mirrors the route.ts handler's end-of-stream
// behavior so test assertions don't need to account for the opener
// lookahead (MAX_MVIZ_OPENER_LEN bytes) held back by step().
function drainStream(chunks: string[], initial?: MvizFenceState) {
  const { events, state, cumulative } = runStream(chunks, initial);
  const { events: flushEvents, newState } = flushMvizFence(cumulative, state);
  return { events: [...events, ...flushEvents], state: newState, cumulative };
}

describe('findNextMvizBlock', () => {
  it('returns null when no complete block exists', () => {
    expect(findNextMvizBlock('hello world', 0)).toBeNull();
    expect(findNextMvizBlock('```table\n{"a":1}\n', 0)).toBeNull(); // no closer
  });

  it('finds a complete block and reports its source + end index', () => {
    const text = 'pre ```table\n{"rows":[]}\n``` post';
    const match = findNextMvizBlock(text, 0);
    expect(match).not.toBeNull();
    expect(match!.source).toBe('```table\n{"rows":[]}\n```');
    expect(text.slice(match!.end)).toBe(' post');
  });

  it('respects the `from` index', () => {
    const text = '```table\n{}\n```\n---\n```table\n{"x":1}\n```';
    const first = findNextMvizBlock(text, 0)!;
    expect(first.source).toContain('{}');
    const second = findNextMvizBlock(text, first.end)!;
    expect(second.source).toContain('{"x":1}');
  });

  it('matches each enabled chart type', () => {
    for (const type of ['table', 'bar', 'line', 'dumbbell']) {
      const text = `pre \`\`\`${type} size=[8,4]\n{"data":[]}\n\`\`\` post`;
      const match = findNextMvizBlock(text, 0);
      expect(match, type).not.toBeNull();
      expect(match!.source).toContain(`\`\`\`${type}`);
    }
  });

  it('does not match a non-enabled type (e.g. ```pie) or look-alike identifiers', () => {
    expect(findNextMvizBlock('```pie\n{}\n```', 0)).toBeNull();
    // `barchart` must not match as `bar` (word-boundary guard) — in either the
    // opener scan OR the completed-block matcher, else streaming skips the
    // opener while the block matcher pairs it and renders an unsupported type.
    expect(findFenceOpener('```barchart\n', 0)).toBeNull();
    expect(findNextMvizBlock('```barchart\n{"x":1}\n```', 0)).toBeNull();
    expect(findNextMvizBlock('```liner\n{"x":1}\n```', 0)).toBeNull();
  });

  it('rejects punctuation-suffix look-alikes (```bar-chart)', () => {
    expect(findFenceOpener('```bar-chart\n', 0)).toBeNull();
    expect(findNextMvizBlock('```bar-chart\n{}\n```', 0)).toBeNull();
  });

  it('leaves a look-alike fence (```barchart) as raw text through the full stream', () => {
    const text = 'intro\n```barchart\n{"x":1}\n```\nend.';
    const { events } = drainStream([text]);
    // No pending, no block — the whole thing forwards as plain text.
    expect(events.filter(isPending)).toHaveLength(0);
    expect(events.filter(isBlock)).toHaveLength(0);
    const joined = events.filter(isText).map(e => e.content).join('');
    expect(joined).toContain('```barchart');
  });

  it('does not emit a premature pending for a look-alike split mid-type (```bar | chart...)', () => {
    // The unsupported `barchart` fence is split so the first chunk ends exactly
    // at `bar`. End-of-buffer must NOT count as a header boundary, else we emit
    // an mviz_pending that orphans into a fallback iframe once `chart` arrives.
    const chunks = ['intro\n```bar', 'chart\n{"x":1}\n```\nend.'];
    const { events } = drainStream(chunks);
    expect(events.filter(isPending)).toHaveLength(0);
    expect(events.filter(isBlock)).toHaveLength(0);
    expect(events.filter(isFallback)).toHaveLength(0);
    const joined = events.filter(isText).map(e => e.content).join('');
    expect(joined).toContain('```barchart');
  });
});

describe('findFenceOpener', () => {
  it('reports variable opener length per type', () => {
    expect(findFenceOpener('```bar size=[8,4]\n', 0)).toEqual({ index: 0, length: 6 });
    expect(findFenceOpener('```dumbbell\n', 0)).toEqual({ index: 0, length: 11 });
  });
});

describe('buildMvizFallbackHtml', () => {
  it('escapes HTML special characters in the reason', () => {
    const html = buildMvizFallbackHtml('uh <oh> & "trouble"');
    expect(html).toContain('&lt;oh&gt;');
    expect(html).toContain('&amp;');
    // Double quotes are not part of the class escape set — verify they land as-is.
    expect(html).toContain('"trouble"');
  });
});

describe('stepMvizFence — plain text path', () => {
  it('emits all plain text (post-flush) when text contains no fence', () => {
    const text = 'hello, this is a plain message with no table block.';
    const { events } = drainStream([text]);
    const joined = events.filter(isText).map(e => e.content).join('');
    expect(joined).toBe(text);
  });

  it('holds back the opener-lookahead window mid-stream to avoid leaking a partial opener', () => {
    const { events, cumulative } = runStream(['hello world ```dumbbel']);
    const textEvents = events.filter(isText);
    const joined = textEvents.map(e => e.content).join('');
    // The partial "```dumbbel" prefix must be held back (MAX_MVIZ_OPENER_LEN lookahead).
    expect(joined.length).toBe(cumulative.length - MAX_MVIZ_OPENER_LEN);
    expect(joined).toBe(cumulative.slice(0, cumulative.length - MAX_MVIZ_OPENER_LEN));
  });

  it('releases held-back text once more bytes arrive past the opener region', () => {
    const chunks = ['one two ', 'three four five six seven eight'];
    const { events } = runStream(chunks);
    const joined = events.filter(isText).map(e => e.content).join('');
    // All but the trailing lookahead window should have been emitted.
    const fullText = chunks.join('');
    expect(joined).toBe(fullText.slice(0, fullText.length - MAX_MVIZ_OPENER_LEN));
  });
});

describe('stepMvizFence — fence handling', () => {
  it('emits mviz_pending on opener and suppresses fence body until close', () => {
    const text =
      'Here is a table.\n\n```table\n{"rows":[1,2,3]}\n```\n\nEnd of message.';
    const { events } = drainStream([text]);
    const kinds = events.map(e => e.kind);

    // Must contain exactly one pending and one block.
    expect(kinds.filter(k => k === 'mviz_pending')).toHaveLength(1);
    expect(kinds.filter(k => k === 'mviz_block')).toHaveLength(1);

    // Text events must NOT include any raw fence body (no `"rows":[1,2,3]`).
    const joined = events.filter(isText).map(e => e.content).join('');
    expect(joined).not.toContain('rows');
    expect(joined).not.toContain('```table');

    // Pre- and post-fence text is forwarded in full after flush.
    expect(joined).toContain('Here is a table.');
    expect(joined).toContain('End of message.');
  });

  it('pairs placeholder ids with blocks FIFO across multiple fences', () => {
    const text =
      'First:\n```table\n{"a":1}\n```\n' +
      'Middle text between blocks.\n' +
      'Second:\n```table\n{"b":2}\n```\n' +
      'done end of message.';
    const { events } = drainStream([text]);
    const pendings = events.filter(isPending);
    const blocks = events.filter(isBlock);
    expect(pendings).toHaveLength(2);
    expect(blocks).toHaveLength(2);
    // FIFO: first pending id matches first block id, second matches second.
    expect(blocks[0].id).toBe(pendings[0].id);
    expect(blocks[1].id).toBe(pendings[1].id);
    // Sources are in text order.
    expect(blocks[0].source).toContain('{"a":1}');
    expect(blocks[1].source).toContain('{"b":2}');
  });

  it('handles fences split across multiple stream chunks', () => {
    const chunks = [
      'look at this:\n```ta',
      'ble\n{"rows":[',
      '1,2]}\n`',
      '``\nend text.',
    ];
    const { events } = runStream(chunks);
    const kinds = events.map(e => e.kind);
    expect(kinds).toContain('mviz_pending');
    expect(kinds).toContain('mviz_block');
    const block = events.find(isBlock)!;
    expect(block.source).toBe('```table\n{"rows":[1,2]}\n```');
  });

  it('streams a chart block split across chunks (bar) and suppresses its body', () => {
    const chunks = [
      'here is the comparison:\n```ba',
      'r size=[8,4]\n{"data":[{"x":"a","y":1}',
      ']}\n`',
      '``\nthat is the chart.',
    ];
    const { events } = runStream(chunks);
    const block = events.find(isBlock)!;
    expect(block.source).toBe('```bar size=[8,4]\n{"data":[{"x":"a","y":1}]}\n```');
    const joined = events.filter(isText).map(e => e.content).join('');
    expect(joined).not.toContain('"data"');
    expect(joined).not.toContain('```bar');
  });

  it('renders adjacent blocks of mixed types FIFO (line then dumbbell)', () => {
    const text =
      'Trend:\n```line\n{"series":[1]}\n```\n' +
      'Gap:\n```dumbbell\n{"pairs":[2]}\n```\n' +
      'done.';
    const { events } = drainStream([text]);
    const blocks = events.filter(isBlock);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].source).toContain('```line');
    expect(blocks[1].source).toContain('```dumbbell');
  });
});

describe('flushMvizFence — end-of-stream', () => {
  it('emits trailing text that was held back by the opener lookahead', () => {
    const text = 'short tail';
    const { events: stepEvents, state, cumulative } = runStream([text]);
    const { events: flushEvents } = flushMvizFence(cumulative, state);
    const allText = [...stepEvents, ...flushEvents]
      .filter(isText)
      .map(e => e.content)
      .join('');
    expect(allText).toBe(text);
  });

  it('emits an mviz_fallback when the stream is cut off mid-fence', () => {
    // Opener arrives but the closer never does — typical "stream timed out"
    // shape. The pending placeholder id must get a fallback on flush so the
    // client doesn't show a permanent "Visualizing…" pill.
    const text = 'intro text\n```table\n{"rows":[1,2';
    const { state, cumulative } = runStream([text]);
    const { events } = flushMvizFence(cumulative, state);
    const fallbacks = events.filter(isFallback);
    expect(fallbacks).toHaveLength(1);
    expect(typeof fallbacks[0].id).toBe('string');
  });

  it('does not emit trailing text while still inside an open fence', () => {
    const text = 'intro\n```table\n{"rows":[1';
    const { state, cumulative } = runStream([text]);
    const { events } = flushMvizFence(cumulative, state);
    const textEvents = events.filter(isText);
    expect(textEvents).toHaveLength(0);
  });

  it('clears openFenceStart on flush even when still inside a fence', () => {
    const text = '```table\n{"rows":[1';
    const { state, cumulative } = runStream([text]);
    const { newState } = flushMvizFence(cumulative, state);
    expect(newState.openFenceStart).toBeNull();
  });
});

describe('stepMvizFence — idempotence & cache-stability', () => {
  it('repeated calls on the same fullText + state return no new events', () => {
    const text = 'hello ```table\n{}\n``` world.';
    let state = createMvizFenceState();
    const makeId = makeIdFactory();

    const first = stepMvizFence(text, state, makeId);
    state = first.newState;
    const second = stepMvizFence(text, state, makeId);

    // Second call sees no new bytes → no events, state unchanged.
    expect(second.events).toHaveLength(0);
    expect(second.newState).toEqual(first.newState);
  });
});
