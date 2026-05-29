import { NextRequest } from 'next/server';
import { verifyCapability } from '@/lib/dive-query-capability';
import { runDiveQuery } from '@/lib/motherduck-sql';
import { isReadOnlySql } from '@/lib/sql-guard';
import { isAuthError } from '@/lib/api-helpers';

/**
 * POST /api/dives/query — server-side query proxy for the Dive viewer.
 *
 * The Dive runs in a sandboxed (opaque-origin) iframe with no session cookie,
 * so it authenticates with a short-lived encrypted **capability** (minted by
 * the viewer page) rather than a cookie. We recover the user's token from the
 * capability server-side, mint the MotherDuck SLT there, and run the dive's
 * SQL — so the MotherDuck token never reaches the browser.
 *
 * - capability must decrypt + be unexpired (unguessable; a malicious site
 *   can't forge one), so no cookie / same-origin check is needed;
 * - only read-only SQL is allowed (the SLT is read/write, but a shared dive
 *   must not be able to mutate);
 * - CORS `*` lets the opaque-origin iframe read the JSON — auth is the
 *   capability, not the origin.
 *
 * The request is sent as text/plain so the browser skips the CORS preflight.
 */

const CORS = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };

export async function POST(req: NextRequest) {
  let body: { capability?: unknown; sql?: unknown; diveId?: unknown };
  try {
    body = JSON.parse(await req.text());
  } catch {
    return Response.json({ error: 'Invalid request body' }, { status: 400, headers: CORS });
  }

  const capability = typeof body.capability === 'string' ? body.capability : '';
  const sql = typeof body.sql === 'string' ? body.sql : '';
  const diveId = typeof body.diveId === 'string' ? body.diveId : '';

  if (!capability || !sql) {
    return Response.json({ error: 'capability and sql are required' }, { status: 400, headers: CORS });
  }

  const verified = verifyCapability(capability);
  if (!verified) {
    return Response.json({ error: 'invalid or expired capability' }, { status: 401, headers: CORS });
  }

  // Bind the capability to its dive: it can only be used for the dive it was
  // minted for.
  if (diveId && diveId !== verified.diveId) {
    return Response.json({ error: 'capability/dive mismatch' }, { status: 401, headers: CORS });
  }

  if (!isReadOnlySql(sql)) {
    return Response.json({ error: 'only read-only queries are allowed' }, { status: 400, headers: CORS });
  }

  try {
    // requiredDatabases come from the capability (server-parsed from the dive
    // source), NOT from the iframe — a capability holder can't ATTACH arbitrary
    // shares.
    const rows = await runDiveQuery(verified.accessToken, sql, verified.requiredDatabases);
    return Response.json({ rows }, { headers: CORS });
  } catch (error) {
    if (isAuthError(error)) {
      return Response.json({ error: 'auth_expired' }, { status: 401, headers: CORS });
    }
    console.error('[DiveQuery] Error:', error);
    return Response.json({ error: 'Query failed' }, { status: 500, headers: CORS });
  }
}
