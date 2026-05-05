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
      .values({ name: 'Test', slug: `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` })
      .returning();
    tenantId = t!.id;
  });

  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.id, tenantId));
  });

  it('returns defaults for a fresh tenant', async () => {
    const profile = await getTenantProfile(tenantId);
    expect(profile).toEqual({ profileMd: '', timezone: 'UTC' });
  });

  it('updates profileMd and timezone', async () => {
    const updated = await updateTenantProfile(tenantId, {
      profileMd: '# Voice\n\nWarm.',
      timezone: 'Asia/Taipei',
    });
    expect(updated.profileMd).toContain('Warm');
    expect(updated.timezone).toBe('Asia/Taipei');

    // Round-trip
    const fetched = await getTenantProfile(tenantId);
    expect(fetched).toEqual(updated);
  });

  it('partial update preserves untouched fields', async () => {
    await updateTenantProfile(tenantId, { profileMd: 'first' });
    const after = await updateTenantProfile(tenantId, { timezone: 'Asia/Tokyo' });
    expect(after.profileMd).toBe('first');
    expect(after.timezone).toBe('Asia/Tokyo');
  });
});
