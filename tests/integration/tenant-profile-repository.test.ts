import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { tenants } from '../../src/db/schema/index.js';
import { getTenantProfile, updateTenantProfile } from '../../src/tenants/profile-repository.js';

describe('tenant-profile-repository', () => {
  let tenantId: string;

  beforeEach(async () => {
    const [t] = await db
      .insert(tenants)
      .values({
        name: 'Test',
        slug: `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      })
      .returning();
    tenantId = t!.id;
  });

  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.id, tenantId));
  });

  it('returns defaults for a fresh tenant including image style fields', async () => {
    const profile = await getTenantProfile(tenantId);
    expect(profile).toEqual({
      profileMd: '',
      timezone: 'UTC',
      imageStyleSuffix: '',
      imageStyleReferenceImageIds: [],
    });
  });

  it('updates all fields and round-trips', async () => {
    const updated = await updateTenantProfile(tenantId, {
      profileMd: '# Voice\n\nWarm.',
      timezone: 'Asia/Taipei',
      imageStyleSuffix: 'Editorial product photography. Soft daylight.',
      imageStyleReferenceImageIds: [],
    });
    expect(updated.imageStyleSuffix).toContain('Editorial');
    const fetched = await getTenantProfile(tenantId);
    expect(fetched).toEqual(updated);
  });

  it('partial update preserves untouched fields', async () => {
    await updateTenantProfile(tenantId, { profileMd: 'first' });
    const after = await updateTenantProfile(tenantId, {
      imageStyleSuffix: 'White seamless.',
    });
    expect(after.profileMd).toBe('first');
    expect(after.imageStyleSuffix).toBe('White seamless.');
    expect(after.timezone).toBe('UTC');
    expect(after.imageStyleReferenceImageIds).toEqual([]);
  });

  it('updates imageStyleReferenceImageIds array independently', async () => {
    const id1 = '00000000-0000-0000-0000-000000000001';
    const id2 = '00000000-0000-0000-0000-000000000002';
    const after = await updateTenantProfile(tenantId, {
      imageStyleReferenceImageIds: [id1, id2],
    });
    expect(after.imageStyleReferenceImageIds).toEqual([id1, id2]);
  });
});
