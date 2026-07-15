import { beforeEach, describe, it, expect, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import { GET, PATCH } from './route';

const mcp = vi.hoisted(() => ({
  createMCPClient: vi.fn(),
  executeToolWithStatus: vi.fn(),
}));

vi.mock('@/lib/mcp-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/mcp-client')>();
  return {
    ...actual,
    createMCPClient: mcp.createMCPClient,
    executeToolWithStatus: mcp.executeToolWithStatus,
  };
});

// PATCH's authorization checks (personal-namespace gate + org-promotion block)
// run before any MotherDuck connection, so these exercise them with a minimal
// request stub and never touch MCP.
function patchReq(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

function getReq(path = '/api/guides'): NextRequest {
  return {
    headers: new Headers(),
    nextUrl: new URL(`https://example.test${path}`),
  } as unknown as NextRequest;
}

beforeEach(() => {
  mcp.createMCPClient.mockReset();
  mcp.executeToolWithStatus.mockReset();
  mcp.createMCPClient.mockResolvedValue({ close: vi.fn() });
});

describe('/api/guides GET upstream errors', () => {
  it('surfaces a missing list_guides tool instead of returning an empty list', async () => {
    mcp.executeToolWithStatus.mockResolvedValue({
      text: 'MCP error -32602: Tool list_guides not found',
      isError: true,
    });

    const res = await GET(getReq());

    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/list_guides not found/i);
  });

  it('surfaces a missing get_guide tool instead of returning error text as content', async () => {
    mcp.executeToolWithStatus.mockResolvedValue({
      text: 'MCP error -32602: Tool get_guide not found',
      isError: true,
    });

    const res = await GET(getReq('/api/guides?path=guides.md'));

    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/get_guide not found/i);
  });
});

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
