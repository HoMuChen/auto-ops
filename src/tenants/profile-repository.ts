import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { tenants } from '../db/schema/index.js';
import { NotFoundError } from '../lib/errors.js';

export interface TenantProfile {
  profileMd: string;
  timezone: string;
  imageStyleSuffix: string;
  imageStyleReferenceImageIds: string[];
}

export interface UpdateTenantProfileInput {
  profileMd?: string;
  timezone?: string;
  imageStyleSuffix?: string;
  imageStyleReferenceImageIds?: string[];
}

const profileColumns = {
  profileMd: tenants.profileMd,
  timezone: tenants.timezone,
  imageStyleSuffix: tenants.imageStyleSuffix,
  imageStyleReferenceImageIds: tenants.imageStyleReferenceImageIds,
};

export async function getTenantProfile(tenantId: string): Promise<TenantProfile> {
  const [row] = await db
    .select(profileColumns)
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
  if (input.imageStyleSuffix !== undefined) set.imageStyleSuffix = input.imageStyleSuffix;
  if (input.imageStyleReferenceImageIds !== undefined) {
    set.imageStyleReferenceImageIds = input.imageStyleReferenceImageIds;
  }

  const [row] = await db
    .update(tenants)
    .set(set)
    .where(eq(tenants.id, tenantId))
    .returning(profileColumns);
  if (!row) throw new NotFoundError(`Tenant ${tenantId}`);
  return row;
}
