import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type TenantSkillPack, tenantSkillPacks } from '../db/schema/index.js';
import { NotFoundError } from '../lib/errors.js';

/**
 * Tenant-scoped CRUD for `tenant_skill_packs`.
 *
 * Every read/write filters on `tenantId` first — never trust the caller to
 * have already scoped the query. `applies_to` is a `text[]`; agent-targeted
 * lookups use Postgres array containment (`@> ARRAY[id]::text[]`) so the
 * GIN index on the column is usable.
 */

export interface CreatePackInput {
  key: string;
  name: string;
  body: string;
  appliesTo: string[];
}

export interface UpdatePackInput {
  name?: string;
  body?: string;
  appliesTo?: string[];
}

export async function createPack(
  tenantId: string,
  input: CreatePackInput,
): Promise<TenantSkillPack> {
  const [row] = await db
    .insert(tenantSkillPacks)
    .values({ tenantId, ...input })
    .returning();
  if (!row) throw new Error('skill pack insert returned no row');
  return row;
}

export async function listTenantPacks(tenantId: string): Promise<TenantSkillPack[]> {
  return db
    .select()
    .from(tenantSkillPacks)
    .where(eq(tenantSkillPacks.tenantId, tenantId))
    .orderBy(tenantSkillPacks.name);
}

export async function listPacksForAgent(
  tenantId: string,
  agentId: string,
): Promise<TenantSkillPack[]> {
  // GIN-friendly array containment: applies_to @> ARRAY[agentId]
  return db
    .select()
    .from(tenantSkillPacks)
    .where(
      and(
        eq(tenantSkillPacks.tenantId, tenantId),
        sql`${tenantSkillPacks.appliesTo} @> ARRAY[${agentId}]::text[]`,
      ),
    )
    .orderBy(tenantSkillPacks.name);
}

export async function getPack(tenantId: string, packId: string): Promise<TenantSkillPack> {
  const [row] = await db
    .select()
    .from(tenantSkillPacks)
    .where(and(eq(tenantSkillPacks.tenantId, tenantId), eq(tenantSkillPacks.id, packId)))
    .limit(1);
  if (!row) throw new NotFoundError(`Skill pack ${packId}`);
  return row;
}

export async function updatePack(
  tenantId: string,
  packId: string,
  input: UpdatePackInput,
): Promise<TenantSkillPack> {
  const [row] = await db
    .update(tenantSkillPacks)
    .set({ ...input, updatedAt: sql`now()` })
    .where(and(eq(tenantSkillPacks.tenantId, tenantId), eq(tenantSkillPacks.id, packId)))
    .returning();
  if (!row) throw new NotFoundError(`Skill pack ${packId}`);
  return row;
}

export async function deletePack(tenantId: string, packId: string): Promise<void> {
  // Use `.returning()` to detect "no row" reliably. The postgres-js drizzle
  // result doesn't expose a stable `rowCount`; checking `.length` matches the
  // pattern in api/routes/credentials.ts.
  const result = await db
    .delete(tenantSkillPacks)
    .where(and(eq(tenantSkillPacks.tenantId, tenantId), eq(tenantSkillPacks.id, packId)))
    .returning({ id: tenantSkillPacks.id });
  if (result.length === 0) throw new NotFoundError(`Skill pack ${packId}`);
}
