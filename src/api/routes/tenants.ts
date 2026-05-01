import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { tenantMembers, tenants } from '../../db/schema/index.js';
import { ConflictError, UnauthorizedError } from '../../lib/errors.js';
import { requireAuth } from '../middleware/auth.js';

/**
 * Tenant onboarding routes.
 *
 * `POST /v1/tenants` is the only path that creates a tenant + a `tenant_members`
 * row in one transaction. The creator becomes the owner. Slug must be unique;
 * we surface that as a 409 instead of leaking the unique-violation.
 */
const CreateTenantBody = z.object({
  name: z.string().min(1).max(120),
  slug: z
    .string()
    .min(2)
    .max(60)
    .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'lowercase letters, digits and dashes'),
  plan: z.enum(['basic', 'pro', 'flagship']).default('basic'),
});

export async function tenantRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.post(
    '/tenants',
    {
      schema: {
        tags: ['tenants'],
        body: CreateTenantBody,
      },
    },
    async (req, reply) => {
      if (!req.user) throw new UnauthorizedError();
      const body = req.body as z.infer<typeof CreateTenantBody>;

      try {
        const created = await db.transaction(async (tx) => {
          const [tenant] = await tx
            .insert(tenants)
            .values({ name: body.name, slug: body.slug, plan: body.plan })
            .returning();
          if (!tenant) throw new Error('Tenant insert returned no row');

          await tx.insert(tenantMembers).values({
            tenantId: tenant.id,
            userId: req.user!.id,
            role: 'owner',
          });

          return tenant;
        });

        reply.code(201);
        return created;
      } catch (err) {
        // Postgres unique violation on tenants.slug
        if (err instanceof Error && /tenants_slug_unique/i.test(err.message)) {
          throw new ConflictError(`Tenant slug "${body.slug}" is taken`);
        }
        throw err;
      }
    },
  );
}
