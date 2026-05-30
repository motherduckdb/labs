/**
 * Single source of truth for MotherDuck environment URLs.
 * Drives the MCP client and OAuth discovery.
 */

export function getMotherDuckApiUrl(): string {
  // Trim defensively — env vars can pick up stray whitespace/newlines.
  const explicit = process.env.MOTHERDUCK_API_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, '');

  // Default to PRODUCTION. (Set MOTHERDUCK_API_URL to the staging host to opt
  // into staging.)
  return 'https://api.motherduck.com';
}

export function getMotherDuckMcpUrl(): string {
  return `${getMotherDuckApiUrl()}/mcp`;
}
