import { defineConfig } from 'vitest/config';

/**
 * Integration test config — separate from the default `vitest.config.ts` so:
 *   - Unit suite stays fast (`pnpm test`) and isolated from DB state.
 *   - Integration suite (`pnpm test:integration`) uses a real local Supabase,
 *     so it runs files serially (`fileParallelism: false`) to avoid races on
 *     the shared database. Inside one file, tests run sequentially by default.
 *
 * Pre-requisites: `supabase start` must be running, `pnpm db:migrate` applied,
 * `.env` populated. The integration setup file double-checks DATABASE_URL
 * connectivity before any test runs.
 */
export default defineConfig({
  test: {
    name: 'integration',
    globals: false,
    environment: 'node',
    include: ['tests/integration/**/*.test.ts'],
    setupFiles: ['./tests/integration/setup.ts'],
    fileParallelism: false,
    pool: 'forks',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    reporters: 'default',
  },
});
