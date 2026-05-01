/**
 * Integration test setup.
 *
 * Loads .env (so DATABASE_URL / SUPABASE_JWT_SECRET / OPENROUTER_API_KEY come
 * from the developer's actual config), confirms the local Supabase is reachable,
 * and ensures LangGraph's checkpoint tables exist before tests start truncating.
 *
 * Runs once per test file (because each file is a separate vitest worker).
 */
import 'dotenv/config';
import postgres from 'postgres';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    'Integration tests require DATABASE_URL in .env. Run `supabase start` and `pnpm db:migrate`.',
  );
}

// Hard guard: integration tests TRUNCATE every app table between cases. Refuse
// to run against anything that isn't unmistakably a local DB. No env-var escape
// hatch by design — if a remote test DB is ever wanted, edit this allowlist
// explicitly so the change shows up in code review.
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const dbHost = new URL(databaseUrl).hostname;
if (!LOCAL_HOSTS.has(dbHost)) {
  throw new Error(
    `Integration tests refused: DATABASE_URL host is "${dbHost}", not local. These tests TRUNCATE every app table — running them against a non-local DB would destroy data. Point DATABASE_URL at the local Supabase CLI (127.0.0.1:54322) and try again.`,
  );
}

// Quick connectivity probe before tests start, so failures surface clearly.
const probe = postgres(databaseUrl, { max: 1, idle_timeout: 1, connect_timeout: 5 });
try {
  await probe`SELECT 1`;
} catch (err) {
  await probe.end({ timeout: 1 }).catch(() => {});
  throw new Error(
    `Cannot connect to ${databaseUrl}. Is local Supabase running? (\`supabase start\`)\nUnderlying error: ${
      err instanceof Error ? err.message : String(err)
    }`,
  );
}
await probe.end({ timeout: 1 }).catch(() => {});

// Pre-create the LangGraph checkpoint tables once. The test helpers truncate
// them between cases; truncation needs the tables to exist.
const { getCheckpointer } = await import('../../src/orchestrator/checkpointer.js');
await getCheckpointer();
