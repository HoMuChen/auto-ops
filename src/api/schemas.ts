import { z } from 'zod';

export const TaskStatusSchema = z.enum(['todo', 'in_progress', 'waiting', 'done', 'failed']);

/**
 * Drizzle returns timestamp columns as `Date` instances; Fastify response
 * serialization runs Zod's `parse` which doesn't natively know about Date.
 * Coerce to an ISO string so the wire format stays consistent.
 */
const IsoDate = z.preprocess(
  (v) => (v instanceof Date ? v.toISOString() : v),
  z.string().datetime(),
);
const NullableIsoDate = z.preprocess(
  (v) => (v instanceof Date ? v.toISOString() : v),
  z.string().datetime().nullable(),
);

export const TaskSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  parentTaskId: z.string().uuid().nullable(),
  title: z.string(),
  description: z.string().nullable(),
  kind: z.enum(['strategy', 'execution']),
  assignedAgent: z.string().nullable(),
  status: TaskStatusSchema,
  input: z.record(z.unknown()),
  output: z.record(z.unknown()).nullable(),
  error: z.object({ message: z.string(), stack: z.string().optional() }).nullable().optional(),
  scheduledAt: NullableIsoDate,
  createdAt: IsoDate,
  updatedAt: IsoDate,
  completedAt: NullableIsoDate,
});

export const CreateTaskBody = z.object({
  brief: z.string().min(1, 'brief is required'),
  /** Optional explicit agent id; otherwise the Supervisor decides. */
  preferredAgent: z.string().optional(),
  params: z.record(z.unknown()).optional(),
  scheduledAt: z.string().datetime().optional(),
  /** UUIDs returned by POST /v1/uploads — attached to the first user message. */
  imageIds: z.array(z.string().uuid()).optional(),
});
export type CreateTaskBody = z.infer<typeof CreateTaskBody>;

export const FeedbackBody = z.object({
  feedback: z.string().min(1),
});
export type FeedbackBody = z.infer<typeof FeedbackBody>;

export const ApproveBody = z
  .object({
    /** If true, the task is finalised as 'done'; otherwise it resumes for the next step. */
    finalize: z.boolean().default(false),
  })
  .partial()
  .optional();
export type ApproveBody = z.infer<typeof ApproveBody>;

export const TenantIdHeader = z.object({
  'x-tenant-id': z.string().uuid(),
});

export const PaginationQuery = z.object({
  status: TaskStatusSchema.optional(),
  parentTaskId: z.string().uuid().optional(),
});

export const AgentManifestSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  defaultModel: z.object({
    provider: z.string(),
    model: z.string(),
    temperature: z.number().optional(),
    maxTokens: z.number().optional(),
  }),
  enabled: z.boolean(),
});

export const ErrorEnvelope = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    statusCode: z.number(),
    details: z.unknown().optional(),
  }),
});

export const IntakeStatusSchema = z.enum(['open', 'finalized', 'abandoned']);

export const IntakeMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  createdAt: z.string().datetime(),
});

export const IntakeSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  createdBy: z.string().uuid().nullable(),
  status: IntakeStatusSchema,
  messages: z.array(IntakeMessageSchema),
  draftTitle: z.string().nullable(),
  draftBrief: z.string().nullable(),
  finalizedTaskId: z.string().uuid().nullable(),
  finalizedAt: NullableIsoDate,
  createdAt: IsoDate,
  updatedAt: IsoDate,
});

export const StartIntakeBody = z.object({
  message: z.string().min(1, 'first message is required'),
  /** UUIDs returned by POST /v1/uploads — stored on the first intake message. */
  imageIds: z.array(z.string().uuid()).optional(),
});
export type StartIntakeBody = z.infer<typeof StartIntakeBody>;

export const IntakeMessageBody = z.object({
  message: z.string().min(1),
  /** UUIDs returned by POST /v1/uploads — stored on this intake message turn. */
  imageIds: z.array(z.string().uuid()).optional(),
});
export type IntakeMessageBody = z.infer<typeof IntakeMessageBody>;

export const FinalizeIntakeBody = z
  .object({
    /** Optional override — defaults to the agent's current draftTitle. */
    title: z.string().min(1).max(120).optional(),
    /** Optional override — defaults to the agent's current draftBrief. */
    brief: z.string().min(1).optional(),
    preferredAgent: z.string().optional(),
  })
  .optional();
export type FinalizeIntakeBody = z.infer<typeof FinalizeIntakeBody>;

/**
 * The shape returned by POST /intakes (start) and POST /intakes/:id/messages (turn).
 * Bundles the intake row + the agent's structured turn so the UI can update
 * the chat, the live draft preview, and the finalize button in one render.
 */
export const IntakeTurnResultSchema = z.object({
  intake: IntakeSchema,
  reply: z.string(),
  readyToFinalize: z.boolean(),
  missingInfo: z.array(z.string()),
});

export const FinalizeIntakeResultSchema = z.object({
  intake: IntakeSchema,
  task: TaskSchema,
});
