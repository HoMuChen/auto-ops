import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { type NewTenantImage, type TenantImage, tenantImages } from '../../db/schema/index.js';

export async function insertImage(
  input: Omit<NewTenantImage, 'id' | 'createdAt'>,
): Promise<TenantImage> {
  const [row] = await db.insert(tenantImages).values(input).returning();
  if (!row) throw new Error('Failed to insert tenant_image');
  return row;
}

export async function getImageById(tenantId: string, id: string): Promise<TenantImage | null> {
  const [row] = await db
    .select()
    .from(tenantImages)
    .where(and(eq(tenantImages.id, id), eq(tenantImages.tenantId, tenantId)))
    .limit(1);
  return row ?? null;
}

export async function getImagesByIds(tenantId: string, ids: string[]): Promise<TenantImage[]> {
  if (ids.length === 0) return [];
  return db
    .select()
    .from(tenantImages)
    .where(and(eq(tenantImages.tenantId, tenantId), inArray(tenantImages.id, ids)));
}

export async function getImagesByTaskId(tenantId: string, taskId: string): Promise<TenantImage[]> {
  return db
    .select()
    .from(tenantImages)
    .where(and(eq(tenantImages.tenantId, tenantId), eq(tenantImages.taskId, taskId)));
}
