/**
 * Guides endpoint — the context layer for the schema-explorer sidebar, plus the
 * human-driven guide editor.
 *
 *  - `GET  /api/guides`                    → list_guides() → { guides, tree, username }
 *  - `GET  /api/guides?path=foo.md`        → get_guide(path) → { path, content, version }
 *  - `GET  /api/guides?path=foo.md&version=2` → a specific prior version (org text, no overlay)
 *  - `POST /api/guides`                    → create_guide(...) (personal path only)
 *  - `PATCH /api/guides`                   → update content/metadata/access of one guide
 *  - `DELETE /api/guides?path=foo.md`      → delete_guide(path)
 *
 * Guides are MotherDuck's curated org + personal markdown about the data; they
 * replaced the old IndexedDB context fragments. Write tools run server-side with
 * the app token (internal — bypasses the LLM allowlist); the personal-guide
 * guard in `assertGuideWriteAllowed` still applies to create/update.
 *
 * The per-session id arrives in the `x-session-id` header and is threaded into
 * the MCP connection as a session hint.
 */
import { createMCPClient, executeToolWithStatus, isPersonalGuidePath } from '@/lib/mcp-client';
import { isAuthError, authExpiredResponse, getSessionHint } from '@/lib/api-helpers';
import { NextRequest } from 'next/server';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

export interface GuideSummary {
  path: string;
  title: string;
  description: string;
  access: string;
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

/** get_guide's text header is "<title>\n<path · vN · access>\n\n…" — pull N. */
function parseVersion(content: string): number | null {
  const m = content.match(/·\s*v(\d+)\s*·/);
  return m ? Number(m[1]) : null;
}

/**
 * Route-level authorization for mutating verbs. This route runs every browser
 * request with the server MotherDuck token via the internal MCP bypass, and the
 * app has no per-user auth in front of it, so confine all guide mutations to the
 * personal namespace (`users/…`). Org-wide guides are read-only from the app;
 * managing them needs an admin/OAuth path out of band. Returns a 403 Response on
 * violation, or null when the path(s) are allowed.
 */
function rejectNonPersonal(...paths: unknown[]): Response | null {
  for (const p of paths) {
    if (p === undefined) continue;
    if (!isPersonalGuidePath(p)) {
      return Response.json(
        { error: `Guide mutations are limited to personal guides under "users/<username>/…" (got "${typeof p === 'string' ? p : '(none)'}"). Org-wide guides are read-only from this app.` },
        { status: 403 },
      );
    }
  }
  return null;
}

/** First `users/<name>/…` path in the guide list — the caller's personal namespace. */
function deriveUsername(guides: GuideSummary[]): string | null {
  for (const g of guides) {
    const m = g.path.match(/^users\/([^/]+)\//);
    if (m) return m[1];
  }
  return null;
}

/**
 * Run one guide-write tool and normalize the result. Surfaces both transport
 * errors (`isError`) and payload-level `{success:false}` so the UI can show the
 * server's message (e.g. org-promote denied for non-admins).
 */
async function callWrite(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; error: string }> {
  const { text, isError } = await executeToolWithStatus(client, name, args, true);
  const data = parseJson(text);
  if (isError || data.success === false) {
    const msg = typeof data.error === 'string' ? data.error
      : typeof data.message === 'string' ? data.message
      : text || `${name} failed`;
    return { ok: false, error: msg };
  }
  return { ok: true, data };
}

export async function GET(request: NextRequest) {
  const path = request.nextUrl.searchParams.get('path') || undefined;
  const versionParam = request.nextUrl.searchParams.get('version');

  try {
    const client = await createMCPClient(getSessionHint(request));
    try {
      if (path) {
        const args: Record<string, unknown> = { path };
        if (versionParam) {
          args.version = Number(versionParam);
          args.merge_overlays = false; // version reads target the stored org guide
        }
        const { text } = await executeToolWithStatus(client, 'get_guide', args, true);
        const parsed = parseJson(text);
        const content = typeof parsed.text === 'string' ? parsed.text : text;
        return Response.json({ path, content, version: parseVersion(content) });
      }
      const { text } = await executeToolWithStatus(client, 'list_guides', {}, true);
      const parsed = parseJson(text);
      const guides = Array.isArray(parsed.guides) ? (parsed.guides as GuideSummary[]) : [];
      const tree = typeof parsed.tree === 'string' ? parsed.tree : '';
      return Response.json({ guides, tree, username: deriveUsername(guides) });
    } finally {
      try { await client.close(); } catch { /* ignore */ }
    }
  } catch (error) {
    console.error('[Guides] GET error:', error);
    if (isAuthError(error)) return authExpiredResponse();
    return Response.json({ error: 'Failed to fetch guides' }, { status: 500 });
  }
}

/** Create a new (personal) guide. */
export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return Response.json({ error: 'Invalid JSON body' }, { status: 400 }); }
  const { path, title, content } = body;
  if (typeof path !== 'string' || typeof title !== 'string' || typeof content !== 'string') {
    return Response.json({ error: 'path, title, and content are required' }, { status: 400 });
  }
  const denied = rejectNonPersonal(path);
  if (denied) return denied;

  try {
    const client = await createMCPClient(getSessionHint(request));
    try {
      const args: Record<string, unknown> = { path, title, content };
      if (typeof body.description === 'string') args.description = body.description;
      if (Array.isArray(body.references)) args.references = body.references;
      if (typeof body.access === 'string') args.access = body.access;
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
 * Update one guide. Orchestrates up to three tools, each optional and
 * independently error-reported so a partial failure (e.g. org-promote denied)
 * is visible while other edits still land:
 *   1. content/references → update_guide (new version)
 *   2. access             → set_guide_access
 *   3. title/description/rename → update_guide_metadata
 * All identify by the ORIGINAL path, so the rename runs last.
 */
export async function PATCH(request: NextRequest) {
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return Response.json({ error: 'Invalid JSON body' }, { status: 400 }); }
  const path = body.path;
  if (typeof path !== 'string') return Response.json({ error: 'path is required' }, { status: 400 });
  // Both the current path and any rename target must stay in the personal namespace.
  const denied = rejectNonPersonal(path, body.newPath);
  if (denied) return denied;
  // Publishing to org-wide visibility from this unauthenticated route would let
  // any visitor inject content into the org context layer. Block org promotion
  // outright; visibility changes need an authenticated admin/OAuth path. Demote
  // to 'user' (de-escalation) is still permitted.
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
        const args: Record<string, unknown> = { path };
        if (hasContent) args.content = body.content;
        if (hasRefs) args.references = body.references;
        if (typeof body.changeComment === 'string') args.change_comment = body.changeComment;
        const res = await callWrite(client, 'update_guide', args);
        steps.push({ step: 'content', ok: res.ok, ...(res.ok ? {} : { error: res.error }) });
      }

      if (typeof body.access === 'string') {
        const res = await callWrite(client, 'set_guide_access', { path, access: body.access });
        // Demote-to-personal makes the server resolve the caller's username from
        // auth; a read-scaling PAT has no username claim, so it fails where
        // promote-to-org (no username needed) succeeds. Make that actionable.
        const err = !res.ok && body.access === 'user' && /no authenticated username/i.test(res.error)
          ? 'Couldn’t demote to personal: the server resolved no username for this connection’s token, so it can’t re-scope the guide to users/<you>/. Promote-to-org needs no username and succeeds, making it one-way here — restore to personal from an OAuth session or ask an org admin. (Fix: give the app a user-scoped/OAuth token, not a read-scaling one.)'
          : res.ok ? undefined : res.error;
        steps.push({ step: 'access', ok: res.ok, ...(err ? { error: err } : {}) });
      }

      const meta: Record<string, unknown> = { path };
      let hasMeta = false;
      if (typeof body.title === 'string') { meta.title = body.title; hasMeta = true; }
      if (typeof body.description === 'string') { meta.description = body.description; hasMeta = true; }
      if (typeof body.newPath === 'string' && body.newPath && body.newPath !== path) { meta.new_path = body.newPath; hasMeta = true; }
      if (hasMeta) {
        const res = await callWrite(client, 'update_guide_metadata', meta);
        steps.push({ step: 'metadata', ok: res.ok, ...(res.ok ? {} : { error: res.error }) });
      }

      const effectivePath = typeof body.newPath === 'string' && body.newPath ? body.newPath : path;
      const failed = steps.filter((s) => !s.ok);
      return Response.json({
        ok: failed.length === 0,
        path: effectivePath,
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

/** Soft-delete a guide by path. */
export async function DELETE(request: NextRequest) {
  const path = request.nextUrl.searchParams.get('path');
  if (!path) return Response.json({ error: 'path query param is required' }, { status: 400 });
  const denied = rejectNonPersonal(path);
  if (denied) return denied;

  try {
    const client = await createMCPClient(getSessionHint(request));
    try {
      const res = await callWrite(client, 'delete_guide', { path });
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
