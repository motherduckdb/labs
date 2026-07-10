import { describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  ALLOWED_TOOLS,
  READONLY_TOOLS,
  MUTATING_TOOLS,
  DESTRUCTIVE_TOOLS,
  requiresConfirmation,
  executeToolWithStatus,
} from './mcp-client';

describe('quackbot tool allowlist', () => {
  it('allowlists both context-layer tools (the key change from data-chat-mini)', () => {
    expect(ALLOWED_TOOLS.has('query_context_layer')).toBe(true);
    expect(ALLOWED_TOOLS.has('update_context_layer')).toBe(true);
  });

  it('keeps query_rw and delete_dive classified but NOT allowlisted', () => {
    expect(MUTATING_TOOLS.has('query_rw')).toBe(true);
    expect(DESTRUCTIVE_TOOLS.has('delete_dive')).toBe(true);
    expect(ALLOWED_TOOLS.has('query_rw')).toBe(false);
    expect(ALLOWED_TOOLS.has('delete_dive')).toBe(false);
  });

  it('classifies query_context_layer as read-only and update_context_layer as mutating', () => {
    expect(READONLY_TOOLS.has('query_context_layer')).toBe(true);
    expect(READONLY_TOOLS.has('update_context_layer')).toBe(false);
    expect(MUTATING_TOOLS.has('update_context_layer')).toBe(true);
  });

  it('allowlists the Dive reads', () => {
    for (const t of ['list_dives', 'read_dive', 'get_dive_guide']) {
      expect(ALLOWED_TOOLS.has(t)).toBe(true);
      expect(READONLY_TOOLS.has(t)).toBe(true);
    }
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
});

describe('requiresConfirmation (quackbot v1: no Slack confirmation handshake)', () => {
  it('never confirms context writes, for any action', () => {
    for (const action of ['create', 'update', 'delete', undefined]) {
      expect(requiresConfirmation('update_context_layer', action ? { action } : undefined)).toBe(false);
    }
  });

  it('never confirms save_dive (fresh id, cannot clobber)', () => {
    expect(requiresConfirmation('save_dive', undefined)).toBe(false);
  });

  it('still classifies destructive/other mutating tools as needing confirmation', () => {
    expect(requiresConfirmation('delete_dive', undefined)).toBe(true);
    expect(requiresConfirmation('query_rw', undefined)).toBe(true);
    expect(requiresConfirmation('edit_dive_content', undefined)).toBe(true);
    expect(requiresConfirmation('update_dive', undefined)).toBe(true);
    expect(requiresConfirmation('share_dive_data', undefined)).toBe(true);
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
