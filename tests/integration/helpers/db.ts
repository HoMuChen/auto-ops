import { randomUUID } from 'node:crypto';
import { db, sql } from '../../../src/db/client.js';
import { tenantMembers, tenants, users } from '../../../src/db/schema/index.js';
import type { SubscriptionPlan, UserRole } from '../../../src/db/schema/index.js';

/**
 * App-level tables we created. Truncated CASCADE so FK chains clear in any order.
 */
const APP_TABLES = [
  'tenant_credentials',
  'agent_configs',
  'messages',
  'task_logs',
  'tasks',
  'tenant_members',
  'tenants',
  'users',
] as const;

/**
 * LangGraph PostgresSaver tables. Names taken from the saver's setup.sql; we
 * try-and-skip in case a future LangGraph version changes them.
 */
const LANGGRAPH_TABLES = ['checkpoints', 'checkpoint_writes', 'checkpoint_blobs'] as const;

export async function truncateAll(): Promise<void> {
  // Quiet the per-table "truncate cascades to ..." notices so test output stays
  // readable. SET LOCAL would scope this to a transaction; SET (session) is
  // fine here because the helper holds a single connection from the pool.
  await sql.unsafe('SET client_min_messages = warning');
  for (const t of APP_TABLES) {
    await sql.unsafe(`TRUNCATE TABLE ${t} RESTART IDENTITY CASCADE`);
  }
  for (const t of LANGGRAPH_TABLES) {
    await sql.unsafe(`TRUNCATE TABLE ${t} RESTART IDENTITY CASCADE`).catch(() => {
      // table may not exist yet on first ever run — fine.
    });
  }
}

export interface SeededTenant {
  tenantId: string;
  userId: string;
  email: string;
  slug: string;
  role: UserRole;
}

/**
 * Insert a user + tenant + tenant_members row for tests that don't want to go
 * through `POST /v1/tenants`. Returns ids needed by the test caller.
 */
export async function seedTenantWithOwner(opts?: {
  tenantName?: string;
  slug?: string;
  plan?: SubscriptionPlan;
  email?: string;
  role?: UserRole;
}): Promise<SeededTenant> {
  const userId = randomUUID();
  const tenantId = randomUUID();
  const email = opts?.email ?? `${randomUUID().slice(0, 8)}@test.local`;
  const slug = opts?.slug ?? `t-${randomUUID().slice(0, 8)}`;
  const role: UserRole = opts?.role ?? 'owner';

  await db.insert(users).values({ id: userId, email });
  await db.insert(tenants).values({
    id: tenantId,
    name: opts?.tenantName ?? 'Test Tenant',
    slug,
    plan: opts?.plan ?? 'basic',
  });
  await db.insert(tenantMembers).values({ tenantId, userId, role });

  return { tenantId, userId, email, slug, role };
}
