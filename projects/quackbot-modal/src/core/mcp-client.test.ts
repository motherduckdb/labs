import { afterEach, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  ALLOWED_TOOLS,
  READONLY_TOOLS,
  MUTATING_TOOLS,
  DESTRUCTIVE_TOOLS,
  requiresConfirmation,
  executeToolWithStatus,
  guideWriteViolation,
  databaseAllowViolation,
  configuredDatabaseAllowlist,
  parseGuideHeader,
  isNamespacedGuideTopic,
  UUID_SELECTED_GUIDE_WRITES,
} from './mcp-client';

describe('quackbot tool allowlist', () => {
  it('allowlists the guide tools that back durable memory (reads, writes, surgical edits)', () => {
    for (const t of [
      'list_guides',
      'get_guide',
      'get_query_guide',
      'get_dive_guide',
      'create_guide',
      'update_guide',
      'edit_guide_content',
    ]) {
      expect(ALLOWED_TOOLS.has(t)).toBe(true);
    }
    // The invented context-layer shapes are gone — they never existed on the
    // live MCP server.
    expect(ALLOWED_TOOLS.has('query_context_layer')).toBe(false);
    expect(ALLOWED_TOOLS.has('update_context_layer')).toBe(false);
  });

  it('allowlists the new read-only discovery/docs tools', () => {
    for (const t of ['list_views', 'list_macros', 'list_shares', 'ask_docs_question']) {
      expect(ALLOWED_TOOLS.has(t)).toBe(true);
      expect(READONLY_TOOLS.has(t)).toBe(true);
    }
  });

  it('keeps query_rw and the deletes classified but NOT allowlisted', () => {
    expect(MUTATING_TOOLS.has('query_rw')).toBe(true);
    expect(DESTRUCTIVE_TOOLS.has('delete_dive')).toBe(true);
    expect(DESTRUCTIVE_TOOLS.has('delete_guide')).toBe(true);
    expect(ALLOWED_TOOLS.has('query_rw')).toBe(false);
    expect(ALLOWED_TOOLS.has('delete_dive')).toBe(false);
    expect(ALLOWED_TOOLS.has('delete_guide')).toBe(false);
  });

  it('classifies guide reads as read-only and the whole-guide/metadata writes as mutating', () => {
    for (const t of ['list_guides', 'get_guide', 'get_query_guide', 'get_dive_guide']) {
      expect(READONLY_TOOLS.has(t)).toBe(true);
    }
    for (const t of ['create_guide', 'update_guide', 'edit_guide_content', 'update_guide_metadata', 'set_guide_access']) {
      expect(READONLY_TOOLS.has(t)).toBe(false);
      expect(MUTATING_TOOLS.has(t)).toBe(true);
    }
  });

  it('allowlists the Dive reads and the (now restored) dive guide tool', () => {
    for (const t of ['list_dives', 'read_dive']) {
      expect(ALLOWED_TOOLS.has(t)).toBe(true);
      expect(READONLY_TOOLS.has(t)).toBe(true);
    }
    // The dive guide is back as its own tool (was worked around as
    // get_guide("dives.md") while the server had it retired).
    expect(ALLOWED_TOOLS.has('get_dive_guide')).toBe(true);
    expect(READONLY_TOOLS.has('get_dive_guide')).toBe(true);
  });

  it('allowlists save_dive but ONLY save_dive among the Dive writes', () => {
    expect(ALLOWED_TOOLS.has('save_dive')).toBe(true);
    expect(MUTATING_TOOLS.has('save_dive')).toBe(true);
    // The edit-in-place writes are classified as mutating but stay blocked:
    // they can clobber a wrongly-picked dive id and Slack v1 has no confirm UI.
    for (const t of ['edit_dive_content', 'update_dive', 'share_dive_data']) {
      expect(MUTATING_TOOLS.has(t)).toBe(true);
      expect(ALLOWED_TOOLS.has(t)).toBe(false);
    }
  });

  it('keeps the metadata/access edits blocked (namespace + org-publish escapes)', () => {
    for (const t of ['update_guide_metadata', 'set_guide_access']) {
      expect(ALLOWED_TOOLS.has(t)).toBe(false);
    }
  });

  it('classifies read-only-but-not-allowlisted tools for completeness', () => {
    // Classified READONLY (never gated) yet intentionally absent from the
    // allowlist — the model never sees them, but the classification is complete.
    for (const t of ['get_flight_guide', 'view_dive', 'dive_query']) {
      expect(READONLY_TOOLS.has(t)).toBe(true);
      expect(ALLOWED_TOOLS.has(t)).toBe(false);
    }
  });
});

describe('guideWriteViolation — create_guide (topic + access + references guard)', () => {
  it('accepts a well-formed private create under a quackbot topic', () => {
    expect(guideWriteViolation('create_guide', { topic: 'quackbot', title: 't', content: 'c' })).toBeNull();
    expect(guideWriteViolation('create_guide', { topic: 'quackbot/taxi', title: 't', content: 'c' })).toBeNull();
    expect(guideWriteViolation('create_guide', { topic: 'quackbot/finance/metrics', title: 't', content: 'c' })).toBeNull();
    // Explicit access:'user' is allowed; dots within a segment stay legal.
    expect(guideWriteViolation('create_guide', { topic: 'quackbot/v1.2-notes', access: 'user', content: 'c' })).toBeNull();
  });

  it('rejects a missing, empty, or non-string topic', () => {
    expect(guideWriteViolation('create_guide', { title: 't', content: 'c' })).toMatch(/topic/);
    expect(guideWriteViolation('create_guide', { topic: '', content: 'c' })).toMatch(/topic/);
    expect(guideWriteViolation('create_guide', { topic: 123, content: 'c' })).toMatch(/topic/);
    expect(guideWriteViolation('create_guide', undefined)).toMatch(/topic/);
  });

  it('rejects a topic outside the quackbot namespace', () => {
    expect(guideWriteViolation('create_guide', { topic: 'dbt/main', content: 'c' })).toMatch(/quackbot/);
    expect(guideWriteViolation('create_guide', { topic: 'revenue-billing', content: 'c' })).toMatch(/quackbot/);
    // A topic that merely starts with the letters isn't inside the namespace.
    expect(guideWriteViolation('create_guide', { topic: 'quackbotx/y', content: 'c' })).toMatch(/quackbot/);
  });

  it('rejects uppercase and whitespace in topic segments', () => {
    expect(guideWriteViolation('create_guide', { topic: 'quackbot/Taxi', content: 'c' })).toMatch(/quackbot/);
    expect(guideWriteViolation('create_guide', { topic: 'quackbot/a b', content: 'c' })).toMatch(/quackbot/);
    expect(guideWriteViolation('create_guide', { topic: 'quackbot/café', content: 'c' })).toMatch(/quackbot/);
  });

  it('rejects traversal-ish dot-only segments in topic', () => {
    for (const topic of ['quackbot/../x', 'quackbot/./x', 'quackbot/..']) {
      expect(guideWriteViolation('create_guide', { topic, content: 'c' })).toBeTruthy();
    }
  });

  it('forces private scope: rejects a non-user access on create', () => {
    expect(guideWriteViolation('create_guide', { topic: 'quackbot/x', access: 'organization', content: 'c' })).toMatch(/access/);
    expect(guideWriteViolation('create_guide', { topic: 'quackbot/x', access: 'public', content: 'c' })).toMatch(/access/);
  });

  it('restricts references to catalog entries', () => {
    expect(
      guideWriteViolation('create_guide', {
        topic: 'quackbot/x',
        content: 'c',
        references: [{ type: 'catalog', name: 'taxi.trips' }],
      }),
    ).toBeNull();
    for (const type of ['guide', 'dive', 'flight']) {
      expect(
        guideWriteViolation('create_guide', {
          topic: 'quackbot/x',
          content: 'c',
          references: [{ type, id: 'whatever' }],
        }),
      ).toMatch(/catalog/);
    }
    // Non-array references shape is rejected too.
    expect(
      guideWriteViolation('create_guide', { topic: 'quackbot/x', content: 'c', references: { type: 'catalog' } }),
    ).toMatch(/array/);
  });
});

describe('guideWriteViolation — update_guide (uuid + access + references guard)', () => {
  it('accepts an update selected by a non-empty uuid', () => {
    expect(guideWriteViolation('update_guide', { uuid: 'b00542d5-abcd', content: 'x' })).toBeNull();
    // Ownership is the server's job — a uuid the bot may not own still passes
    // the client guard (server ACL rejects it, no client pre-check needed).
    expect(guideWriteViolation('update_guide', { uuid: 'some-org-guide-uuid', content: 'x' })).toBeNull();
  });

  it('rejects a missing or empty uuid', () => {
    expect(guideWriteViolation('update_guide', { content: 'x' })).toMatch(/uuid/);
    expect(guideWriteViolation('update_guide', { uuid: '', content: 'x' })).toMatch(/uuid/);
    expect(guideWriteViolation('update_guide', undefined)).toMatch(/uuid/);
  });

  it('rejects a non-user access if one is passed', () => {
    expect(guideWriteViolation('update_guide', { uuid: 'u', access: 'organization' })).toMatch(/access/);
  });

  it('restricts references to catalog entries', () => {
    expect(
      guideWriteViolation('update_guide', { uuid: 'u', references: [{ type: 'dive', id: 'd' }] }),
    ).toMatch(/catalog/);
    expect(
      guideWriteViolation('update_guide', { uuid: 'u', references: [{ type: 'catalog', name: 't' }] }),
    ).toBeNull();
  });
});

describe('guideWriteViolation — edit_guide_content (uuid + edits[] shape)', () => {
  it('accepts a well-formed edits array', () => {
    expect(
      guideWriteViolation('edit_guide_content', {
        uuid: 'u',
        edits: [{ old_string: 'a', new_string: 'b' }],
      }),
    ).toBeNull();
    expect(
      guideWriteViolation('edit_guide_content', {
        uuid: 'u',
        edits: [{ old_string: 'a', new_string: 'b', replace_all: true }],
      }),
    ).toBeNull();
  });

  it('rejects a missing or empty uuid', () => {
    expect(
      guideWriteViolation('edit_guide_content', { edits: [{ old_string: 'a', new_string: 'b' }] }),
    ).toMatch(/uuid/);
    expect(
      guideWriteViolation('edit_guide_content', { uuid: '', edits: [{ old_string: 'a', new_string: 'b' }] }),
    ).toMatch(/uuid/);
  });

  it('rejects the flat old_string/new_string shape (must be an edits array)', () => {
    expect(
      guideWriteViolation('edit_guide_content', { uuid: 'u', old_string: 'a', new_string: 'b' }),
    ).toMatch(/array/);
  });

  it('rejects an empty edits array', () => {
    expect(guideWriteViolation('edit_guide_content', { uuid: 'u', edits: [] })).toMatch(/array/);
  });

  it('rejects edits entries missing string old_string/new_string', () => {
    expect(
      guideWriteViolation('edit_guide_content', { uuid: 'u', edits: [{ old_string: 'a' }] }),
    ).toMatch(/old_string.*new_string|new_string/);
    expect(
      guideWriteViolation('edit_guide_content', { uuid: 'u', edits: ['not-an-object'] }),
    ).toBeTruthy();
  });
});

describe('guideWriteViolation — never fires for reads or non-guide tools', () => {
  it('returns null for guide reads and unrelated tools', () => {
    expect(guideWriteViolation('get_guide', { uuid: 'u' })).toBeNull();
    expect(guideWriteViolation('list_guides', undefined)).toBeNull();
    expect(guideWriteViolation('get_query_guide', undefined)).toBeNull();
    expect(guideWriteViolation('query', { sql: 'SELECT 1' })).toBeNull();
  });
});

describe('parseGuideHeader (get_guide returns {text}; metadata is a rendered header)', () => {
  it('extracts title, topic, and uuid from the live-observed header format', () => {
    const text = [
      'Taxi data table',
      'uuid: ddff9b9d-1234 · topic: quackbot/taxi · v3 · user',
      'The yellow-taxi trips table.',
      '',
      'Body of the guide.',
    ].join('\n');
    expect(parseGuideHeader(text)).toEqual({
      title: 'Taxi data table',
      topic: 'quackbot/taxi',
      uuid: 'ddff9b9d-1234',
    });
  });

  it('strips a markdown heading marker on the title line', () => {
    const text = '# NBA scoring\nuuid: 1d02 · topic: quackbot/nba · v1 · user\ndesc';
    expect(parseGuideHeader(text)).toMatchObject({ title: 'NBA scoring', topic: 'quackbot/nba' });
  });

  it('tolerates a pipe-separated header', () => {
    const text = 'Title\nuuid: abc | topic: quackbot | v1 | user\ndesc';
    expect(parseGuideHeader(text)).toMatchObject({ title: 'Title', topic: 'quackbot', uuid: 'abc' });
  });

  it('fails closed (null) when there is no recognizable metadata line', () => {
    expect(parseGuideHeader('just prose, no header')).toBeNull();
    expect(parseGuideHeader('')).toBeNull();
    expect(parseGuideHeader(undefined)).toBeNull();
    expect(parseGuideHeader(123 as unknown)).toBeNull();
    // A line with uuid but no topic is not enough to identify the target.
    expect(parseGuideHeader('Title\nuuid: abc only\nbody')).toBeNull();
  });
});

describe('isNamespacedGuideTopic (quackbot namespace confinement for uuid writes)', () => {
  it('accepts the literal topic and anything under quackbot/', () => {
    expect(isNamespacedGuideTopic('quackbot')).toBe(true);
    expect(isNamespacedGuideTopic('quackbot/taxi')).toBe(true);
    expect(isNamespacedGuideTopic('quackbot/finance/metrics')).toBe(true);
  });

  it('rejects foreign topics and near-miss prefixes', () => {
    expect(isNamespacedGuideTopic('finance/metrics')).toBe(false);
    expect(isNamespacedGuideTopic('quackbotx/y')).toBe(false);
    expect(isNamespacedGuideTopic('')).toBe(false);
    expect(isNamespacedGuideTopic(undefined)).toBe(false);
    expect(isNamespacedGuideTopic(123)).toBe(false);
  });

  it('lists exactly the two uuid-selected guide writes', () => {
    expect([...UUID_SELECTED_GUIDE_WRITES].sort()).toEqual(['edit_guide_content', 'update_guide']);
    expect(UUID_SELECTED_GUIDE_WRITES.has('create_guide')).toBe(false);
  });
});

describe('databaseAllowViolation (optional QUACKBOT_DATABASES hard cap)', () => {
  const original = process.env.QUACKBOT_DATABASES;
  afterEach(() => {
    if (original === undefined) delete process.env.QUACKBOT_DATABASES;
    else process.env.QUACKBOT_DATABASES = original;
  });

  it('is a no-op when the allowlist is unset (token grants remain the boundary)', () => {
    delete process.env.QUACKBOT_DATABASES;
    expect(configuredDatabaseAllowlist()).toEqual([]);
    expect(databaseAllowViolation({ database: 'anything', sql: 'SELECT 1' })).toBeNull();
  });

  it('rejects a database arg outside the configured allowlist', () => {
    process.env.QUACKBOT_DATABASES = 'sample_data, taxi';
    expect(databaseAllowViolation({ database: 'sample_data' })).toBeNull();
    expect(databaseAllowViolation({ database: 'taxi' })).toBeNull();
    expect(databaseAllowViolation({ database: 'finance_prod' })).toMatch(/not in this deployment/);
  });

  it('does not fire for calls without a database arg', () => {
    process.env.QUACKBOT_DATABASES = 'sample_data';
    expect(databaseAllowViolation({ sql: 'SELECT 1' })).toBeNull();
    expect(databaseAllowViolation(undefined)).toBeNull();
  });
});

describe('requiresConfirmation (Slack Approve/Deny handshake gates durable writes)', () => {
  it('confirms all four allowlisted writes', () => {
    expect(requiresConfirmation('create_guide', { topic: 'quackbot/y', content: 'c' })).toBe(true);
    expect(requiresConfirmation('update_guide', { uuid: 'u', content: 'c' })).toBe(true);
    expect(requiresConfirmation('edit_guide_content', { uuid: 'u', edits: [] })).toBe(true);
    expect(requiresConfirmation('save_dive', undefined)).toBe(true);
  });

  it('still classifies destructive/other mutating tools as needing confirmation', () => {
    expect(requiresConfirmation('delete_dive', undefined)).toBe(true);
    expect(requiresConfirmation('delete_guide', undefined)).toBe(true);
    expect(requiresConfirmation('query_rw', undefined)).toBe(true);
    expect(requiresConfirmation('edit_dive_content', undefined)).toBe(true);
    expect(requiresConfirmation('update_dive', undefined)).toBe(true);
    expect(requiresConfirmation('share_dive_data', undefined)).toBe(true);
    expect(requiresConfirmation('update_guide_metadata', undefined)).toBe(true);
    expect(requiresConfirmation('set_guide_access', undefined)).toBe(true);
  });

  it('does not confirm plain reads', () => {
    expect(requiresConfirmation('query', undefined)).toBe(false);
    expect(requiresConfirmation('get_query_guide', undefined)).toBe(false);
    expect(requiresConfirmation('ask_docs_question', undefined)).toBe(false);
  });
});

describe('executeToolWithStatus allowlist enforcement (no bypass)', () => {
  // The throw happens before the client is touched, so a bare stub is fine.
  const dummyClient = {} as unknown as Client;

  it('rejects a non-allowlisted destructive tool before any dispatch', async () => {
    await expect(
      executeToolWithStatus(dummyClient, 'delete_dive', {}),
    ).rejects.toThrow(/not in the allowed/);
  });

  it('rejects a non-allowlisted write tool', async () => {
    await expect(
      executeToolWithStatus(dummyClient, 'query_rw', { sql: 'DROP TABLE t' }),
    ).rejects.toThrow(/not in the allowed/);
  });

  it('keeps set_guide_access blocked (the org-wide publish switch)', async () => {
    await expect(
      executeToolWithStatus(dummyClient, 'set_guide_access', { uuid: 'u', access: 'organization' }),
    ).rejects.toThrow(/not in the allowed/);
  });

  it('returns a tool error (not a dispatch) for a guide write outside the quackbot topic', async () => {
    // The guard fires before the client is touched, so the bare stub proves
    // no MCP call happens.
    const result = await executeToolWithStatus(dummyClient, 'create_guide', {
      topic: 'dbt/main',
      title: 't',
      content: 'c',
    });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/quackbot/);
  });

  it('returns a tool error for a prompt-injected org-scoped create', async () => {
    const result = await executeToolWithStatus(dummyClient, 'create_guide', {
      topic: 'quackbot/x',
      access: 'organization',
      title: 't',
      content: 'c',
    });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/access/);
  });

  it('cannot be bypassed by a stray extra positional argument', async () => {
    // data-chat-mini exposed an `internal` boolean in this slot that skipped the
    // allowlist; it is gone. A truthy 4th arg now lands on requestOptions and
    // must NOT re-enable a blocked tool.
    await expect(
      // @ts-expect-error — the removed `internal` bypass no longer type-checks here.
      executeToolWithStatus(dummyClient, 'delete_dive', {}, true),
    ).rejects.toThrow(/not in the allowed/);
  });
});
