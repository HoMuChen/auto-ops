import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { tenants } from '../db/schema/index.js';
import { NotFoundError } from '../lib/errors.js';

export interface TenantProfile {
  profileMd: string;
  timezone: string;
}

export interface UpdateTenantProfileInput {
  profileMd?: string;
  timezone?: string;
}

export async function getTenantProfile(tenantId: string): Promise<TenantProfile> {
  const [row] = await db
    .select({ profileMd: tenants.profileMd, timezone: tenants.timezone })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  if (!row) throw new NotFoundError(`Tenant ${tenantId}`);
  return row;
}

export async function updateTenantProfile(
  tenantId: string,
  input: UpdateTenantProfileInput,
): Promise<TenantProfile> {
  const set: Record<string, unknown> = { updatedAt: sql`now()` };
  if (input.profileMd !== undefined) set.profileMd = input.profileMd;
  if (input.timezone !== undefined) set.timezone = input.timezone;

  const [row] = await db
    .update(tenants)
    .set(set)
    .where(eq(tenants.id, tenantId))
    .returning({ profileMd: tenants.profileMd, timezone: tenants.timezone });
  if (!row) throw new NotFoundError(`Tenant ${tenantId}`);
  return row;
}
