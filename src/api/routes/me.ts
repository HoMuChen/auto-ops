import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { type NotificationSettings, tenantMembers, tenants } from '../../db/schema/index.js';
import { NotFoundError, UnauthorizedError } from '../../lib/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { authedTenantOf, requireTenant } from '../middleware/tenant.js';
import { ErrorEnvelope } from '../schemas.js';

const NotificationSettingsSchema = z.object({
  notifyOnDone: z
    .boolean()
    .default(false)
    .describe(
      'Email when a task transitions to `done`. **Opt-in** (default false) — done is a pure FYI signal, the deliverable is in the kanban regardless. Per-task `params.notify` overrides this.',
    ),
  notifyOnWaiting: z
    .boolean()
    .default(true)
    .describe(
      'Email when a task has been parked in `waiting` past 30 min without action. **Opt-out** (default true) — waiting means the system is genuinely blocked on the user, so silent-by-default would be the worse failure mode. Feedback rounds re-fire if they re-stall. Per-task `params.notify` overrides this.',
    ),
});
const NotificationSettingsPatchSchema = z.object({
  notifyOnDone: z
    .boolean()
    .optional()
    .describe('Toggle the done-email opt-in. Omit to leave unchanged.'),
  notifyOnWaiting: z
    .boolean()
    .optional()
    .describe('Toggle the waiting-email opt-out. Omit to leave unchanged.'),
});

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

  /**
   * Per-(user, tenant) notification preferences. Both endpoints require
   * tenant context (x-tenant-id header) — settings are tenant-scoped so a
   * user serving multiple workspaces can opt in to notifications on one
   * without bleeding into the others.
   *
   * Storage is jsonb on tenant_members.notification_settings. NULL row maps
   * to defaults: notifyOnDone=false (opt-in FYI), notifyOnWaiting=true
   * (opt-out — waiting means blocked on the user).
   */
  app.get(
    '/me/notification-settings',
    {
      preHandler: requireTenant,
      schema: {
        tags: ['system'],
        response: { 200: NotificationSettingsSchema, 401: ErrorEnvelope, 403: ErrorEnvelope },
      },
    },
    async (req) => {
      const { tenantId, user } = authedTenantOf(req);
      const [member] = await db
        .select({ notificationSettings: tenantMembers.notificationSettings })
        .from(tenantMembers)
        .where(and(eq(tenantMembers.tenantId, tenantId), eq(tenantMembers.userId, user.id)))
        .limit(1);
      if (!member) throw new NotFoundError('tenant membership');
      const settings: NotificationSettings = member.notificationSettings ?? {};
      return {
        notifyOnDone: settings.notifyOnDone ?? false,
        // Waiting defaults ON — silence requires an explicit `false`. Mirrors
        // the dispatcher's `decideWaitingRecipient` semantic.
        notifyOnWaiting: settings.notifyOnWaiting !== false,
      };
    },
  );

  app.patch(
    '/me/notification-settings',
    {
      preHandler: requireTenant,
      schema: {
        tags: ['system'],
        body: NotificationSettingsPatchSchema,
        response: { 200: NotificationSettingsSchema, 401: ErrorEnvelope, 403: ErrorEnvelope },
      },
    },
    async (req) => {
      const { tenantId, user } = authedTenantOf(req);
      const body = req.body as z.infer<typeof NotificationSettingsPatchSchema>;
      const [existing] = await db
        .select({ notificationSettings: tenantMembers.notificationSettings })
        .from(tenantMembers)
        .where(and(eq(tenantMembers.tenantId, tenantId), eq(tenantMembers.userId, user.id)))
        .limit(1);
      if (!existing) throw new NotFoundError('tenant membership');

      const merged: NotificationSettings = {
        ...(existing.notificationSettings ?? {}),
        ...(body.notifyOnDone !== undefined ? { notifyOnDone: body.notifyOnDone } : {}),
        ...(body.notifyOnWaiting !== undefined ? { notifyOnWaiting: body.notifyOnWaiting } : {}),
      };

      await db
        .update(tenantMembers)
        .set({ notificationSettings: merged })
        .where(and(eq(tenantMembers.tenantId, tenantId), eq(tenantMembers.userId, user.id)));

      return {
        notifyOnDone: merged.notifyOnDone ?? false,
        notifyOnWaiting: merged.notifyOnWaiting !== false,
      };
    },
  );
}
