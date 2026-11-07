import { defineConfig } from 'vitest/config';

// Safe, no-registry immutable provenance fixture. The default monorepo
// vitest.config.ts globalSetup creates SAVEPOINT Git commits and rewrites the
// calling worktree; never import it here or run it on retained source.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['immutable-output.test.ts'],
    testTimeout: 45_000,
  },
});
