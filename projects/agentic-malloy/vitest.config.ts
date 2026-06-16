import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Scope strictly to this project's tests so a monorepo-root invocation
    // doesn't pull in sibling projects (e.g. data-chat-mini's Next.js tests).
    root: import.meta.dirname,
    include: ['src/**/*.test.ts'],
    testTimeout: 120_000,
  },
});
