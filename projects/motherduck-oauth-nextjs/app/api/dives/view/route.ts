import { createMCPClient, executeToolWithStatus } from '@/lib/mcp-client';
import { getStoredTokens } from '@/lib/motherduck-oauth';
import { buildDiveViewerHtml } from '@/lib/dive-viewer';
import { getMotherDuckApiUrl } from '@/lib/motherduck-env';
import { NextRequest } from 'next/server';

/**
 * Serve a Dive as a standalone HTML page rendered with the MotherDuck WASM
 * client — scoped to the signed-in user (their OAuth token).
 * GET /api/dives/view?id=DIVE_UUID
 *
 * Fetches the dive source (`view_dive`) and a short-lived token
 * (`get_short_lived_token`) over MCP, then builds an HTML page that runs the
 * dive's queries in-browser via @motherduck/wasm-client. The HTML is iframed
 * by the /dives/[id] page.
 */
export async function GET(request: NextRequest) {
  const tokens = await getStoredTokens();
  if (!tokens) {
    return new Response('Not authenticated', { status: 401 });
  }

  const diveId = request.nextUrl.searchParams.get('id');
  if (!diveId) {
    return new Response('Missing ?id=DIVE_UUID', { status: 400 });
  }

  let client;
  try {
    client = await createMCPClient(tokens.access_token);

    // Fetch dive source and SLT in parallel.
    const [diveResult, sltResult] = await Promise.all([
      executeToolWithStatus(client, 'view_dive', { dive_id: diveId }),
      executeToolWithStatus(client, 'get_short_lived_token', {}),
    ]);

    if (diveResult.isError || !diveResult.text) {
      return new Response(`view_dive failed: ${diveResult.text || 'no response'}`, { status: 502 });
    }

    let parsed: { source?: string; title?: string; slt?: string };
    try {
      parsed = JSON.parse(diveResult.text);
    } catch (e) {
      console.error('[Dive View] Failed to parse view_dive response:', diveResult.text.slice(0, 200));
      return new Response(
        `view_dive returned an unparseable response: ${e instanceof Error ? e.message : String(e)}`,
        { status: 502 },
      );
    }

    if (!parsed.source) {
      return new Response('view_dive response missing `source` field', { status: 502 });
    }

    // SLT: prefer explicit get_short_lived_token, fall back to view_dive's
    // own slt field if the helper call failed.
    let slt = parsed.slt || '';
    if (!sltResult.isError && sltResult.text) {
      try {
        const sltParsed = JSON.parse(sltResult.text);
        slt = sltParsed.shortLivedToken || sltParsed.token || sltParsed.slt || slt;
      } catch {
        /* use view_dive's slt if available */
      }
    }

    const html = buildDiveViewerHtml({
      source: parsed.source,
      title: parsed.title || 'Dive',
      diveId,
      slt,
      mdServerURL: getMotherDuckApiUrl(),
    });

    return new Response(html, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
      },
    });
  } catch (error) {
    console.error('[Dive View] Error:', error);
    return new Response(`Error: ${error instanceof Error ? error.message : String(error)}`, { status: 500 });
  } finally {
    if (client) try { await client.close(); } catch { /* */ }
  }
}
