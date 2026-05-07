import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createPack,
  deletePack,
  listPacksForAgent,
  listTenantPacks,
  updatePack,
} from '../../src/agents/skill-packs-repository.js';
import { db } from '../../src/db/client.js';
import { tenantSkillPacks, tenants } from '../../src/db/schema/index.js';

describe('skill-packs-repository', () => {
  let tenantId: string;

  beforeEach(async () => {
    const [t] = await db
      .insert(tenants)
      .values({ name: 'Test', slug: `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` })
      .returning();
    tenantId = t!.id;
  });

  afterEach(async () => {
    await db.delete(tenantSkillPacks).where(eq(tenantSkillPacks.tenantId, tenantId));
    await db.delete(tenants).where(eq(tenants.id, tenantId));
  });

  it('creates a pack scoped to applies_to', async () => {
    const pack = await createPack(tenantId, {
      key: 'tenant.brand-guide',
      name: 'Brand Guide',
      body: '# Voice\n\nWarm.',
      appliesTo: ['article-writer'],
    });
    expect(pack.id).toBeDefined();
    expect(pack.appliesTo).toEqual(['article-writer']);
  });

  it('listPacksForAgent returns only packs with that agent in applies_to', async () => {
    await createPack(tenantId, {
      key: 'tenant.a',
      name: 'A',
      body: 'a',
      appliesTo: ['article-writer'],
    });
    await createPack(tenantId, {
      key: 'tenant.b',
      name: 'B',
      body: 'b',
      appliesTo: ['seo-strategist'],
    });
    const writerPacks = await listPacksForAgent(tenantId, 'article-writer');
    expect(writerPacks.map((p) => p.key)).toEqual(['tenant.a']);
  });

  it('updatePack patches partial fields', async () => {
    const pack = await createPack(tenantId, {
      key: 'tenant.k',
      name: 'K',
      body: 'old',
      appliesTo: [],
    });
    const updated = await updatePack(tenantId, pack.id, { body: 'new' });
    expect(updated.body).toBe('new');
    expect(updated.name).toBe('K');
  });

  it('deletePack removes the row, scoped to tenant', async () => {
    const pack = await createPack(tenantId, {
      key: 'tenant.k',
      name: 'K',
      body: 'b',
      appliesTo: [],
    });
    await deletePack(tenantId, pack.id);
    const remaining = await listTenantPacks(tenantId);
    expect(remaining).toEqual([]);
  });

  it('rejects duplicate (tenant, key) at the DB level', async () => {
    await createPack(tenantId, { key: 'tenant.dup', name: 'A', body: 'a', appliesTo: [] });
    await expect(
      createPack(tenantId, { key: 'tenant.dup', name: 'B', body: 'b', appliesTo: [] }),
    ).rejects.toThrow(/duplicate key value|tenant_skill_packs_tenant_key_uq/);
  });
});
