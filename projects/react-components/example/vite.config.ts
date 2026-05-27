import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

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
  optimizeDeps: {
    // wasm-client is CJS; let Vite pre-bundle so the SQL editor's runtime
    // require() call resolves correctly.
    include: ['@motherduck/wasm-client'],
  },
});
