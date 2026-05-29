import { getStoredTokens } from '@/lib/motherduck-oauth';
import { mintCapability } from '@/lib/dive-query-capability';
import { createMCPClient, executeToolWithStatus } from '@/lib/mcp-client';
import { buildDiveViewerHtml, buildDiveViewerCsp, extractRequiredDatabases } from '@/lib/dive-viewer';
import { NextRequest } from 'next/server';

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * GET /api/dives/view?id=DIVE_UUID — serve the Dive viewer HTML.
 *
 * Fetches the dive source via `view_dive` (the user's token), mints a
 * short-lived encrypted capability the sandboxed viewer uses to call the query
 * proxy, and returns the renderer HTML. No MotherDuck token is embedded.
 */
export async function GET(request: NextRequest) {
  const tokens = await getStoredTokens();
  if (!tokens) {
    return new Response('Not authenticated', { status: 401 });
  }

  const diveId = request.nextUrl.searchParams.get('id');
  if (!diveId || !UUID_RE.test(diveId)) {
    return new Response('Missing or invalid ?id=DIVE_UUID', { status: 400 });
  }

  let client;
  try {
    client = await createMCPClient(tokens.access_token);
    const diveResult = await executeToolWithStatus(client, 'view_dive', { dive_id: diveId });
    if (diveResult.isError || !diveResult.text) {
      return new Response(`view_dive failed: ${diveResult.text || 'no response'}`, { status: 502 });
    }

    let parsed: { source?: string; title?: string };
    try {
      parsed = JSON.parse(diveResult.text);
    } catch {
      return new Response('view_dive returned an unparseable response', { status: 502 });
    }
    if (!parsed.source) {
      return new Response('view_dive response missing `source`', { status: 502 });
    }

    const appOrigin = request.nextUrl.origin;
    // Parse the dive's required shares server-side and bind them into the
    // capability, so the proxy ATTACHes exactly these (not iframe-supplied ones).
    const requiredDatabases = extractRequiredDatabases(parsed.source)
      .filter((d): d is { path: string; alias: string } =>
        typeof d.path === 'string' && typeof d.alias === 'string')
      .map((d) => ({ path: d.path, alias: d.alias }));
    const capability = mintCapability(tokens.access_token, diveId, requiredDatabases);
    const html = buildDiveViewerHtml({
      source: parsed.source,
      title: parsed.title || 'Dive',
      diveId,
      capability,
      appOrigin,
    });

    return new Response(html, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        // Sandbox + isolate the response itself (so it's isolated even opened
        // directly), and constrain where the page can talk to.
        'Content-Security-Policy': buildDiveViewerCsp(appOrigin),
        // The capability is short-lived but still per-user; don't cache.
        'Cache-Control': 'private, no-store',
        Vary: 'Cookie',
      },
    });
  } catch (error) {
    console.error('[Dive View] Error:', error);
    return new Response(`Error: ${error instanceof Error ? error.message : String(error)}`, { status: 500 });
  } finally {
    if (client) try { await client.close(); } catch { /* */ }
  }
}
