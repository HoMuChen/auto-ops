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

/**
 * Artifact + Output schemas — declared before TaskSchema so TaskSchema.output
 * can reference them. UI dispatches on artifact.kind; flow-control fields
 * (pendingToolCall, spawnTasks, eeatPending) drive Approve/Spawn buttons.
 *
 * `.passthrough()` on TaskOutputSchema lets older rows / extra agent payload
 * keys survive serialization without forcing a schema migration.
 */
// `published` shapes are documented in API_GUIDE; schema kept loose so old
// rows / partial mocks don't fail response serialization. Production code
// produces the full shape.
const BlogPublishedMetaSchema = z
  .object({
    articleId: z.number().optional(),
    blogId: z.number().optional(),
    blogHandle: z.string().optional(),
    handle: z.string().optional(),
    articleUrl: z.string().optional(),
    publishedAt: z.string().nullable().optional(),
    status: z.enum(['published', 'draft']).optional(),
  })
  .passthrough();

const ProductPublishedMetaSchema = z
  .object({
    productId: z.number().optional(),
    handle: z.string().optional(),
    adminUrl: z.string().optional(),
    status: z.enum(['active', 'draft']).optional(),
  })
  .passthrough();

// Artifact response schema is a permissive union — UI dispatches on `kind`
// but data fields are kept lenient so partial agent mocks (in tests) and any
// older rows survive serialization. Producers in production emit the full
// documented shape; see API_GUIDE §5.1 for the contract UI should expect.
const NewArtifactSchema = z
  .object({
    report: z.string(),
    body: z.string().optional(),
    refs: z.record(z.unknown()).optional(),
  })
  .passthrough();

const LegacyArtifactSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('blog-article'),
    data: z
      .object({
        title: z.string(),
        bodyHtml: z.string().describe('Article body HTML — sanitize + iframe srcdoc to render'),
        summaryHtml: z.string().optional().describe('Shopify meta description / blog card excerpt'),
        summary: z.string().optional().describe('zh-TW Markdown boss-facing review report'),
        tags: z.array(z.string()).optional(),
        language: z.string().optional(),
        author: z.string().optional(),
      })
      .passthrough(),
    published: BlogPublishedMetaSchema.optional(),
  }),
  z.object({
    kind: z.literal('product-content'),
    data: z
      .object({
        title: z.string(),
        bodyHtml: z.string().describe('Product description HTML — sanitize + iframe srcdoc'),
        summary: z.string().optional().describe('zh-TW Markdown boss-facing review report'),
        tags: z.array(z.string()).optional(),
        vendor: z.string().optional(),
        productType: z.string().optional(),
        language: z.string().optional(),
        imageUrls: z.array(z.string()).optional(),
      })
      .passthrough(),
    published: ProductPublishedMetaSchema.optional(),
  }),
  z.object({
    kind: z.literal('seo-plan'),
    data: z
      .object({
        summary: z.string().optional().describe('zh-TW Markdown report for boss review'),
        topics: z.array(z.record(z.unknown())),
      })
      .passthrough(),
  }),
  z.object({
    kind: z.literal('product-plan'),
    data: z
      .object({
        summary: z.string().optional().describe('zh-TW Markdown report for boss review'),
        variants: z.array(z.record(z.unknown())),
      })
      .passthrough(),
  }),
  z.object({
    kind: z.literal('eeat-questions'),
    data: z
      .object({
        summary: z.string().optional().describe('zh-TW Markdown — why these questions matter'),
        questions: z.array(
          z
            .object({
              question: z.string(),
              hint: z.string().optional(),
              optional: z.boolean().optional(),
            })
            .passthrough(),
        ),
        askedAt: z.string().optional(),
      })
      .passthrough(),
  }),
  z.object({
    kind: z.literal('clarification'),
    data: z.object({ question: z.string() }).passthrough(),
  }),
]);

export const ArtifactSchema = z.union([NewArtifactSchema, LegacyArtifactSchema]);

export const PendingToolCallSchema = z.object({
  id: z.string(),
  args: z.record(z.unknown()),
});

export const SpawnTaskRequestSchema = z.object({
  title: z.string(),
  description: z.string().optional(),
  assignedAgent: z.string(),
  input: z.record(z.unknown()),
  scheduledAt: z.string().datetime().optional(),
});

export const TaskOutputSchema = z
  .object({
    artifact: ArtifactSchema.optional(),
    pendingToolCall: PendingToolCallSchema.optional(),
    spawnTasks: z.array(SpawnTaskRequestSchema).optional(),
    spawnedAt: z.string().optional(),
    spawnedTaskIds: z.array(z.string().uuid()).optional(),
    toolExecutedAt: z.string().optional(),
    eeatPending: z
      .object({
        questions: z.array(
          z.object({
            question: z.string(),
            hint: z.string().optional(),
            optional: z.boolean().optional(),
          }),
        ),
        askedAt: z.string(),
      })
      .optional(),
    generatedImageIds: z.array(z.string().uuid()).optional(),
  })
  .passthrough();

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
  output: TaskOutputSchema.nullable(),
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

export const TaskLogSchema = z.object({
  id: z.string().uuid(),
  taskId: z.string().uuid(),
  createdAt: z.string().datetime(),
  level: z.string(),
  event: z.string(),
  speaker: z.string().nullable(),
  message: z.string(),
  data: z.record(z.unknown()).nullable(),
});

export const StreamCursorSchema = z.object({
  cursor: z.string().datetime().nullable(),
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
