import { runUserQuery } from './motherduck-sql';
import { getMotherDuckApiUrl } from './motherduck-env';

/**
 * Mint a MotherDuck Dive **embed session** server-side — the documented,
 * supported way to embed a Dive
 * (https://motherduck.com/docs/key-tasks/ai-and-motherduck/dives/embedding-dives/).
 *
 * The browser never receives a MotherDuck token — only the returned opaque
 * `session` string, which carries a short-lived read-only credential and is
 * loaded inside `embed-motherduck.com`'s OWN sandboxed iframe (a different
 * origin). So arbitrary Dive code never shares a realm with our app or any
 * token; MotherDuck runs the Dive.
 *
 * `POST /v1/dives/{id}/embed-session` requires a **service-account (admin)
 * token**, kept server-side in MOTHERDUCK_EMBED_TOKEN — never the end user's
 * delegated token (the endpoint rejects non-service-account tokens). We pass
 * `username = CURRENT_USER` of the signed-in user so the embedded Dive runs
 * scoped to THEIR data. We only ever embed dive IDs that came from the user's
 * own MD_LIST_DIVES, so the admin token can't widen what they can see.
 */

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Thrown when MOTHERDUCK_EMBED_TOKEN isn't set — surfaced as a setup hint. */
export class EmbedNotConfiguredError extends Error {
  constructor() {
    super('MOTHERDUCK_EMBED_TOKEN is not configured');
    this.name = 'EmbedNotConfiguredError';
  }
}

/** Host serving the embed sandbox; override for staging via DIVE_EMBED_HOST. */
export function getEmbedHost(): string {
  return (process.env.DIVE_EMBED_HOST?.trim() || 'https://embed-motherduck.com').replace(/\/$/, '');
}

/** Build the iframe src for a minted session. */
export function embedIframeSrc(session: string): string {
  return `${getEmbedHost()}/sandbox/#session=${encodeURIComponent(session)}`;
}

export async function createEmbedSession(accessToken: string, diveId: string): Promise<string> {
  if (!UUID_RE.test(diveId)) {
    throw new Error('Invalid dive id');
  }

  const embedToken = process.env.MOTHERDUCK_EMBED_TOKEN?.trim();
  if (!embedToken) {
    throw new EmbedNotConfiguredError();
  }

  // Resolve the signed-in user's MotherDuck username (via THEIR token) so the
  // embedded dive runs as them — data scoped to what they can see.
  const rows = await runUserQuery(accessToken, 'SELECT CURRENT_USER AS username');
  const username = rows[0]?.username;
  if (typeof username !== 'string' || !username) {
    throw new Error('Could not resolve current MotherDuck user');
  }

  const res = await fetch(
    `${getMotherDuckApiUrl()}/v1/dives/${encodeURIComponent(diveId)}/embed-session`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${embedToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ username }),
    },
  );

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`embed-session failed (${res.status}): ${detail.slice(0, 300)}`);
  }

  const data = (await res.json()) as { session?: string };
  if (!data.session) {
    throw new Error('embed-session response missing `session`');
  }
  return data.session;
}
