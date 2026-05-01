import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { db } from '../../db/client.js';
import { tenantMembers, tenants } from '../../db/schema/index.js';
import { UnauthorizedError } from '../../lib/errors.js';
import { requireAuth } from '../middleware/auth.js';

/**
 * GET /v1/me
 *
 * Returns the authenticated user plus the tenants they belong to. Used by the
 * frontend after sign-in to:
 *   1. Confirm JIT provisioning succeeded.
 *   2. Render the tenant switcher.
 *   3. Decide whether to surface the "create your first workspace" onboarding
 *      step (when `tenants` is empty).
 *
 * Auth-only — no tenant context required (the caller is asking which tenants
 * they can pick from).
 */
export async function meRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get('/me', { schema: { tags: ['system'] } }, async (req) => {
    if (!req.user) throw new UnauthorizedError();

    const memberships = await db
      .select({
        tenantId: tenants.id,
        slug: tenants.slug,
        name: tenants.name,
        plan: tenants.plan,
        role: tenantMembers.role,
      })
      .from(tenantMembers)
      .innerJoin(tenants, eq(tenants.id, tenantMembers.tenantId))
      .where(eq(tenantMembers.userId, req.user.id));

    return {
      user: { id: req.user.id, email: req.user.email },
      tenants: memberships,
    };
  });
}
