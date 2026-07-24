/**
 * Guides endpoint — the context layer for the schema-explorer sidebar, plus the
 * human-driven guide editor. Guides live on the MotherDuck MCP's topic/uuid
 * surface: topics are slash-separated folder labels, guides are addressed by
 * uuid, and privacy is the `access` field (`user` = private, `organization`).
 *
 *  - `GET  /api/guides`                  → list_guides() → { topics, guides }
 *  - `GET  /api/guides?topic=core/x`     → list_guides({topic}) → { topics, guides }
 *  - `GET  /api/guides?uuid=…`           → get_guide(uuid) → { uuid, content, version, access }
 *  - `GET  /api/guides?uuid=…&version=2` → a specific prior version
 *  - `POST /api/guides`                  → create_guide(...) (access forced to "user")
 *  - `PATCH /api/guides`                 → update content and/or metadata of one guide (by uuid)
 *  - `DELETE /api/guides?uuid=…`         → delete_guide(uuid)
 *
 * Guides are MotherDuck's curated org + personal markdown about the data; they
 * replaced the old IndexedDB context fragments. Write tools run server-side with
 * the app token (internal — bypasses the LLM allowlist). This route runs every
 * browser request with the server MotherDuck token and the app has no per-user
 * auth in front of it, so all mutations are confined to private guides: creates
 * force `access: "user"`, and uuid-targeted writes go through
 * `assertGuideWriteTargetAllowed` (in executeToolWithStatus), which resolves the
 * target and refuses any guide that isn't `access: "user"`. Org-wide guides are
 * read-only from the app; managing them needs an admin/OAuth path out of band.
 *
 * The per-session id arrives in the `x-session-id` header and is threaded into
 * the MCP connection as a session hint.
 */
import { createMCPClient, executeToolWithStatus, parseGuideHeader } from '@/lib/mcp-client';
import { isAuthError, authExpiredResponse, getSessionHint } from '@/lib/api-helpers';
import { NextRequest } from 'next/server';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

export interface GuideSummary {
  uuid: string;
  topic: string;
  title: string;
  description: string;
  access: string;
}

export interface TopicSummary {
  topic: string;
  guide_count: number;
}

/** MCP tool results arrive as JSON text (from structuredContent); parse defensively. */
function parseJson(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Run one guide-write tool and normalize the result. Surfaces both transport
 * errors (`isError`, including the private-guide guard's rejection) and
 * payload-level `{success:false}` so the UI can show the server's message.
 */
async function callWrite(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; error: string }> {
  let text: string;
  let isError: boolean;
  try {
    ({ text, isError } = await executeToolWithStatus(client, name, args, true));
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : `${name} failed` };
  }
  const data = parseJson(text);
  if (isError || data.success === false) {
    const msg = typeof data.error === 'string' ? data.error
      : typeof data.message === 'string' ? data.message
      : text || `${name} failed`;
    return { ok: false, error: msg };
  }
  return { ok: true, data };
}

class GuideReadError extends Error {}

/** Fail loudly when the upstream MCP omits or rejects a required guide tool. */
async function callRead(
  client: Client,
  name: 'get_guide' | 'list_guides',
  args: Record<string, unknown>,
): Promise<string> {
  const { text, isError } = await executeToolWithStatus(client, name, args, true);
  if (isError) {
    throw new GuideReadError(`${name} failed: ${text || 'unknown MCP error'}`);
  }
  return text;
}

export async function GET(request: NextRequest) {
  const uuid = request.nextUrl.searchParams.get('uuid') || undefined;
  const topic = request.nextUrl.searchParams.get('topic') || undefined;
  const versionParam = request.nextUrl.searchParams.get('version');

  try {
    const client = await createMCPClient(getSessionHint(request));
    try {
      if (uuid) {
        const args: Record<string, unknown> = { uuid };
        if (versionParam) args.version = Number(versionParam);
        const text = await callRead(client, 'get_guide', args);
        const parsed = parseJson(text);
        const content = typeof parsed.text === 'string' ? parsed.text : text;
        const header = parseGuideHeader(content);
        return Response.json({ uuid, content, version: header.version, access: header.access });
      }
      const text = await callRead(client, 'list_guides', topic ? { topic } : {});
      const parsed = parseJson(text);
      const guides = Array.isArray(parsed.guides) ? (parsed.guides as GuideSummary[]) : [];
      const topics = Array.isArray(parsed.topics) ? (parsed.topics as TopicSummary[]) : [];
      return Response.json({ topics, guides });
    } finally {
      try { await client.close(); } catch { /* ignore */ }
    }
  } catch (error) {
    console.error('[Guides] GET error:', error);
    if (isAuthError(error)) return authExpiredResponse();
    if (error instanceof GuideReadError) {
      return Response.json({ error: error.message }, { status: 502 });
    }
    return Response.json({ error: 'Failed to fetch guides' }, { status: 500 });
  }
}

/** Create a new (private) guide. */
export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return Response.json({ error: 'Invalid JSON body' }, { status: 400 }); }
  const { title, content } = body;
  if (typeof title !== 'string' || !title.trim() || typeof content !== 'string' || !content.trim()) {
    return Response.json({ error: 'title and content are required' }, { status: 400 });
  }
  // Publishing to org-wide visibility from this unauthenticated route would let
  // any visitor inject content into the org context layer. Everything this app
  // creates is private; org promotion needs an authenticated admin/OAuth path.
  if (body.access === 'organization') {
    return Response.json(
      { error: 'This app only creates private guides — org-wide guides are curated by admins.' },
      { status: 403 },
    );
  }

  try {
    const client = await createMCPClient(getSessionHint(request));
    try {
      const args: Record<string, unknown> = { title: title.trim(), content, access: 'user' };
      if (typeof body.topic === 'string' && body.topic.trim()) args.topic = body.topic.trim();
      if (typeof body.description === 'string') args.description = body.description;
      if (Array.isArray(body.references)) args.references = body.references;
      if (typeof body.changeComment === 'string') args.change_comment = body.changeComment;
      const res = await callWrite(client, 'create_guide', args);
      if (!res.ok) return Response.json({ error: res.error }, { status: 400 });
      return Response.json({ ok: true, guide: res.data.guide ?? null });
    } finally {
      try { await client.close(); } catch { /* ignore */ }
    }
  } catch (error) {
    console.error('[Guides] POST error:', error);
    if (isAuthError(error)) return authExpiredResponse();
    return Response.json({ error: error instanceof Error ? error.message : 'Failed to create guide' }, { status: 500 });
  }
}

/**
 * Update one guide, identified by uuid. Orchestrates up to two tools, each
 * optional and independently error-reported so a partial failure is visible
 * while other edits still land:
 *   1. content/references         → update_guide (appends a new version)
 *   2. title/description/topic    → update_guide_metadata
 * Access changes are not supported here: promotion to org is blocked outright,
 * and everything the app creates is already private.
 */
export async function PATCH(request: NextRequest) {
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return Response.json({ error: 'Invalid JSON body' }, { status: 400 }); }
  const uuid = body.uuid;
  if (typeof uuid !== 'string' || !uuid.trim()) return Response.json({ error: 'uuid is required' }, { status: 400 });
  if (body.access === 'organization') {
    return Response.json(
      { error: 'Promoting a guide to org-wide visibility requires an authenticated admin/OAuth path — this app cannot publish to the org context layer.' },
      { status: 403 },
    );
  }

  const steps: Array<{ step: string; ok: boolean; error?: string }> = [];

  try {
    const client = await createMCPClient(getSessionHint(request));
    try {
      const hasContent = typeof body.content === 'string';
      const hasRefs = Array.isArray(body.references);
      if (hasContent || hasRefs) {
        const args: Record<string, unknown> = { uuid };
        if (hasContent) args.content = body.content;
        if (hasRefs) args.references = body.references;
        if (typeof body.changeComment === 'string') args.change_comment = body.changeComment;
        const res = await callWrite(client, 'update_guide', args);
        steps.push({ step: 'content', ok: res.ok, ...(res.ok ? {} : { error: res.error }) });
      }

      const meta: Record<string, unknown> = { uuid };
      let hasMeta = false;
      if (typeof body.title === 'string') { meta.title = body.title; hasMeta = true; }
      if (typeof body.description === 'string') { meta.description = body.description; hasMeta = true; }
      if (typeof body.topic === 'string') { meta.topic = body.topic; hasMeta = true; }
      if (hasMeta) {
        const res = await callWrite(client, 'update_guide_metadata', meta);
        steps.push({ step: 'metadata', ok: res.ok, ...(res.ok ? {} : { error: res.error }) });
      }

      const failed = steps.filter((s) => !s.ok);
      return Response.json({
        ok: failed.length === 0,
        uuid,
        steps,
        ...(failed.length > 0 && { error: failed.map((s) => `${s.step}: ${s.error}`).join('; ') }),
      });
    } finally {
      try { await client.close(); } catch { /* ignore */ }
    }
  } catch (error) {
    console.error('[Guides] PATCH error:', error);
    if (isAuthError(error)) return authExpiredResponse();
    return Response.json({ error: error instanceof Error ? error.message : 'Failed to update guide' }, { status: 500 });
  }
}

/** Soft-delete a guide by uuid (version history is preserved server-side). */
export async function DELETE(request: NextRequest) {
  const uuid = request.nextUrl.searchParams.get('uuid');
  if (!uuid) return Response.json({ error: 'uuid query param is required' }, { status: 400 });

  try {
    const client = await createMCPClient(getSessionHint(request));
    try {
      const res = await callWrite(client, 'delete_guide', { uuid });
      if (!res.ok) return Response.json({ error: res.error }, { status: 400 });
      return Response.json({ ok: true });
    } finally {
      try { await client.close(); } catch { /* ignore */ }
    }
  } catch (error) {
    console.error('[Guides] DELETE error:', error);
    if (isAuthError(error)) return authExpiredResponse();
    return Response.json({ error: error instanceof Error ? error.message : 'Failed to delete guide' }, { status: 500 });
  }
}
