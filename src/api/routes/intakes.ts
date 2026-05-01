import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { loadAvailableAgentsForTenant, runIntakeTurn } from '../../intakes/agent.js';
import {
  abandonIntake,
  appendTurn,
  createIntake,
  finalizeIntake,
  getIntake,
  listIntakes,
} from '../../intakes/repository.js';
import { ForbiddenError, IllegalStateError } from '../../lib/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { requireTenant } from '../middleware/tenant.js';
import {
  ErrorEnvelope,
  FinalizeIntakeBody,
  FinalizeIntakeResultSchema,
  IntakeMessageBody,
  IntakeSchema,
  IntakeStatusSchema,
  IntakeTurnResultSchema,
  StartIntakeBody,
} from '../schemas.js';

/**
 * Intake (pre-task clarification) routes.
 *
 * The conversation runs against a lightweight intake agent that doesn't touch
 * the supervisor LangGraph or the tasks table — drafts never appear on the
 * kanban. When the boss is happy with the draft, POST /finalize spawns a real
 * task in `todo` status which the worker picks up on the next poll.
 */
export async function intakeRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);
  app.addHook('preHandler', requireTenant);

  app.get(
    '/intakes',
    {
      schema: {
        tags: ['intakes'],
        querystring: z.object({ status: IntakeStatusSchema.optional() }),
        response: { 200: z.array(IntakeSchema), 401: ErrorEnvelope, 403: ErrorEnvelope },
      },
    },
    async (req) => {
      if (!req.tenantId) throw new ForbiddenError();
      const q = req.query as { status?: 'open' | 'finalized' | 'abandoned' };
      return listIntakes(req.tenantId, q);
    },
  );

  app.get(
    '/intakes/:intakeId',
    {
      schema: {
        tags: ['intakes'],
        params: z.object({ intakeId: z.string().uuid() }),
        response: { 200: IntakeSchema, 404: ErrorEnvelope },
      },
    },
    async (req) => {
      if (!req.tenantId) throw new ForbiddenError();
      const { intakeId } = req.params as { intakeId: string };
      return getIntake(req.tenantId, intakeId);
    },
  );

  /**
   * Start a new intake conversation. The boss's first message is recorded and
   * the intake agent produces its first reply + initial draft brief. UI uses
   * the returned `reply` as the assistant's first turn and `intake.draftBrief`
   * for the live preview panel.
   */
  app.post(
    '/intakes',
    {
      schema: {
        tags: ['intakes'],
        body: StartIntakeBody,
        response: { 201: IntakeTurnResultSchema, 400: ErrorEnvelope },
      },
    },
    async (req, reply) => {
      if (!req.tenantId || !req.user) throw new ForbiddenError();
      const body = req.body as z.infer<typeof StartIntakeBody>;

      const availableAgents = await loadAvailableAgentsForTenant(req.tenantId);
      const turn = await runIntakeTurn([], body.message, { availableAgents });

      const intake = await createIntake({
        tenantId: req.tenantId,
        createdBy: req.user.id,
        firstMessage: body.message,
        firstAssistantReply: turn.reply,
        draftTitle: turn.draftTitle,
        draftBrief: turn.draftBrief,
      });

      reply.code(201);
      return {
        intake,
        reply: turn.reply,
        readyToFinalize: turn.readyToFinalize,
        missingInfo: turn.missingInfo,
      };
    },
  );

  /**
   * Append a user turn and run the intake agent for one step.
   *
   * State stays `open` throughout — the only way out is /finalize or /abandon.
   */
  app.post(
    '/intakes/:intakeId/messages',
    {
      schema: {
        tags: ['intakes'],
        params: z.object({ intakeId: z.string().uuid() }),
        body: IntakeMessageBody,
        response: { 200: IntakeTurnResultSchema, 422: ErrorEnvelope },
      },
    },
    async (req) => {
      if (!req.tenantId) throw new ForbiddenError();
      const { intakeId } = req.params as { intakeId: string };
      const body = req.body as z.infer<typeof IntakeMessageBody>;

      const intake = await getIntake(req.tenantId, intakeId);
      if (intake.status !== 'open') {
        throw new IllegalStateError(`Intake is ${intake.status}, cannot append`);
      }

      const availableAgents = await loadAvailableAgentsForTenant(req.tenantId);
      const turn = await runIntakeTurn(intake.messages, body.message, { availableAgents });

      const updated = await appendTurn(req.tenantId, intakeId, {
        userMessage: body.message,
        assistantReply: turn.reply,
        draftBrief: turn.draftBrief,
        draftTitle: turn.draftTitle,
      });

      return {
        intake: updated,
        reply: turn.reply,
        readyToFinalize: turn.readyToFinalize,
        missingInfo: turn.missingInfo,
      };
    },
  );

  /**
   * Spawn a real task from the intake. By default uses the agent's running
   * draftTitle / draftBrief; a body can override either or pin a preferred
   * agent. Idempotent — calling twice returns the same task.
   */
  app.post(
    '/intakes/:intakeId/finalize',
    {
      schema: {
        tags: ['intakes'],
        params: z.object({ intakeId: z.string().uuid() }),
        body: FinalizeIntakeBody,
        response: {
          200: FinalizeIntakeResultSchema,
          422: ErrorEnvelope,
          404: ErrorEnvelope,
        },
      },
    },
    async (req) => {
      if (!req.tenantId || !req.user) throw new ForbiddenError();
      const { intakeId } = req.params as { intakeId: string };
      const body = (req.body ?? {}) as z.infer<typeof FinalizeIntakeBody>;

      return finalizeIntake(req.tenantId, intakeId, {
        ...body,
        createdBy: req.user.id,
      });
    },
  );

  app.post(
    '/intakes/:intakeId/abandon',
    {
      schema: {
        tags: ['intakes'],
        params: z.object({ intakeId: z.string().uuid() }),
        response: { 200: IntakeSchema, 422: ErrorEnvelope },
      },
    },
    async (req) => {
      if (!req.tenantId) throw new ForbiddenError();
      const { intakeId } = req.params as { intakeId: string };
      return abandonIntake(req.tenantId, intakeId);
    },
  );
}
