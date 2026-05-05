import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { tenantImages } from '../../db/schema/index.js';
import { getTenantProfile, updateTenantProfile } from '../../tenants/profile-repository.js';
import { requireAuth } from '../middleware/auth.js';
import { requireTenant, tenantOf } from '../middleware/tenant.js';

const PROFILE_MD_MAX = 32 * 1024;
const STYLE_SUFFIX_MAX = 2 * 1024;
const MAX_REFERENCE_IMAGES = 5;
const validTimezones = new Set(Intl.supportedValuesOf('timeZone'));

const ProfileResponse = z.object({
  profileMd: z.string(),
  timezone: z.string(),
  imageStyleSuffix: z.string(),
  imageStyleReferenceImageIds: z.array(z.string().uuid()),
});

const UpdateProfileBody = z.object({
  profileMd: z.string().max(PROFILE_MD_MAX).optional(),
  timezone: z
    .string()
    .refine((tz) => validTimezones.has(tz), 'invalid IANA timezone')
    .optional(),
  imageStyleSuffix: z.string().max(STYLE_SUFFIX_MAX).optional(),
  imageStyleReferenceImageIds: z.array(z.string().uuid()).max(MAX_REFERENCE_IMAGES).optional(),
});

async function assertReferenceImagesOwned(tenantId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const rows = await db
    .select({ id: tenantImages.id })
    .from(tenantImages)
    .where(and(eq(tenantImages.tenantId, tenantId), inArray(tenantImages.id, ids)));
  if (rows.length !== ids.length) {
    const found = new Set(rows.map((r) => r.id));
    const missing = ids.filter((id) => !found.has(id));
    const err = new Error(`Reference image ids not owned by tenant: ${missing.join(', ')}`);
    (err as { statusCode?: number }).statusCode = 400;
    throw err;
  }
}

export async function profileRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);
  app.addHook('preHandler', requireTenant);

  app.get(
    '/profile',
    {
      schema: {
        tags: ['tenants'],
        response: { 200: ProfileResponse },
      },
    },
    async (req) => getTenantProfile(tenantOf(req)),
  );

  app.put(
    '/profile',
    {
      schema: {
        tags: ['tenants'],
        body: UpdateProfileBody,
        response: { 200: ProfileResponse },
      },
    },
    async (req) => {
      const body = req.body as z.infer<typeof UpdateProfileBody>;
      if (body.imageStyleReferenceImageIds) {
        await assertReferenceImagesOwned(tenantOf(req), body.imageStyleReferenceImageIds);
      }
      return updateTenantProfile(tenantOf(req), body);
    },
  );
}
