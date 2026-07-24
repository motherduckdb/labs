import { beforeEach, describe, it, expect, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import { GET, PATCH, POST } from './route';

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

// The authorization checks (org-promotion block, uuid requirement) run before
// any MotherDuck connection, so these exercise them with a minimal request
// stub and never touch MCP.
function jsonReq(body: unknown): NextRequest {
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

    const res = await GET(getReq('/api/guides?uuid=0198f00d-0000-7000-8000-000000000000'));

    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/get_guide not found/i);
  });

  it('parses version and access from the rendered guide header', async () => {
    mcp.executeToolWithStatus.mockResolvedValue({
      text: JSON.stringify({
        text: 'My guide\nuuid: 0198f00d-0000-7000-8000-000000000000 · v3 · user\n\nA one-liner.\n\n# Body',
      }),
      isError: false,
    });

    const res = await GET(getReq('/api/guides?uuid=0198f00d-0000-7000-8000-000000000000'));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.version).toBe(3);
    expect(data.access).toBe('user');
  });
});

describe('/api/guides mutation authorization', () => {
  it('POST blocks creating an org-wide guide (403)', async () => {
    const res = await POST(jsonReq({ title: 'x', content: '# y', access: 'organization' }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/private/i);
  });

  it('PATCH blocks promoting a guide to org-wide visibility (403)', async () => {
    const res = await PATCH(jsonReq({ uuid: '0198f00d-0000-7000-8000-000000000000', access: 'organization' }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/org-wide/i);
  });

  it('PATCH requires a uuid (400)', async () => {
    const res = await PATCH(jsonReq({ content: '# hijack' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/uuid/i);
  });
});
