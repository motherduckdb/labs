import { describe, expect, it, vi } from 'vitest';
import {
  assertGuideWriteAllowed,
  assertGuideWriteTargetAllowed,
  parseGuideHeader,
} from './mcp-client';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

const UUID = '0198f00d-0000-7000-8000-000000000000';

describe('assertGuideWriteAllowed (sync guard)', () => {
  it('rejects any explicit access other than "user" on guide writes', () => {
    for (const tool of ['create_guide', 'update_guide', 'edit_guide_content']) {
      expect(() => assertGuideWriteAllowed(tool, { access: 'organization' })).toThrow(/private/i);
    }
    // Allowlist semantics: an unknown/future access level must not slip
    // through just because it isn't "organization".
    expect(() => assertGuideWriteAllowed('update_guide', { uuid: UUID, access: 'team' })).toThrow(/private/i);
    expect(() => assertGuideWriteAllowed('update_guide', { uuid: UUID, access: 'user' })).not.toThrow();
  });

  it('rejects the dead path-selected arg shape with a corrective message', () => {
    expect(() => assertGuideWriteAllowed('update_guide', { path: 'users/me/x.md' })).toThrow(/uuid/i);
    expect(() => assertGuideWriteAllowed('create_guide', { path: 'users/me/x.md', title: 'x' })).toThrow(/topic/i);
  });

  it('confines model-created guides to the data-chat-mini topic namespace', () => {
    expect(() => assertGuideWriteAllowed('create_guide', { title: 'x', content: 'y' })).toThrow(/data-chat-mini/);
    expect(() => assertGuideWriteAllowed('create_guide', { title: 'x', topic: 'dbt/main' })).toThrow(/data-chat-mini/);
    expect(() => assertGuideWriteAllowed('create_guide', { title: 'x', topic: 'data-chat-mini/joins' })).not.toThrow();
  });

  it('lets internal (guide manager UI) calls use any topic, but never org access', () => {
    expect(() => assertGuideWriteAllowed('create_guide', { title: 'x', topic: 'anything/here' }, true)).not.toThrow();
    expect(() => assertGuideWriteAllowed('create_guide', { access: 'organization' }, true)).toThrow(/private/i);
  });

  it('rejects non-catalog references from the model', () => {
    expect(() =>
      assertGuideWriteAllowed('create_guide', {
        title: 'x',
        topic: 'data-chat-mini/x',
        references: [{ type: 'guide', uuid: UUID }],
      }),
    ).toThrow(/catalog/i);
    expect(() =>
      assertGuideWriteAllowed('create_guide', {
        title: 'x',
        topic: 'data-chat-mini/x',
        references: [{ type: 'catalog', url: 'md:my_db' }],
      }),
    ).not.toThrow();
  });

  it('ignores non-guide tools', () => {
    expect(() => assertGuideWriteAllowed('query', { sql: 'select 1' })).not.toThrow();
  });
});

describe('parseGuideHeader', () => {
  it('extracts version and access from the rendered get_guide header', () => {
    const text = `My guide\nuuid: ${UUID} · v4 · organization\n\nDescription.\n\n# Body`;
    expect(parseGuideHeader(text)).toEqual({ version: 4, access: 'organization' });
  });

  it('returns nulls when no header line is present', () => {
    expect(parseGuideHeader('just some markdown')).toEqual({ version: null, access: null });
  });
});

describe('assertGuideWriteTargetAllowed (async uuid-target guard)', () => {
  function clientReturning(text: string, isError = false): Client {
    return {
      callTool: vi.fn().mockResolvedValue({ content: [{ type: 'text', text }], isError }),
    } as unknown as Client;
  }

  it('allows edits to a private guide', async () => {
    const client = clientReturning(`T\nuuid: ${UUID} · v1 · user\n\nd\n\nbody`);
    await expect(assertGuideWriteTargetAllowed(client, 'update_guide', { uuid: UUID })).resolves.toBeUndefined();
  });

  it('reads the header from structuredContent (the live get_guide shape)', async () => {
    const rendered = `T\nuuid: ${UUID} · v2 · user\n\nd\n\nbody`;
    const client = {
      callTool: vi.fn().mockResolvedValue({
        structuredContent: { text: rendered },
        content: [{ type: 'text', text: JSON.stringify({ text: rendered }) }],
        isError: false,
      }),
    } as unknown as Client;
    await expect(assertGuideWriteTargetAllowed(client, 'update_guide', { uuid: UUID })).resolves.toBeUndefined();
  });

  it('unwraps a JSON mirror in the content blocks when structuredContent is absent', async () => {
    const rendered = `T\nuuid: ${UUID} · v2 · organization\n\nd\n\nbody`;
    const client = clientReturning(JSON.stringify({ text: rendered }));
    await expect(assertGuideWriteTargetAllowed(client, 'edit_guide_content', { uuid: UUID })).rejects.toThrow(/organization/i);
  });

  it('refuses to touch an org-wide guide even if the token could', async () => {
    const client = clientReturning(`T\nuuid: ${UUID} · v9 · organization\n\nd\n\nbody`);
    await expect(assertGuideWriteTargetAllowed(client, 'edit_guide_content', { uuid: UUID })).rejects.toThrow(/organization/i);
  });

  it('fails closed when the target cannot be resolved', async () => {
    const notFound = clientReturning('Could not find guide', true);
    await expect(assertGuideWriteTargetAllowed(notFound, 'update_guide', { uuid: UUID })).rejects.toThrow(/resolve/i);
    const headerless = clientReturning('odd response with no header');
    await expect(assertGuideWriteTargetAllowed(headerless, 'update_guide', { uuid: UUID })).rejects.toThrow(/unknown access/i);
  });

  it('requires a uuid arg', async () => {
    const client = clientReturning('unused');
    await expect(assertGuideWriteTargetAllowed(client, 'delete_guide', {})).rejects.toThrow(/uuid/i);
  });

  it('ignores create_guide and read tools', async () => {
    const client = { callTool: vi.fn() } as unknown as Client;
    await expect(assertGuideWriteTargetAllowed(client, 'create_guide', { title: 'x' })).resolves.toBeUndefined();
    await expect(assertGuideWriteTargetAllowed(client, 'get_guide', { uuid: UUID })).resolves.toBeUndefined();
    expect((client as unknown as { callTool: ReturnType<typeof vi.fn> }).callTool).not.toHaveBeenCalled();
  });
});
