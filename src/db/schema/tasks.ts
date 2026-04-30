import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';
import { users } from './users.js';

export const taskStatusEnum = ['todo', 'in_progress', 'waiting', 'done', 'failed'] as const;
export type TaskStatus = (typeof taskStatusEnum)[number];

export const taskKindEnum = ['strategy', 'execution'] as const;
export type TaskKind = (typeof taskKindEnum)[number];

/**
 * Tasks table — the kanban entity AND the queue.
 *
 * State machine:
 *   todo --(worker picks up)--> in_progress
 *   in_progress --(HITL gate)--> waiting
 *   waiting --(approve)--> in_progress | done
 *   waiting --(feedback)--> in_progress (with new instruction)
 *   in_progress --(success)--> done
 *   * --(error/discard)--> failed
 *
 * Worker poll predicate:
 *   status = 'todo' AND (scheduled_at IS NULL OR scheduled_at <= now()) AND locked_until IS NULL
 *
 * Plus an atomic UPDATE ... WHERE ... RETURNING to claim a task with a lock window.
 */
export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),

    parentTaskId: uuid('parent_task_id').references((): AnyPgColumn => tasks.id, {
      onDelete: 'set null',
    }),

    title: text('title').notNull(),
    description: text('description'),
    kind: text('kind', { enum: taskKindEnum }).notNull().default('execution'),

    /** Which agent (or "supervisor") is responsible for the next step. */
    assignedAgent: text('assigned_agent'),

    status: text('status', { enum: taskStatusEnum }).notNull().default('todo'),

    /** Free-form input parameters captured from the conversation. */
    input: jsonb('input').$type<Record<string, unknown>>().notNull().default({}),
    /** Final output payload (text content, generated assets, etc). */
    output: jsonb('output').$type<Record<string, unknown>>(),
    /** Last error if any. */
    error: jsonb('error').$type<{ message: string; stack?: string; cause?: unknown }>(),

    /** LangGraph thread id (== task id by default) used by the checkpointer. */
    threadId: uuid('thread_id').notNull().defaultRandom(),

    /** When this task should first become eligible for the worker. */
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
    /** Optimistic lease for the worker that has claimed this task. */
    lockedBy: text('locked_by'),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),

    attempts: jsonb('attempts').$type<{ count: number; max: number }>().notNull().default({
      count: 0,
      max: 3,
    }),

    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`now()`),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => ({
    tenantStatusIdx: index('tasks_tenant_status_idx').on(table.tenantId, table.status),
    pollingIdx: index('tasks_polling_idx').on(table.status, table.scheduledAt),
    parentIdx: index('tasks_parent_idx').on(table.parentTaskId),
    threadIdx: index('tasks_thread_idx').on(table.threadId),
  }),
);

export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
