import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { tenantCredentials } from '../../db/schema/index.js';
import { NotFoundError } from '../../lib/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { requireTenant, tenantOf } from '../middleware/tenant.js';

const ProviderEnum = z.enum(['shopify', 'threads', 'instagram', 'facebook']);

/**
 * Credential vault routes. The `secret` field is write-only on the API surface;
 * GET responses redact it.
 *
 * MVP: secrets stored as opaque strings. Production should encrypt at the
 * application layer before insert.
 */
export async function credentialRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);
  app.addHook('preHandler', requireTenant);

  app.get('/credentials', { schema: { tags: ['credentials'] } }, async (req) => {
    const tenantId = tenantOf(req);
    const rows = await db
      .select({
        id: tenantCredentials.id,
        provider: tenantCredentials.provider,
        label: tenantCredentials.label,
        metadata: tenantCredentials.metadata,
        createdAt: tenantCredentials.createdAt,
      })
      .from(tenantCredentials)
      .where(eq(tenantCredentials.tenantId, tenantId));
    return rows;
  });

  app.put(
    '/credentials/:provider',
    {
      schema: {
        tags: ['credentials'],
        params: z.object({ provider: ProviderEnum }),
        body: z.object({
          secret: z.string().min(1),
          label: z.string().optional(),
          metadata: z.record(z.unknown()).default({}),
        }),
      },
    },
    async (req) => {
      const tenantId = tenantOf(req);
      const { provider } = req.params as { provider: z.infer<typeof ProviderEnum> };
      const body = req.body as {
        secret: string;
        label?: string;
        metadata: Record<string, unknown>;
      };

      const [existing] = await db
        .select()
        .from(tenantCredentials)
        .where(
          and(
            eq(tenantCredentials.tenantId, tenantId),
            eq(tenantCredentials.provider, provider),
            body.label ? eq(tenantCredentials.label, body.label) : eq(tenantCredentials.label, ''),
          ),
        )
        .limit(1);

      if (existing) {
        const [updated] = await db
          .update(tenantCredentials)
          .set({
            secret: body.secret,
            metadata: body.metadata,
            updatedAt: new Date(),
          })
          .where(eq(tenantCredentials.id, existing.id))
          .returning({ id: tenantCredentials.id, provider: tenantCredentials.provider });
        return updated;
      }
      const [created] = await db
        .insert(tenantCredentials)
        .values({
          tenantId,
          provider,
          label: body.label,
          secret: body.secret,
          metadata: body.metadata,
        })
        .returning({ id: tenantCredentials.id, provider: tenantCredentials.provider });
      return created;
    },
  );

  app.delete(
    '/credentials/:id',
    {
      schema: {
        tags: ['credentials'],
        params: z.object({ id: z.string().uuid() }),
      },
    },
    async (req, reply) => {
      const tenantId = tenantOf(req);
      const { id } = req.params as { id: string };
      const result = await db
        .delete(tenantCredentials)
        .where(and(eq(tenantCredentials.id, id), eq(tenantCredentials.tenantId, tenantId)))
        .returning({ id: tenantCredentials.id });
      if (result.length === 0) throw new NotFoundError(`Credential ${id}`);
      reply.code(204);
      return null;
    },
  );
}
