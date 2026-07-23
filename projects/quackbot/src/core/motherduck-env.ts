/**
 * Single source of truth for MotherDuck environment URLs.
 * Drives MCP, OAuth discovery, and the WASM Dive renderer.
 */

export function getMotherDuckApiUrl(): string {
  // Backwards-compat: also accept the old MOTHERDUCK_MCP_URL by stripping /mcp.
  // Trim defensively — Vercel env vars can pick up stray whitespace/newlines from CLI input.
  const explicit = process.env.MOTHERDUCK_API_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, '');

  const legacyMcp = process.env.MOTHERDUCK_MCP_URL?.trim();
  if (legacyMcp) return legacyMcp.replace(/\/mcp\/?$/, '').replace(/\/$/, '');

  return 'https://api.staging.motherduck.com';
}

export function getMotherDuckMcpUrl(): string {
  return `${getMotherDuckApiUrl()}/mcp`;
}
