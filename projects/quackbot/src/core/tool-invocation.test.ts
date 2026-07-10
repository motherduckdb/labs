import { describe, expect, it } from 'vitest';
import { applyToolArgDefaults, detectPayloadFailure } from './tool-invocation';

describe('applyToolArgDefaults', () => {
  it('defaults include_org_shares on list_dives', () => {
    expect(applyToolArgDefaults('list_dives', {})).toEqual({ include_org_shares: true });
    expect(applyToolArgDefaults('list_dives', { include_org_shares: false })).toEqual({
      include_org_shares: false,
    });
  });

  it('strips GPT-style empty-string padding from list_guides args (observed live)', () => {
    // gpt-5.6-luna filled every optional field: 3-4 failed rounds per fresh
    // conversation until it learned minimal args.
    expect(
      applyToolArgDefaults('list_guides', {
        keyword: '',
        partial_path: '',
        reference: {
          type: 'guide', url: '', schema: '', table: '', column: '',
          view: '', macro: '', uuid: '', path: '', description: '',
        },
        limit: 100,
        offset: 0,
      }),
    ).toEqual({ limit: 100, offset: 0 });
  });

  it('keeps meaningful list_guides args intact', () => {
    expect(
      applyToolArgDefaults('list_guides', {
        keyword: 'taxi',
        reference: { type: 'catalog', url: 'md:my_db', schema: 'main', table: 't' },
      }),
    ).toEqual({
      keyword: 'taxi',
      reference: { type: 'catalog', url: 'md:my_db', schema: 'main', table: 't' },
    });
  });

  it('drops a reference whose only surviving field is type, keeps one with substance', () => {
    expect(
      applyToolArgDefaults('get_guide', { path: 'dives.md', version: null }),
    ).toEqual({ path: 'dives.md' });
    expect(
      applyToolArgDefaults('list_guides', { reference: { type: 'guide', path: 'x.md', uuid: '' } }),
    ).toEqual({ reference: { type: 'guide', path: 'x.md' } });
  });

  it('leaves non-guide tools untouched, including empty strings', () => {
    expect(applyToolArgDefaults('query', { sql: '', database: 'db' })).toEqual({
      sql: '',
      database: 'db',
    });
    expect(applyToolArgDefaults('create_guide', { path: 'p', title: 't', content: 'c', description: '' }))
      .toEqual({ path: 'p', title: 't', content: 'c', description: '' });
  });
});

describe('detectPayloadFailure', () => {
  it('surfaces success:false from the guide writes', () => {
    const r = detectPayloadFailure('create_guide', JSON.stringify({ success: false, error: 'nope' }));
    expect(r).toEqual({ failed: true, message: 'nope' });
  });

  it('passes through non-JSON (the guide tools return YAML-ish text on success)', () => {
    expect(detectPayloadFailure('create_guide', 'success: true\nguide:\n  id: abc')).toEqual({
      failed: false,
    });
  });
});
