import { describe, expect, it } from 'vitest';
import { insertImage, getImageById, getImagesByTaskId } from '../../src/integrations/cloudflare/images-repository.js';
import { truncateAll, seedTenantWithOwner } from './helpers/db.js';

async function seedTenant() {
  const s = await seedTenantWithOwner();
  return { id: s.tenantId };
}

describe('images repository', () => {
  it('inserts and retrieves by id', async () => {
    await truncateAll();
    const tenant = await seedTenant();
    const img = await insertImage({
      tenantId: tenant.id,
      cfImageId: 'cf-abc',
      url: 'https://imagedelivery.net/hash/cf-abc/public',
      sourceType: 'uploaded',
    });
    expect(img.id).toBeDefined();
    const fetched = await getImageById(tenant.id, img.id);
    expect(fetched?.cfImageId).toBe('cf-abc');
  });

  it('returns null for unknown id', async () => {
    await truncateAll();
    const tenant = await seedTenant();
    const result = await getImageById(tenant.id, '00000000-0000-0000-0000-000000000000');
    expect(result).toBeNull();
  });

  it('fetches all images for a task', async () => {
    await truncateAll();
    const tenant = await seedTenant();
    const { db } = await import('../../src/db/client.js');
    const { tasks } = await import('../../src/db/schema/index.js');
    const [task] = await db.insert(tasks).values({
      tenantId: tenant.id, title: 'test', kind: 'execution', status: 'todo', input: {},
    }).returning();
    await insertImage({ tenantId: tenant.id, cfImageId: 'img1', url: 'u1', sourceType: 'generated', taskId: task!.id });
    await insertImage({ tenantId: tenant.id, cfImageId: 'img2', url: 'u2', sourceType: 'generated', taskId: task!.id });
    const imgs = await getImagesByTaskId(tenant.id, task!.id);
    expect(imgs).toHaveLength(2);
  });
});
