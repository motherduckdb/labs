import { describe, it, expect } from 'vitest';
import { parseContextToFragments, parseContextLayerResponse } from './context-parser';

const ID_A = '11111111-1111-1111-1111-111111111111';
const ID_B = '22222222-2222-2222-2222-222222222222';

function makeBlock(opts: {
  title: string;
  id?: string;
  references?: string[];
  content?: string;
}): string {
  const idLine = `_id: ${opts.id ?? ID_A} | by: some-user_`;
  const parts = [`## ${opts.title}`, idLine];
  if (opts.references) parts.push(`References: ${opts.references.join(', ')}`);
  if (opts.content) parts.push(opts.content);
  return parts.join('\n');
}

describe('parseContextToFragments — title-line parsing', () => {
  it('extracts a plain title with no trust status or visibility suffix', () => {
    const input = makeBlock({ title: 'Org schema notes' });
    const [f] = parseContextToFragments(input);
    expect(f.title).toBe('Org schema notes');
    expect(f.trustStatus).toBe('in_development');
    expect(f.accessMode).toBe('ORGANIZATION'); // no (personal) marker → ORGANIZATION
  });

  it('captures trust status from `[status]`', () => {
    const input = makeBlock({ title: 'Endorsed thing [endorsed]' });
    const [f] = parseContextToFragments(input);
    expect(f.title).toBe('Endorsed thing');
    expect(f.trustStatus).toBe('endorsed');
  });

  it('captures `(personal)` visibility as USER accessMode', () => {
    const input = makeBlock({ title: 'My private note (personal)' });
    const [f] = parseContextToFragments(input);
    expect(f.title).toBe('My private note');
    expect(f.accessMode).toBe('USER');
  });

  it('captures BOTH `[status]` and `(personal)` together — PR #58 regression guard', () => {
    // Earlier regex required \s*$ right after [status], so a trailing
    // (visibility) silently collapsed trustStatus to the default
    // 'in_development'. Covered here so the bug can't come back.
    const input = makeBlock({ title: 'Mixed thing [completed] (personal)' });
    const [f] = parseContextToFragments(input);
    expect(f.title).toBe('Mixed thing');
    expect(f.trustStatus).toBe('completed');
    expect(f.accessMode).toBe('USER');
  });

  it('treats a missing (visibility) suffix as ORGANIZATION — the MCP convention', () => {
    // MCP convention: USER fragments render with `(personal)`; ORGANIZATION
    // fragments have no visibility suffix. Defaulting to USER flipped the UI
    // silently after a scope change — the inverse default fixed that.
    const input = makeBlock({ title: 'No visibility suffix [completed]' });
    const [f] = parseContextToFragments(input);
    expect(f.accessMode).toBe('ORGANIZATION');
  });

  it('accepts future visibility labels (anything other than "personal") as ORGANIZATION', () => {
    const input = makeBlock({ title: 'Future thing (team-only)' });
    const [f] = parseContextToFragments(input);
    expect(f.accessMode).toBe('ORGANIZATION');
  });

  it('is case-insensitive on the `(personal)` marker', () => {
    const input = makeBlock({ title: 'T (PERSONAL)' });
    const [f] = parseContextToFragments(input);
    expect(f.accessMode).toBe('USER');
  });
});

describe('parseContextToFragments — id + references + content', () => {
  it('requires an `_id:` line; skips blocks without one', () => {
    const input = '## Orphan\nNo id line here';
    expect(parseContextToFragments(input)).toEqual([]);
  });

  it('captures the UUID from the `_id:` line', () => {
    const input = makeBlock({ title: 'T', id: ID_B });
    const [f] = parseContextToFragments(input);
    expect(f.id).toBe(ID_B);
  });

  it('parses References line as a comma-separated list', () => {
    const input = makeBlock({
      title: 'T',
      references: ['mdw.main.a', 'md:nba.main.b', 'database:x.y.z'],
    });
    const [f] = parseContextToFragments(input);
    expect(f.referencedObjects).toEqual(['mdw.main.a', 'md:nba.main.b', 'database:x.y.z']);
  });

  it('returns an empty references array when no References line is present', () => {
    const input = makeBlock({ title: 'T' });
    const [f] = parseContextToFragments(input);
    expect(f.referencedObjects).toEqual([]);
  });

  it('captures content on lines AFTER the metadata (title / id / references)', () => {
    const input = makeBlock({
      title: 'T',
      references: ['a.b.c'],
      content: 'first line of body\nsecond line of body',
    });
    const [f] = parseContextToFragments(input);
    expect(f.content).toBe('first line of body\nsecond line of body');
  });
});

describe('parseContextToFragments — multi-block responses', () => {
  it('splits on `\\n---\\n` boundaries and returns all fragments', () => {
    const input = [
      makeBlock({ title: 'One', id: ID_A, references: ['a.b.c'], content: 'body 1' }),
      makeBlock({ title: 'Two [endorsed] (personal)', id: ID_B, references: ['x.y.z'], content: 'body 2' }),
    ].join('\n---\n');

    const fragments = parseContextToFragments(input);
    expect(fragments).toHaveLength(2);
    expect(fragments[0].id).toBe(ID_A);
    expect(fragments[1].id).toBe(ID_B);
    expect(fragments[1].trustStatus).toBe('endorsed');
    expect(fragments[1].accessMode).toBe('USER');
  });

  it('ignores empty / whitespace-only blocks between delimiters', () => {
    const input = [
      makeBlock({ title: 'One' }),
      '   ',
      '',
      makeBlock({ title: 'Two', id: ID_B }),
    ].join('\n---\n');
    const fragments = parseContextToFragments(input);
    expect(fragments).toHaveLength(2);
  });

  it('returns an empty array for an empty context string', () => {
    expect(parseContextToFragments('')).toEqual([]);
  });

  it('preserves markdown horizontal rules inside a fragment body (regression: style-guide truncation)', () => {
    // A style-guide-style fragment whose CONTENT contains `---` separators
    // between sections. Naive splitting on `\n---\n` truncated the body to
    // the first chunk; the parser must recognise that the chunks after the
    // first `---` aren't fresh fragments (no `## ` + `_id:` pair) and merge
    // them back into the previous fragment's content.
    const input = makeBlock({
      title: 'canvas_style_guide',
      id: ID_A,
      references: ['database:nba'],
      content: '## Palette\n- accent: #ff5500\n---\n## Typography\n- body: Inter\n---\n## Voice\nFriendly and direct.',
    });
    const fragments = parseContextToFragments(input);
    expect(fragments).toHaveLength(1);
    const body = fragments[0].content as string;
    expect(body).toContain('## Palette');
    expect(body).toContain('## Typography');
    expect(body).toContain('## Voice');
    expect(body).toContain('Friendly and direct.');
    // The `---` HRs themselves are preserved verbatim.
    expect(body.match(/\n---\n/g)?.length).toBe(2);
  });
});

describe('parseContextToFragments — default shape', () => {
  it('fills in source / updatedAt defaults', () => {
    const input = makeBlock({ title: 'T' });
    const [f] = parseContextToFragments(input);
    expect(f.source).toBe('context_layer');
    expect(f.updatedAt).toBe('');
  });
});

describe('parseContextToFragments — createdBy extraction', () => {
  it('captures the username from the `by:` portion of the id line', () => {
    const input = `## T\n_id: ${ID_A} | by: matson_`;
    const [f] = parseContextToFragments(input);
    expect(f.createdBy).toBe('matson');
  });

  it('handles email-style usernames with `@` and dashes', () => {
    const input = `## T\n_id: ${ID_A} | by: mdw-writer@motherduck-com_`;
    const [f] = parseContextToFragments(input);
    expect(f.createdBy).toBe('mdw-writer@motherduck-com');
  });

  it('strips the trailing markdown italics underscore', () => {
    const input = `## T\n_id: ${ID_A} | by: till_`;
    const [f] = parseContextToFragments(input);
    expect(f.createdBy).toBe('till');
  });

  it('falls back to empty string when the by: clause is missing', () => {
    const input = `## T\n_id: ${ID_A}_`;
    const [f] = parseContextToFragments(input);
    expect(f.createdBy).toBe('');
  });
});

describe('parseContextLayerResponse — shape dispatch', () => {
  it('parses the structured-JSON shape (post-2026-05 MCP)', () => {
    const raw = JSON.stringify({
      success: true,
      fragments: [{
        id: ID_A,
        title: 'AWR — Annualized Weekly Revenue',
        content: 'Long markdown content here.',
        visibility: 'ORGANIZATION',
        source: 'context_layer',
        trustStatus: 'endorsed',
        createdBy: 'uuid-here',
        createdByUsername: 'carlin',
        references: ['mdw.computed.daily_organization_awr', 'mdw.orb.revenue_by_day'],
      }],
      fragmentCount: 1,
      truncated: false,
    });
    const [f] = parseContextLayerResponse(raw);
    expect(f.id).toBe(ID_A);
    expect(f.title).toBe('AWR — Annualized Weekly Revenue');
    expect(f.content).toBe('Long markdown content here.');
    expect(f.trustStatus).toBe('endorsed');
    expect(f.accessMode).toBe('ORGANIZATION'); // visibility → accessMode
    expect(f.referencedObjects).toEqual([
      'mdw.computed.daily_organization_awr',
      'mdw.orb.revenue_by_day',
    ]); // references → referencedObjects
    // createdByUsername (human name) is preferred over the uuid createdBy
    // so the UI's MetaRow displays "carlin" instead of a 36-char id.
    expect(f.createdBy).toBe('carlin');
    expect(f.source).toBe('context_layer');
    expect(f.updatedAt).toBe('');
    expect(f.createdAt).toBe('');
  });

  it('treats visibility: "USER" as accessMode: "USER"', () => {
    const raw = JSON.stringify({
      success: true,
      fragments: [{ id: ID_A, title: 'Personal', visibility: 'USER', trustStatus: 'in_development' }],
    });
    const [f] = parseContextLayerResponse(raw);
    expect(f.accessMode).toBe('USER');
  });

  it('defaults to ORGANIZATION when visibility is missing or unknown', () => {
    const raw = JSON.stringify({ success: true, fragments: [{ id: ID_A, title: 'No visibility' }] });
    const [f] = parseContextLayerResponse(raw);
    expect(f.accessMode).toBe('ORGANIZATION');
    expect(f.trustStatus).toBe('in_development');
    expect(f.referencedObjects).toEqual([]);
  });

  it('falls back to the uuid createdBy when no username is provided', () => {
    const raw = JSON.stringify({
      success: true,
      fragments: [{ id: ID_A, title: 'X', createdBy: 'eb112e7f-3df5-48b7-8852-5034840e397f' }],
    });
    const [f] = parseContextLayerResponse(raw);
    expect(f.createdBy).toBe('eb112e7f-3df5-48b7-8852-5034840e397f');
  });

  it('routes the legacy { context: "<markdown>" } wrapper through the markdown parser', () => {
    const md = `## Legacy block [completed]\n_id: ${ID_A} | by: till_\nReferences: mdw.main.events\nbody.`;
    const raw = JSON.stringify({ context: md });
    const [f] = parseContextLayerResponse(raw);
    expect(f.id).toBe(ID_A);
    expect(f.title).toBe('Legacy block');
    expect(f.trustStatus).toBe('completed');
    expect(f.createdBy).toBe('till');
    expect(f.referencedObjects).toEqual(['mdw.main.events']);
  });

  it('routes bare markdown (no wrapper, not JSON) through the markdown parser', () => {
    const md = `## Bare md\n_id: ${ID_A} | by: some-user_`;
    const [f] = parseContextLayerResponse(md);
    expect(f.id).toBe(ID_A);
    expect(f.title).toBe('Bare md');
  });

  it('returns an empty array for an empty input', () => {
    expect(parseContextLayerResponse('')).toEqual([]);
  });

  it('returns an empty array when the JSON has no fragments and no context field', () => {
    const raw = JSON.stringify({ success: false, error: 'something went wrong' });
    expect(parseContextLayerResponse(raw)).toEqual([]);
  });

  it('dedupes nothing on its own — caller is responsible (regression guard for the merge loop)', () => {
    // Mirrors what the route does: each `reference` queried separately may
    // return overlapping fragments. The parser shouldn't dedupe; the route's
    // seen-set in queryContextLayerForDb already covers that contract.
    const raw = JSON.stringify({
      success: true,
      fragments: [
        { id: ID_A, title: 'one' },
        { id: ID_A, title: 'one (dupe)' },
      ],
    });
    expect(parseContextLayerResponse(raw)).toHaveLength(2);
  });
});
