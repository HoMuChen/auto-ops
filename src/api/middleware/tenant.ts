import { and, eq } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AuthenticatedUser } from '../../auth/index.js';
import { db } from '../../db/client.js';
import { tenantMembers, tenants } from '../../db/schema/index.js';
import { ForbiddenError, UnauthorizedError } from '../../lib/errors.js';

export type TenantRole = 'owner' | 'admin' | 'operator' | 'viewer';

declare module 'fastify' {
  interface FastifyRequest {
    tenantId?: string;
    tenantRole?: TenantRole;
  }
}

/**
 * Narrow `req.tenantId` / `req.user` to non-nullable in route handlers that
 * run after `requireAuth` + `requireTenant`. Both hooks already throw before
 * the handler runs, so the only reason a handler ever sees `undefined` here
 * would be a missing hook registration — fail loud rather than continue.
 */
export function tenantOf(req: FastifyRequest): string {
  if (!req.tenantId) throw new ForbiddenError('Tenant context not resolved');
  return req.tenantId;
}

export function authedTenantOf(req: FastifyRequest): {
  tenantId: string;
  user: AuthenticatedUser;
} {
  if (!req.tenantId || !req.user) throw new ForbiddenError('Auth/tenant context not resolved');
  return { tenantId: req.tenantId, user: req.user };
}

/**
 * Resolves the active tenant from the `x-tenant-id` header (or `?tenantId=` query)
 * and verifies the authenticated user is a member.
 *
 * Must run *after* requireAuth.
 */
export async function requireTenant(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (!req.user) throw new UnauthorizedError('User must be authenticated before tenant resolution');

  const headerTenant = req.headers['x-tenant-id'];
  const queryTenant = (req.query as { tenantId?: string } | undefined)?.tenantId;
  const tenantId = (Array.isArray(headerTenant) ? headerTenant[0] : headerTenant) ?? queryTenant;
  if (!tenantId) throw new ForbiddenError('Missing tenant context (x-tenant-id header)');

  const [membership] = await db
    .select({
      role: tenantMembers.role,
      tenantId: tenants.id,
    })
    .from(tenantMembers)
    .innerJoin(tenants, eq(tenants.id, tenantMembers.tenantId))
    .where(and(eq(tenantMembers.userId, req.user.id), eq(tenantMembers.tenantId, tenantId)))
    .limit(1);

  if (!membership) throw new ForbiddenError('User is not a member of this tenant');

  req.tenantId = membership.tenantId;
  req.tenantRole = membership.role;
}
