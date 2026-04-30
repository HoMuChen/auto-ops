import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '../config/env.js';
import * as schema from './schema/index.js';

/**
 * Two postgres clients:
 *
 * - `sql` — the default app pool, used for almost all reads/writes. Tenant context
 *   is propagated via a per-transaction `SET LOCAL app.tenant_id`.
 * - `sqlSystem` — a session-bound client used for system-level work (worker
 *   polling across tenants, migrations). Connects with the auto_ops_worker role
 *   if available, which has BYPASSRLS.
 *
 * For MVP we only wire `sql`. `sqlSystem` is exposed so the worker can opt out
 * of RLS once a privileged role is provisioned.
 */
const connectionUrl = env.DATABASE_POOL_URL ?? env.DATABASE_URL;

export const sql = postgres(connectionUrl, {
  max: 20,
  idle_timeout: 30,
  prepare: false,
});

export const db = drizzle(sql, { schema });

export type Database = typeof db;
export { schema };
