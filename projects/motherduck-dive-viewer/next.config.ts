import type { NextConfig } from 'next';

// The Dive viewer renders inside a sandboxed iframe via the WASM client; it
// needs no COOP/COEP headers (DuckDB-Wasm falls back to a
// non-SharedArrayBuffer bundle when the page isn't cross-origin-isolated).
// Server-side data access uses the pure-JS `pg` client over MotherDuck's
// Postgres endpoint, so there's no native module to mark external.
const nextConfig: NextConfig = {};

export default nextConfig;
