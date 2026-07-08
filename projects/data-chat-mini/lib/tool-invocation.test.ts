import { describe, expect, it } from 'vitest';
import { detectPayloadFailure, applyToolArgDefaults } from './tool-invocation';

describe('detectPayloadFailure', () => {
  it('flags a guide-write { success: false } payload as failed', () => {
    // The documented create failure (read-scaling token has no username claim)
    // must surface as a real tool error, not a silent success.
    const raw = JSON.stringify({
      success: false,
      error: 'Personal guides must live under users/<username>/; no authenticated username is available.',
    });
    const create = detectPayloadFailure('create_guide', raw);
    expect(create.failed).toBe(true);
    expect(create.message).toMatch(/no authenticated username/i);

    for (const tool of ['update_guide', 'edit_guide_content']) {
      expect(detectPayloadFailure(tool, raw).failed).toBe(true);
    }
  });

  it('treats a successful guide write as not failed', () => {
    const raw = JSON.stringify({ success: true, guide: { path: 'users/me/x.md' } });
    expect(detectPayloadFailure('create_guide', raw).failed).toBe(false);
    expect(detectPayloadFailure('update_guide', raw).failed).toBe(false);
  });

  it('ignores tools without a success envelope and non-JSON text', () => {
    expect(detectPayloadFailure('query', JSON.stringify({ success: false })).failed).toBe(false);
    expect(detectPayloadFailure('create_guide', 'plain text guide body').failed).toBe(false);
  });
});

describe('applyToolArgDefaults', () => {
  it('defaults list_dives to include org shares, leaves other tools untouched', () => {
    expect(applyToolArgDefaults('list_dives', {}).include_org_shares).toBe(true);
    expect(applyToolArgDefaults('list_dives', { include_org_shares: false }).include_org_shares).toBe(false);
    expect(applyToolArgDefaults('query', { sql: 'select 1' })).toEqual({ sql: 'select 1' });
  });
});
