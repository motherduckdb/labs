import { describe, it, expect } from 'vitest';
import type { NextRequest } from 'next/server';
import { PATCH } from './route';

// PATCH's authorization checks (personal-namespace gate + org-promotion block)
// run before any MotherDuck connection, so these exercise them with a minimal
// request stub and never touch MCP.
function patchReq(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

describe('/api/guides PATCH authorization', () => {
  it('blocks promoting a guide to org-wide visibility (403)', async () => {
    const res = await PATCH(patchReq({ path: 'users/matson/nba/x.md', access: 'organization' }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/org-wide/i);
  });

  it('blocks mutations outside the personal namespace (403)', async () => {
    const res = await PATCH(patchReq({ path: 'revenue-billing/awr.md', content: '# hijack' }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/personal guides/i);
  });

  it('blocks renaming a personal guide into the org namespace (403)', async () => {
    const res = await PATCH(patchReq({ path: 'users/matson/x.md', newPath: 'revenue-billing/x.md' }));
    expect(res.status).toBe(403);
  });
});
