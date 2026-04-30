import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import { ForbiddenError } from '../../lib/errors.js';
import { appendMessage } from '../../tasks/messages.js';
import { createTask } from '../../tasks/repository.js';
import { requireAuth } from '../middleware/auth.js';
import { requireTenant } from '../middleware/tenant.js';
import { CreateConversationBody, ErrorEnvelope, TaskSchema } from '../schemas.js';

/**
 * POST /conversations
 *
 * Entry point for natural-language task dispatch. Creates a `tasks` row in 'todo'
 * status and seeds the first user message. The polling worker will pick it up
 * and run it through the LangGraph supervisor.
 */
export async function conversationRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);
  app.addHook('preHandler', requireTenant);

  app.post(
    '/conversations',
    {
      schema: {
        tags: ['conversations'],
        body: CreateConversationBody,
        response: {
          201: TaskSchema,
          400: ErrorEnvelope,
          401: ErrorEnvelope,
          403: ErrorEnvelope,
        },
      },
    },
    async (req, reply) => {
      if (!req.tenantId || !req.user) throw new ForbiddenError();
      const body = req.body as z.infer<typeof CreateConversationBody>;

      const scheduledAt = body.scheduledAt ? new Date(body.scheduledAt) : undefined;

      const task = await createTask({
        tenantId: req.tenantId,
        title: body.brief.slice(0, 120),
        description: body.brief,
        assignedAgent: body.preferredAgent,
        input: { brief: body.brief, ...(body.params ?? {}) },
        scheduledAt,
        createdBy: req.user.id,
      });

      await appendMessage({
        tenantId: req.tenantId,
        taskId: task.id,
        role: 'user',
        content: body.brief,
        createdBy: req.user.id,
      });

      reply.code(201);
      return task;
    },
  );
}
