import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { agentRegistry } from '../../agents/registry.js';
import {
  createPack,
  deletePack,
  getPack,
  listTenantPacks,
  updatePack,
} from '../../agents/skill-packs-repository.js';
import { ConflictError } from '../../lib/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { requireTenant, tenantOf } from '../middleware/tenant.js';

const BODY_MAX = 64 * 1024;
const KEY_RE = /^tenant\.[a-z0-9-]{1,60}$/;

const PackIdParam = z.object({ packId: z.string().uuid() });

const PackResponse = z.object({
  id: z.string().uuid(),
  key: z.string(),
  name: z.string(),
  body: z.string(),
  appliesTo: z.array(z.string()),
  createdAt: z.preprocess((v) => (v instanceof Date ? v.toISOString() : v), z.string()),
  updatedAt: z.preprocess((v) => (v instanceof Date ? v.toISOString() : v), z.string()),
});

function validateAppliesTo(appliesTo: string[], ctx: z.RefinementCtx) {
  const unknown = appliesTo.filter((a) => !agentRegistry.has(a));
  if (unknown.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `unknown agent ids: ${unknown.join(', ')}`,
    });
  }
}

const CreateBody = z.object({
  key: z.string().regex(KEY_RE, 'must match tenant.<slug>'),
  name: z.string().min(1).max(120),
  body: z.string().max(BODY_MAX),
  appliesTo: z.array(z.string()).superRefine(validateAppliesTo),
});

const UpdateBody = z.object({
  name: z.string().min(1).max(120).optional(),
  body: z.string().max(BODY_MAX).optional(),
  appliesTo: z.array(z.string()).superRefine(validateAppliesTo).optional(),
});

export async function skillPacksRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);
  app.addHook('preHandler', requireTenant);

  app.get(
    '/skill-packs',
    {
      schema: {
        tags: ['skill-packs'],
        response: { 200: z.array(PackResponse) },
      },
    },
    async (req) => listTenantPacks(tenantOf(req)),
  );

  app.post(
    '/skill-packs',
    {
      schema: {
        tags: ['skill-packs'],
        body: CreateBody,
        response: { 201: PackResponse },
      },
    },
    async (req, reply) => {
      const body = req.body as z.infer<typeof CreateBody>;
      try {
        const pack = await createPack(tenantOf(req), body);
        reply.code(201);
        return pack;
      } catch (err) {
        if (
          err &&
          typeof err === 'object' &&
          'code' in err &&
          (err as { code?: string }).code === '23505'
        ) {
          throw new ConflictError(`Pack key '${body.key}' already exists`);
        }
        throw err;
      }
    },
  );

  app.get(
    '/skill-packs/:packId',
    {
      schema: {
        tags: ['skill-packs'],
        params: PackIdParam,
        response: { 200: PackResponse },
      },
    },
    async (req) => {
      const { packId } = req.params as z.infer<typeof PackIdParam>;
      return getPack(tenantOf(req), packId);
    },
  );

  app.put(
    '/skill-packs/:packId',
    {
      schema: {
        tags: ['skill-packs'],
        params: PackIdParam,
        body: UpdateBody,
        response: { 200: PackResponse },
      },
    },
    async (req) => {
      const { packId } = req.params as z.infer<typeof PackIdParam>;
      const body = req.body as z.infer<typeof UpdateBody>;
      return updatePack(tenantOf(req), packId, body);
    },
  );

  app.delete(
    '/skill-packs/:packId',
    {
      schema: {
        tags: ['skill-packs'],
        params: PackIdParam,
        response: { 204: z.null() },
      },
    },
    async (req, reply) => {
      const { packId } = req.params as z.infer<typeof PackIdParam>;
      await deletePack(tenantOf(req), packId);
      reply.code(204);
      return null;
    },
  );
}
