import { describe, expect, it } from 'vitest';
import { applyToolArgDefaults, detectPayloadFailure } from './tool-invocation';

describe('applyToolArgDefaults', () => {
  it('defaults include_org_shares on list_dives', () => {
    expect(applyToolArgDefaults('list_dives', {})).toEqual({ include_org_shares: true });
    expect(applyToolArgDefaults('list_dives', { include_org_shares: false })).toEqual({
      include_org_shares: false,
    });
  });

  it('forces client: other on get_dive_guide regardless of what the model passed', () => {
    expect(applyToolArgDefaults('get_dive_guide', {})).toEqual({ client: 'other' });
    expect(applyToolArgDefaults('get_dive_guide', { client: 'claude' })).toEqual({
      client: 'other',
    });
    expect(applyToolArgDefaults('get_dive_guide', { client: 'chatgpt' })).toEqual({
      client: 'other',
    });
  });

  it('forces access: user on create_guide regardless of what the model passed', () => {
    expect(
      applyToolArgDefaults('create_guide', { title: 't', content: 'c' }),
    ).toEqual({ title: 't', content: 'c', access: 'user' });
    expect(
      applyToolArgDefaults('create_guide', { title: 't', content: 'c', access: 'organization' }),
    ).toEqual({ title: 't', content: 'c', access: 'user' });
  });

  it('strips GPT-style empty-string/null padding from list_guides args (observed live)', () => {
    // gpt-5.6-luna filled every optional field: 3-4 failed rounds per fresh
    // conversation until it learned minimal args.
    expect(
      applyToolArgDefaults('list_guides', {
        topic: '',
        keyword: null,
        limit: 100,
        offset: 0,
      }),
    ).toEqual({ limit: 100, offset: 0 });
  });

  it('keeps a meaningful list_guides topic intact', () => {
    expect(applyToolArgDefaults('list_guides', { topic: 'quackbot/nba' })).toEqual({
      topic: 'quackbot/nba',
    });
  });

  it('strips empty version on get_guide but never touches uuid', () => {
    expect(
      applyToolArgDefaults('get_guide', { uuid: 'b00542d5-...', version: '' }),
    ).toEqual({ uuid: 'b00542d5-...' });
    expect(applyToolArgDefaults('get_guide', { uuid: '', version: '' })).toEqual({ uuid: '' });
  });

  it('coerces a numeric-string version to a number on get_guide', () => {
    expect(applyToolArgDefaults('get_guide', { uuid: 'abc', version: '2' })).toEqual({
      uuid: 'abc',
      version: 2,
    });
  });

  it('leaves a non-numeric-string version untouched (server can reject it)', () => {
    expect(applyToolArgDefaults('get_guide', { uuid: 'abc', version: 'latest' })).toEqual({
      uuid: 'abc',
      version: 'latest',
    });
  });

  it('drops empty-string optional fields on create_guide but keeps title/content/uuid untouched', () => {
    expect(
      applyToolArgDefaults('create_guide', {
        title: 't',
        content: 'c',
        topic: '',
        description: '',
        change_comment: '',
        external_id: '',
      }),
    ).toEqual({ title: 't', content: 'c', access: 'user' });
  });

  it('never strips title, content, or uuid even when empty (selector/payload, not padding)', () => {
    expect(applyToolArgDefaults('create_guide', { title: '', content: '' })).toEqual({
      title: '',
      content: '',
      access: 'user',
    });
    expect(applyToolArgDefaults('update_guide', { uuid: '' })).toEqual({ uuid: '' });
  });

  it('never touches the edits array on edit_guide_content, including empty-string fields inside it', () => {
    const edits = [{ old_string: '', new_string: 'x', replace_all: true }];
    expect(applyToolArgDefaults('edit_guide_content', { uuid: 'abc', edits })).toEqual({
      uuid: 'abc',
      edits,
    });
  });

  it('strips empty change_comment on edit_guide_content alongside real edits', () => {
    const edits = [{ old_string: 'a', new_string: 'b' }];
    expect(
      applyToolArgDefaults('edit_guide_content', { uuid: 'abc', edits, change_comment: '' }),
    ).toEqual({ uuid: 'abc', edits });
  });

  it('drops a references[] entry whose only surviving field is type, keeps one with substance', () => {
    expect(
      applyToolArgDefaults('create_guide', {
        title: 't',
        content: 'c',
        references: [
          { type: 'guide', uuid: '' },
          { type: 'catalog', url: 'md:my_db', schema: 'main', table: 't' },
        ],
      }),
    ).toEqual({
      title: 't',
      content: 'c',
      access: 'user',
      references: [{ type: 'catalog', url: 'md:my_db', schema: 'main', table: 't' }],
    });
  });

  it('drops the whole references key when every entry is junk', () => {
    expect(
      applyToolArgDefaults('update_guide', {
        uuid: 'abc',
        references: [{ type: 'guide', uuid: '' }],
      }),
    ).toEqual({ uuid: 'abc' });
  });

  it('leaves non-guide tools untouched, including empty strings', () => {
    expect(applyToolArgDefaults('query', { sql: '', database: 'db' })).toEqual({
      sql: '',
      database: 'db',
    });
  });
});

describe('detectPayloadFailure', () => {
  it('surfaces success:false from the guide writes, using the live error string', () => {
    const r = detectPayloadFailure(
      'update_guide',
      JSON.stringify({ success: false, error: 'Could not find guide or not authorized' }),
    );
    expect(r).toEqual({ failed: true, message: 'Could not find guide or not authorized' });
  });

  it('surfaces success:false from create_guide', () => {
    const r = detectPayloadFailure('create_guide', JSON.stringify({ success: false, error: 'nope' }));
    expect(r).toEqual({ failed: true, message: 'nope' });
  });

  it('passes through a successful write envelope', () => {
    expect(
      detectPayloadFailure('create_guide', JSON.stringify({ success: true, guide: { uuid: 'abc' } })),
    ).toEqual({ failed: false });
  });

  it('never flags list_guides even though its envelope also carries success', () => {
    // list_guides is a READ; SUCCESS_FIELD_TOOLS is keyed by the write-tool
    // set specifically so this can't false-positive.
    expect(
      detectPayloadFailure('list_guides', JSON.stringify({ success: false, error: 'ignored' })),
    ).toEqual({ failed: false });
  });

  it('passes through non-JSON text', () => {
    expect(detectPayloadFailure('create_guide', 'not json at all')).toEqual({
      failed: false,
    });
  });
});
