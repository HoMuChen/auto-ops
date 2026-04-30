import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { agentRegistry } from '../../agents/registry.js';
import { db } from '../../db/client.js';
import { agentConfigs } from '../../db/schema/index.js';
import { ForbiddenError } from '../../lib/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { requireTenant } from '../middleware/tenant.js';
import { AgentManifestSchema, ErrorEnvelope } from '../schemas.js';

export async function agentRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);
  app.addHook('preHandler', requireTenant);

  app.get(
    '/agents',
    {
      schema: {
        tags: ['agents'],
        response: { 200: z.array(AgentManifestSchema), 403: ErrorEnvelope },
      },
    },
    async (req) => {
      if (!req.tenantId) throw new ForbiddenError();
      const enabled = await agentRegistry.listForTenant(req.tenantId);
      const enabledIds = new Set(enabled.map((a) => a.manifest.id));
      return agentRegistry.manifests().map((m) => ({
        id: m.id,
        name: m.name,
        description: m.description,
        availableInPlans: [...m.availableInPlans],
        defaultModel: m.defaultModel,
        enabled: enabledIds.has(m.id),
      }));
    },
  );

  app.put(
    '/agents/:agentId/config',
    {
      schema: {
        tags: ['agents'],
        params: z.object({ agentId: z.string() }),
        body: z.object({
          enabled: z.boolean().optional(),
          modelConfig: z
            .object({
              provider: z.enum(['anthropic', 'openai']),
              model: z.string(),
              temperature: z.number().min(0).max(2).optional(),
              maxTokens: z.number().int().positive().optional(),
            })
            .optional(),
          promptOverride: z.string().optional(),
          toolWhitelist: z.array(z.string()).optional(),
        }),
      },
    },
    async (req) => {
      if (!req.tenantId) throw new ForbiddenError();
      const { agentId } = req.params as { agentId: string };
      const body = req.body as {
        enabled?: boolean;
        modelConfig?: {
          provider: 'anthropic' | 'openai';
          model: string;
          temperature?: number;
          maxTokens?: number;
        };
        promptOverride?: string;
        toolWhitelist?: string[];
      };
      const tenantId = req.tenantId;

      const [existing] = await db
        .select()
        .from(agentConfigs)
        .where(and(eq(agentConfigs.tenantId, tenantId), eq(agentConfigs.agentKey, agentId)))
        .limit(1);

      if (existing) {
        const [updated] = await db
          .update(agentConfigs)
          .set({ ...body, updatedAt: new Date() })
          .where(and(eq(agentConfigs.tenantId, tenantId), eq(agentConfigs.agentKey, agentId)))
          .returning();
        return updated;
      }
      const [created] = await db
        .insert(agentConfigs)
        .values({ tenantId, agentKey: agentId, ...body })
        .returning();
      return created;
    },
  );
}
