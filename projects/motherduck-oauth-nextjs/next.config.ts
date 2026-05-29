import type { NextConfig } from 'next';

// The Dive viewer renders inside a sandboxed iframe pointing at
// embed-motherduck.com via the WASM client — it does NOT need
// Cross-Origin-Opener/Embedder-Policy headers (DuckDB-Wasm falls back to a
// non-SharedArrayBuffer bundle when the page isn't cross-origin-isolated).
const nextConfig: NextConfig = {
  // @duckdb/node-api is a native addon — don't let the bundler trace/bundle
  // it; let Node resolve it at runtime in the server.
  serverExternalPackages: ['@duckdb/node-api', '@duckdb/node-bindings'],
};

export default nextConfig;
