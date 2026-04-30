import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { tasks } from './tasks.js';
import { tenants } from './tenants.js';

export const taskLogLevelEnum = ['debug', 'info', 'warn', 'error'] as const;
export type TaskLogLevel = (typeof taskLogLevelEnum)[number];

/**
 * Atomic log lines emitted during task execution.
 * Persisted for audit + history; also fan-out via in-process EventBus for SSE.
 */
export const taskLogs = pgTable(
  'task_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    level: text('level', { enum: taskLogLevelEnum }).notNull().default('info'),
    /** Short event tag, e.g. "agent.started", "tool.shopify.create_product", "gate.waiting". */
    event: text('event').notNull(),
    /** Human-readable detail line shown in the kanban card. */
    message: text('message').notNull(),
    /** Optional structured data (tool args, model usage, etc). */
    data: jsonb('data').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    taskCreatedIdx: index('task_logs_task_created_idx').on(table.taskId, table.createdAt),
    tenantIdx: index('task_logs_tenant_idx').on(table.tenantId),
  }),
);

export type TaskLog = typeof taskLogs.$inferSelect;
export type NewTaskLog = typeof taskLogs.$inferInsert;
