import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { streamTaskLogs } from '../../events/sse.js';
import { ForbiddenError, IllegalStateError } from '../../lib/errors.js';
import { appendMessage, listMessages } from '../../tasks/messages.js';
import { getTask, listTaskLogs, listTasks, updateTaskStatus } from '../../tasks/repository.js';
import { requireAuth } from '../middleware/auth.js';
import { requireTenant } from '../middleware/tenant.js';
import {
  ApproveBody,
  ErrorEnvelope,
  FeedbackBody,
  PaginationQuery,
  TaskSchema,
} from '../schemas.js';

export async function taskRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);
  app.addHook('preHandler', requireTenant);

  app.get(
    '/tasks',
    {
      schema: {
        tags: ['tasks'],
        querystring: PaginationQuery,
        response: { 200: z.array(TaskSchema), 401: ErrorEnvelope, 403: ErrorEnvelope },
      },
    },
    async (req) => {
      if (!req.tenantId) throw new ForbiddenError();
      const q = req.query as z.infer<typeof PaginationQuery>;
      return listTasks(req.tenantId, q);
    },
  );

  app.get(
    '/tasks/:taskId',
    {
      schema: {
        tags: ['tasks'],
        params: z.object({ taskId: z.string().uuid() }),
        response: { 200: TaskSchema, 404: ErrorEnvelope },
      },
    },
    async (req) => {
      if (!req.tenantId) throw new ForbiddenError();
      const { taskId } = req.params as { taskId: string };
      return getTask(req.tenantId, taskId);
    },
  );

  app.get(
    '/tasks/:taskId/messages',
    {
      schema: {
        tags: ['tasks'],
        params: z.object({ taskId: z.string().uuid() }),
      },
    },
    async (req) => {
      if (!req.tenantId) throw new ForbiddenError();
      const { taskId } = req.params as { taskId: string };
      return listMessages(req.tenantId, taskId);
    },
  );

  app.get(
    '/tasks/:taskId/logs',
    {
      schema: {
        tags: ['tasks'],
        params: z.object({ taskId: z.string().uuid() }),
        querystring: z.object({ since: z.string().datetime().optional() }),
      },
    },
    async (req) => {
      if (!req.tenantId) throw new ForbiddenError();
      const { taskId } = req.params as { taskId: string };
      const since = (req.query as { since?: string }).since
        ? new Date((req.query as { since?: string }).since!)
        : undefined;
      return listTaskLogs(req.tenantId, taskId, { since });
    },
  );

  /**
   * SSE endpoint for live log streaming.
   * Note: not type-validated by the schema-driven response handler;
   * the handler writes the SSE stream directly.
   */
  app.get<{ Params: { taskId: string }; Querystring: { since?: string } }>(
    '/tasks/:taskId/stream',
    async (req, reply) => {
      await streamTaskLogs(req, reply);
    },
  );

  app.post(
    '/tasks/:taskId/approve',
    {
      schema: {
        tags: ['tasks'],
        params: z.object({ taskId: z.string().uuid() }),
        body: ApproveBody,
        response: { 200: TaskSchema, 422: ErrorEnvelope },
      },
    },
    async (req) => {
      if (!req.tenantId) throw new ForbiddenError();
      const { taskId } = req.params as { taskId: string };
      const body = (req.body ?? {}) as z.infer<typeof ApproveBody>;
      const task = await getTask(req.tenantId, taskId);
      if (task.status !== 'waiting') {
        throw new IllegalStateError(`Task is in '${task.status}' state, not 'waiting'`);
      }
      // Approve = transition back to 'todo' so the worker re-picks it up,
      // OR finalize as 'done' if the user accepts the current draft as the final result.
      const next = body?.finalize ? 'done' : 'todo';
      return updateTaskStatus(req.tenantId, taskId, next);
    },
  );

  app.post(
    '/tasks/:taskId/feedback',
    {
      schema: {
        tags: ['tasks'],
        params: z.object({ taskId: z.string().uuid() }),
        body: FeedbackBody,
        response: { 200: TaskSchema },
      },
    },
    async (req) => {
      if (!req.tenantId || !req.user) throw new ForbiddenError();
      const { taskId } = req.params as { taskId: string };
      const body = req.body as z.infer<typeof FeedbackBody>;
      const task = await getTask(req.tenantId, taskId);
      if (task.status !== 'waiting') {
        throw new IllegalStateError(`Task is in '${task.status}' state, not 'waiting'`);
      }
      await appendMessage({
        tenantId: req.tenantId,
        taskId,
        role: 'user',
        content: body.feedback,
        createdBy: req.user.id,
      });
      return updateTaskStatus(req.tenantId, taskId, 'todo');
    },
  );

  app.post(
    '/tasks/:taskId/discard',
    {
      schema: {
        tags: ['tasks'],
        params: z.object({ taskId: z.string().uuid() }),
        response: { 200: TaskSchema },
      },
    },
    async (req) => {
      if (!req.tenantId) throw new ForbiddenError();
      const { taskId } = req.params as { taskId: string };
      return updateTaskStatus(req.tenantId, taskId, 'failed', {
        error: { message: 'Discarded by user' },
      });
    },
  );
}
