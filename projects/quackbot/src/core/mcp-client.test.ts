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
} from './mcp-client';

describe('quackbot tool allowlist', () => {
  it('allowlists the guide tools that back durable memory (the key change from data-chat-mini)', () => {
    for (const t of ['list_guides', 'get_guide', 'create_guide', 'update_guide']) {
      expect(ALLOWED_TOOLS.has(t)).toBe(true);
    }
    // The invented context-layer shapes are gone — they never existed on the
    // live MCP server.
    expect(ALLOWED_TOOLS.has('query_context_layer')).toBe(false);
    expect(ALLOWED_TOOLS.has('update_context_layer')).toBe(false);
  });

  it('keeps query_rw and the deletes classified but NOT allowlisted', () => {
    expect(MUTATING_TOOLS.has('query_rw')).toBe(true);
    expect(DESTRUCTIVE_TOOLS.has('delete_dive')).toBe(true);
    expect(DESTRUCTIVE_TOOLS.has('delete_guide')).toBe(true);
    expect(ALLOWED_TOOLS.has('query_rw')).toBe(false);
    expect(ALLOWED_TOOLS.has('delete_dive')).toBe(false);
    expect(ALLOWED_TOOLS.has('delete_guide')).toBe(false);
  });

  it('classifies guide reads as read-only and guide writes as mutating', () => {
    expect(READONLY_TOOLS.has('list_guides')).toBe(true);
    expect(READONLY_TOOLS.has('get_guide')).toBe(true);
    for (const t of ['create_guide', 'update_guide', 'edit_guide_content', 'update_guide_metadata', 'set_guide_access']) {
      expect(READONLY_TOOLS.has(t)).toBe(false);
      expect(MUTATING_TOOLS.has(t)).toBe(true);
    }
  });

  it('allowlists the Dive reads', () => {
    for (const t of ['list_dives', 'read_dive']) {
      expect(ALLOWED_TOOLS.has(t)).toBe(true);
      expect(READONLY_TOOLS.has(t)).toBe(true);
    }
    // get_dive_guide is retired server-side; the dive guide is get_guide("dives.md").
    expect(ALLOWED_TOOLS.has('get_dive_guide')).toBe(false);
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

  it('allowlists guide writes but keeps the metadata/access edits blocked', () => {
    for (const t of ['edit_guide_content', 'update_guide_metadata', 'set_guide_access']) {
      expect(ALLOWED_TOOLS.has(t)).toBe(false);
    }
  });
});

describe('guideWriteViolation (path guard on the allowlisted guide writes)', () => {
  it('accepts writes under users/<username>/quackbot/', () => {
    expect(guideWriteViolation('create_guide', { path: 'users/jm_quackbot/quackbot/taxi-data.md' })).toBeNull();
    expect(guideWriteViolation('update_guide', { path: 'users/someone_else/quackbot/x.md' })).toBeNull();
  });

  it('rejects writes outside the quackbot folder', () => {
    expect(guideWriteViolation('create_guide', { path: 'revenue-billing/mrr.md' })).toMatch(/quackbot/);
    expect(guideWriteViolation('update_guide', { path: 'users/jm_quackbot/personal-notes.md' })).toMatch(/quackbot/);
    expect(guideWriteViolation('create_guide', { path: 'users/jm_quackbot/quackbot/' })).toMatch(/quackbot/);
  });

  it('rejects id-only selection so the path check cannot be bypassed', () => {
    expect(guideWriteViolation('update_guide', { id: 'some-uuid', content: 'x' })).toMatch(/path/);
    expect(guideWriteViolation('create_guide', undefined)).toMatch(/path/);
  });

  it('rejects an id passed ALONGSIDE a valid path (server-side selection could prefer it)', () => {
    expect(
      guideWriteViolation('update_guide', {
        id: 'some-org-guide-uuid',
        path: 'users/jm_quackbot/quackbot/ok.md',
        content: 'x',
      }),
    ).toMatch(/path.*only|do not pass/);
  });

  it('rejects dot-segment traversal and malformed segments inside the quackbot folder', () => {
    for (const path of [
      'users/jm_quackbot/quackbot/../../core-metrics/nrr.md',
      'users/jm_quackbot/quackbot/./x.md',
      'users/jm_quackbot/quackbot//x.md',
      'users/jm_quackbot/quackbot/..\\x.md',
    ]) {
      expect(guideWriteViolation('create_guide', { path })).toBeTruthy();
    }
    // Dots WITHIN a filename stay legal.
    expect(guideWriteViolation('create_guide', { path: 'users/jm_quackbot/quackbot/v1.2-notes.md' })).toBeNull();
  });

  it('rejects percent-encoded and Unicode look-alike traversal', () => {
    for (const path of [
      'users/jm_quackbot/quackbot/%2e%2e/%2e%2e/victim.md', // percent-encoded ..
      'users/jm_quackbot/quackbot/a%2f%2e%2e%2fvictim.md', // encoded slash+..
      'users/jm_quackbot/quackbot/．．/x.md', // fullwidth ．．
      'users/jm_quackbot/quackbot/x y.md', // whitespace
      'users/jm_quackbot/quackbot/café.md', // non-ASCII
    ]) {
      expect(guideWriteViolation('create_guide', { path })).toBeTruthy();
    }
  });

  it('never fires for reads or non-guide tools', () => {
    expect(guideWriteViolation('get_guide', { path: 'dives.md' })).toBeNull();
    expect(guideWriteViolation('list_guides', undefined)).toBeNull();
    expect(guideWriteViolation('query', { sql: 'SELECT 1' })).toBeNull();
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

describe('requiresConfirmation (quackbot v1: no Slack confirmation handshake)', () => {
  it('never confirms the path-guarded guide writes', () => {
    expect(requiresConfirmation('create_guide', { path: 'users/x/quackbot/y.md' })).toBe(false);
    expect(requiresConfirmation('update_guide', { path: 'users/x/quackbot/y.md' })).toBe(false);
  });

  it('never confirms save_dive (fresh id, cannot clobber)', () => {
    expect(requiresConfirmation('save_dive', undefined)).toBe(false);
  });

  it('still classifies destructive/other mutating tools as needing confirmation', () => {
    expect(requiresConfirmation('delete_dive', undefined)).toBe(true);
    expect(requiresConfirmation('delete_guide', undefined)).toBe(true);
    expect(requiresConfirmation('query_rw', undefined)).toBe(true);
    expect(requiresConfirmation('edit_dive_content', undefined)).toBe(true);
    expect(requiresConfirmation('update_dive', undefined)).toBe(true);
    expect(requiresConfirmation('share_dive_data', undefined)).toBe(true);
    expect(requiresConfirmation('edit_guide_content', undefined)).toBe(true);
    expect(requiresConfirmation('update_guide_metadata', undefined)).toBe(true);
    expect(requiresConfirmation('set_guide_access', undefined)).toBe(true);
  });

  it('does not confirm plain reads', () => {
    expect(requiresConfirmation('query', undefined)).toBe(false);
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

  it('returns a tool error (not a dispatch) for a guide write outside the quackbot folder', async () => {
    // The guard fires before the client is touched, so the bare stub proves
    // no MCP call happens.
    const result = await executeToolWithStatus(dummyClient, 'create_guide', {
      path: 'revenue-billing/mrr.md',
      title: 't',
      content: 'c',
    });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/users\/<username>\/quackbot\//);
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
