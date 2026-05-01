import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    // Default config = unit tests only. Integration tests live under
    // tests/integration and are run via `pnpm test:integration` (which sets
    // a different setup file and disables file parallelism for DB safety).
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/integration/**', 'tests/smoke/**', 'node_modules', 'dist'],
    setupFiles: ['./tests/setup.ts'],
    pool: 'forks',
    reporters: 'default',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', 'src/db/migrate.ts', 'src/server.ts', 'src/**/types.ts'],
    },
  },
});
