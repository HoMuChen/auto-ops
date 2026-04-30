import { sql } from 'drizzle-orm';
import { db } from './client.js';

/**
 * Run `fn` inside a transaction with `app.tenant_id` set to `tenantId`.
 * The RLS policies in 0001_rls_policies.sql read this setting to enforce isolation.
 *
 * Use this for every request-scoped tenant operation. The application layer is the
 * primary enforcement mechanism; RLS is the safety net.
 */
export async function withTenantContext<T>(
  tenantId: string,
  fn: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
    return fn(tx);
  });
}
