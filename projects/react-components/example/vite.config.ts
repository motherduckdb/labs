import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import pkg from './package.json' with { type: 'json' };

// The playground imports the sibling `packages/*` sources directly (via
// relative paths, not an npm workspace), and those sources declare this
// app's runtime dependencies as peerDependencies. Because `packages/` is a
// *sibling* of `example/` rather than a descendant, Node/Vite's normal
// upward node_modules search (starting from the importing file) never
// reaches `example/node_modules`, so bare imports like `@auth0/auth0-react`
// fail to resolve during `vite build`. Alias each runtime dependency to its
// resolved location here so sources in `../packages/*/src` can find them too.
const resolveFromExample = (name: string) =>
  fileURLToPath(new URL(`./node_modules/${name}`, import.meta.url));
const dependencyAliases = Object.fromEntries(
  Object.keys(pkg.dependencies ?? {}).map((name) => [name, resolveFromExample(name)])
);

// Tiny dev-server middleware that mocks the dive-session endpoint so the
// dive-embed-private component can render its loading/expand UI without a
// real backend. The iframe itself will fail to load with this fake session;
// for a full E2E test, point sessionEndpoint at a real backend instead.
const mockSessionPlugin = () => ({
  name: 'mock-dive-session',
  configureServer(server: any) {
    server.middlewares.use('/api/dive-embed-session', (req: any, res: any) => {
      if (req.method !== 'POST') {
        res.statusCode = 405;
        return res.end();
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ session: 'mock-session-not-real' }));
    });
  },
});

export default defineConfig({
  plugins: [react(), mockSessionPlugin()],
  resolve: {
    alias: dependencyAliases,
  },
  optimizeDeps: {
    // wasm-client is CJS; let Vite pre-bundle so the SQL editor's runtime
    // require() call resolves correctly.
    include: ['@motherduck/wasm-client'],
  },
});
