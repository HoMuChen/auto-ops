import { config as loadDotenv } from 'dotenv';
import { defineConfig } from 'vitest/config';

// Load .env so smoke tests get real credentials without requiring manual export.
loadDotenv();

/**
 * Smoke test config — hits real OpenRouter. Costs money, slow, never run in
 * default CI. Gated by `OPENROUTER_LIVE=1` inside the test file itself, so
 * it's safe to invoke `pnpm test:smoke` without the env var (suite is empty).
 *
 * Run with:
 *   OPENROUTER_LIVE=1 OPENROUTER_API_KEY=sk-or-... pnpm test:smoke
 */
export default defineConfig({
  test: {
    name: 'smoke',
    globals: false,
    environment: 'node',
    include: ['tests/smoke/**/*.test.ts'],
    setupFiles: ['./tests/setup.ts'],
    fileParallelism: false,
    pool: 'forks',
    testTimeout: 90_000,
    hookTimeout: 30_000,
    reporters: 'default',
  },
});
