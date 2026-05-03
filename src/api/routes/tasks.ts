import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eventBus } from '../../events/event-bus.js';
import { streamTaskLogs, streamTenantLogs } from '../../events/sse.js';
import { IllegalStateError } from '../../lib/errors.js';
import { executeApprovedToolCall } from '../../orchestrator/tool-executor.js';
import { appendMessage, listMessages } from '../../tasks/messages.js';
import { readTaskOutput } from '../../tasks/output.js';
import {
  createTask,
  finalizeStrategyTask,
  getTask,
  listTaskLogs,
  listTasks,
  updateTaskStatus,
} from '../../tasks/repository.js';
import { requireAuth } from '../middleware/auth.js';
import { authedTenantOf, requireTenant, tenantOf } from '../middleware/tenant.js';
import {
  ApproveBody,
  CreateTaskBody,
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
      const tenantId = tenantOf(req);
      const q = req.query as z.infer<typeof PaginationQuery>;
      return listTasks(tenantId, q);
    },
  );

  /**
   * Natural-language task dispatch. Inserts a `tasks` row in 'todo' status and
   * seeds the first user message; the polling worker picks it up and runs it
   * through the LangGraph supervisor. The supervisor may pause via HITL gate
   * and ask for clarification — that conversation happens *inside* the task,
   * not before it (use /feedback to reply, /discard to abandon).
   */
  app.post(
    '/tasks',
    {
      schema: {
        tags: ['tasks'],
        body: CreateTaskBody,
        response: {
          201: TaskSchema,
          400: ErrorEnvelope,
          401: ErrorEnvelope,
          403: ErrorEnvelope,
        },
      },
    },
    async (req, reply) => {
      const { tenantId, user } = authedTenantOf(req);
      const body = req.body as z.infer<typeof CreateTaskBody>;

      const scheduledAt = body.scheduledAt ? new Date(body.scheduledAt) : undefined;

      const task = await createTask({
        tenantId,
        title: body.brief.slice(0, 120),
        description: body.brief,
        assignedAgent: body.preferredAgent,
        input: { brief: body.brief, ...(body.params ?? {}) },
        scheduledAt,
        createdBy: user.id,
      });

      if (!scheduledAt || scheduledAt <= new Date()) {
        eventBus.signal('task.ready');
      }

      await appendMessage({
        tenantId,
        taskId: task.id,
        role: 'user',
        content: body.brief,
        ...(body.imageIds?.length ? { data: { imageIds: body.imageIds } } : {}),
        createdBy: user.id,
      });

      reply.code(201);
      return task;
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
      const tenantId = tenantOf(req);
      const { taskId } = req.params as { taskId: string };
      return getTask(tenantId, taskId);
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
      const tenantId = tenantOf(req);
      const { taskId } = req.params as { taskId: string };
      return listMessages(tenantId, taskId);
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
      const tenantId = tenantOf(req);
      const { taskId } = req.params as { taskId: string };
      const since = (req.query as { since?: string }).since
        ? new Date((req.query as { since?: string }).since!)
        : undefined;
      return listTaskLogs(tenantId, taskId, { since });
    },
  );

  /**
   * SSE endpoint for live log streaming of a single task.
   * Note: not type-validated by the schema-driven response handler;
   * the handler writes the SSE stream directly.
   */
  app.get<{ Params: { taskId: string }; Querystring: { since?: string } }>(
    '/tasks/:taskId/stream',
    async (req, reply) => {
      await streamTaskLogs(req, reply);
    },
  );

  /**
   * SSE endpoint for tenant-wide log streaming across all tasks.
   * Each event includes `taskId` so the client can route logs to the correct card.
   */
  app.get<{ Querystring: { since?: string } }>('/stream', async (req, reply) => {
    await streamTenantLogs(req, reply);
  });

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
      const tenantId = tenantOf(req);
      const { taskId } = req.params as { taskId: string };
      const body = (req.body ?? {}) as z.infer<typeof ApproveBody>;
      const task = await getTask(tenantId, taskId);
      if (task.status !== 'waiting') {
        throw new IllegalStateError(`Task is in '${task.status}' state, not 'waiting'`);
      }
      // Approve = transition back to 'todo' so the worker re-picks it up,
      // OR finalize as 'done' if the user accepts the current draft as the final result.
      // Three finalize behaviours, in priority order:
      //   1. strategy task → atomically spawn planned execution children
      //   2. execution task with output.pendingToolCall → fire the deferred tool
      //      (e.g. shopify.create_product) and persist the API result
      //   3. plain text-only task → just transition to done
      if (body?.finalize) {
        if (task.kind === 'strategy') {
          const { parent, children } = await finalizeStrategyTask(tenantId, taskId);
          const now = new Date();
          const hasReadyChild = children.some((c) => !c.scheduledAt || c.scheduledAt <= now);
          if (hasReadyChild) eventBus.signal('task.ready');
          return parent;
        }
        if (readTaskOutput(task).pendingToolCall) {
          return executeApprovedToolCall(tenantId, taskId);
        }
        return updateTaskStatus(tenantId, taskId, 'done');
      }
      return updateTaskStatus(tenantId, taskId, 'todo');
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
      const { tenantId, user } = authedTenantOf(req);
      const { taskId } = req.params as { taskId: string };
      const body = req.body as z.infer<typeof FeedbackBody>;
      const task = await getTask(tenantId, taskId);
      if (task.status !== 'waiting') {
        throw new IllegalStateError(`Task is in '${task.status}' state, not 'waiting'`);
      }
      await appendMessage({
        tenantId,
        taskId,
        role: 'user',
        content: body.feedback,
        createdBy: user.id,
      });
      return updateTaskStatus(tenantId, taskId, 'todo');
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
      const tenantId = tenantOf(req);
      const { taskId } = req.params as { taskId: string };
      return updateTaskStatus(tenantId, taskId, 'failed', {
        error: { message: 'Discarded by user' },
      });
    },
  );
}
