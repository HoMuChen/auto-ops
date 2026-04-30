/**
 * Vitest global setup.
 *
 * Provides minimal env defaults so modules that read env at import time
 * (db client, model registry) can be loaded without a real .env. Tests that
 * need real values override these per-test or via mocks.
 */
process.env.NODE_ENV ??= 'test';
process.env.LOG_LEVEL ??= 'error';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test_db';
process.env.SUPABASE_URL ??= 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY ??= 'test-anon-key';
process.env.SUPABASE_JWT_SECRET ??= 'test-jwt-secret-do-not-use-in-prod';
process.env.OPENROUTER_API_KEY ??= 'test-openrouter-key';
process.env.WORKER_POLL_INTERVAL_MS ??= '60000';
