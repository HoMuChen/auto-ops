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

export const CreateConversationBody = z.object({
  brief: z.string().min(1, 'brief is required'),
  /** Optional explicit agent id; otherwise the Supervisor decides. */
  preferredAgent: z.string().optional(),
  params: z.record(z.unknown()).optional(),
  scheduledAt: z.string().datetime().optional(),
});
export type CreateConversationBody = z.infer<typeof CreateConversationBody>;

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
  availableInPlans: z.array(z.string()),
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
