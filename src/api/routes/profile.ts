import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getTenantProfile, updateTenantProfile } from '../../tenants/profile-repository.js';
import { requireAuth } from '../middleware/auth.js';
import { requireTenant } from '../middleware/tenant.js';

const PROFILE_MD_MAX = 32 * 1024;
const validTimezones = new Set(Intl.supportedValuesOf('timeZone'));

const TenantIdParam = z.object({ id: z.string().uuid() });

const ProfileResponse = z.object({
  profileMd: z.string(),
  timezone: z.string(),
});

const UpdateProfileBody = z.object({
  profileMd: z.string().max(PROFILE_MD_MAX).optional(),
  timezone: z
    .string()
    .refine((tz) => validTimezones.has(tz), 'invalid IANA timezone')
    .optional(),
});

export async function profileRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);
  app.addHook('preHandler', requireTenant);

  app.get(
    '/tenants/:id/profile',
    {
      schema: {
        tags: ['tenants'],
        params: TenantIdParam,
        response: { 200: ProfileResponse },
      },
    },
    async (req) => {
      const { id } = req.params as z.infer<typeof TenantIdParam>;
      return getTenantProfile(id);
    },
  );

  app.put(
    '/tenants/:id/profile',
    {
      schema: {
        tags: ['tenants'],
        params: TenantIdParam,
        body: UpdateProfileBody,
        response: { 200: ProfileResponse },
      },
    },
    async (req) => {
      const { id } = req.params as z.infer<typeof TenantIdParam>;
      const body = req.body as z.infer<typeof UpdateProfileBody>;
      return updateTenantProfile(id, body);
    },
  );
}
