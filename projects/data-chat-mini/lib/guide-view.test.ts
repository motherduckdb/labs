import { describe, expect, it } from 'vitest';
import { mergeRelatedGuides, countSidebarGuides, type GuideSummary } from './guide-view';

const g = (uuid: string, topic = ''): GuideSummary => ({
  uuid,
  topic,
  title: `Guide ${uuid}`,
  description: '',
  access: 'user',
});

describe('mergeRelatedGuides', () => {
  it('puts related guides first and appends unmatched text matches', () => {
    const merged = mergeRelatedGuides([g('r1', 'foo')], [g('t1'), g('t2')]);
    expect(merged.map((x) => x.uuid)).toEqual(['r1', 't1', 't2']);
  });

  it('dedupes by uuid with the related entry winning', () => {
    const related = { ...g('dup', 'foo'), title: 'related version' };
    const text = { ...g('dup'), title: 'text version' };
    const merged = mergeRelatedGuides([related], [text, g('t1')]);
    expect(merged).toHaveLength(2);
    expect(merged[0].title).toBe('related version');
  });

  it('handles empty inputs', () => {
    expect(mergeRelatedGuides([], [])).toEqual([]);
    expect(mergeRelatedGuides([], [g('a')])).toHaveLength(1);
    expect(mergeRelatedGuides([g('a')], [])).toHaveLength(1);
  });
});

describe('countSidebarGuides', () => {
  it('adds card count and topic counts when there is no overlap', () => {
    expect(countSidebarGuides([g('a')], [{ topic: 'foo', guide_count: 2 }])).toBe(3);
  });

  it('subtracts a displayed guide whose topic is a visible topic row', () => {
    expect(countSidebarGuides([g('a', 'foo')], [{ topic: 'foo', guide_count: 2 }])).toBe(2);
  });

  it('never subtracts for empty-topic (root) guides', () => {
    expect(countSidebarGuides([g('a', '')], [{ topic: 'foo', guide_count: 1 }])).toBe(2);
  });

  it('clamps when the overlap heuristic exceeds a topic count (documented imprecision)', () => {
    // Two displayed guides share one topic whose aggregate count is 1 — the
    // subtraction over-shoots and the clamp floors the topic contribution at
    // 0, so the total is the card count alone. Best-effort by design: topic
    // rows expose only aggregate guide_count, not uuid membership.
    expect(countSidebarGuides([g('a', 'foo'), g('b', 'foo')], [{ topic: 'foo', guide_count: 1 }])).toBe(2);
  });
});
