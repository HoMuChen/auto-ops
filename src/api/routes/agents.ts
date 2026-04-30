import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { agentRegistry } from '../../agents/registry.js';
import type { AgentManifest } from '../../agents/types.js';
import { ForbiddenError } from '../../lib/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { requireTenant } from '../middleware/tenant.js';

/**
 * Agents API surface.
 *
 *   GET    /v1/agents                          — list all (manifest + per-tenant status)
 *   GET    /v1/agents/:agentId                 — single agent + activation checklist
 *   POST   /v1/agents/:agentId/activate        — validate & enable (or update config)
 *   POST   /v1/agents/:agentId/deactivate      — disable (preserves config)
 *
 * The frontend uses `GET /v1/agents/:agentId` to render the "hire this employee"
 * page: it returns the JSON Schema for the config form + a checklist of which
 * required credentials are already bound.
 */

const ActivateBody = z.object({
  config: z.unknown().default({}),
  promptOverride: z.string().nullable().optional(),
  toolWhitelist: z.array(z.string()).nullable().optional(),
});

function manifestPayload(manifest: AgentManifest): Record<string, unknown> {
  return {
    id: manifest.id,
    name: manifest.name,
    description: manifest.description,
    availableInPlans: [...manifest.availableInPlans],
    defaultModel: manifest.defaultModel,
    toolIds: manifest.toolIds ?? [],
    requiredCredentials: manifest.requiredCredentials ?? [],
    configSchema: manifest.configSchema
      ? zodToJsonSchema(manifest.configSchema, { name: manifest.id })
      : null,
  };
}

export async function agentRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);
  app.addHook('preHandler', requireTenant);

  app.get('/agents', { schema: { tags: ['agents'] } }, async (req) => {
    if (!req.tenantId) throw new ForbiddenError();
    const tenantId = req.tenantId;
    const manifests = agentRegistry.manifests();

    const statuses = await Promise.all(
      manifests.map(async (m) => {
        const status = await agentRegistry.getActivationStatus(tenantId, m.id);
        return {
          ...manifestPayload(m),
          enabled: status.enabled,
          ready: status.ready,
          planAllowed: status.planAllowed,
          credentials: status.credentials,
          config: status.config,
        };
      }),
    );

    return statuses;
  });

  app.get(
    '/agents/:agentId',
    {
      schema: {
        tags: ['agents'],
        params: z.object({ agentId: z.string() }),
      },
    },
    async (req) => {
      if (!req.tenantId) throw new ForbiddenError();
      const { agentId } = req.params as { agentId: string };
      const status = await agentRegistry.getActivationStatus(req.tenantId, agentId);

      return {
        ...manifestPayload(status.agent.manifest),
        enabled: status.enabled,
        ready: status.ready,
        planAllowed: status.planAllowed,
        credentials: status.credentials,
        config: status.config,
        promptOverride: status.promptOverride,
        toolWhitelist: status.toolWhitelist,
      };
    },
  );

  app.post(
    '/agents/:agentId/activate',
    {
      schema: {
        tags: ['agents'],
        params: z.object({ agentId: z.string() }),
        body: ActivateBody,
      },
    },
    async (req) => {
      if (!req.tenantId) throw new ForbiddenError();
      const { agentId } = req.params as { agentId: string };
      const body = req.body as z.infer<typeof ActivateBody>;
      return agentRegistry.activate({
        tenantId: req.tenantId,
        agentId,
        config: body.config ?? {},
        promptOverride: body.promptOverride ?? null,
        toolWhitelist: body.toolWhitelist ?? null,
      });
    },
  );

  app.post(
    '/agents/:agentId/deactivate',
    {
      schema: {
        tags: ['agents'],
        params: z.object({ agentId: z.string() }),
      },
    },
    async (req, reply) => {
      if (!req.tenantId) throw new ForbiddenError();
      const { agentId } = req.params as { agentId: string };
      await agentRegistry.deactivate(req.tenantId, agentId);
      reply.code(204);
      return null;
    },
  );
}
