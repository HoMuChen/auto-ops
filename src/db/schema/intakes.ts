import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { tasks } from './tasks.js';
import { tenants } from './tenants.js';
import { users } from './users.js';

export const intakeStatusEnum = ['open', 'finalized', 'abandoned'] as const;
export type IntakeStatus = (typeof intakeStatusEnum)[number];

export const intakeMessageRoleEnum = ['user', 'assistant'] as const;
export type IntakeMessageRole = (typeof intakeMessageRoleEnum)[number];

export type IntakeMessage = {
  role: IntakeMessageRole;
  content: string;
  createdAt: string;
};

/**
 * Task intakes — pre-task clarification conversations.
 *
 * Independent of `tasks` so drafts never appear on the kanban. Once the user is
 * happy with `draftBrief`, calling finalize spawns a real task in `todo` status
 * and stamps `finalizedTaskId` here for traceability.
 *
 * Lifecycle:
 *   open → finalized   (user confirms draft brief, task spawned)
 *   open → abandoned   (user closes the conversation without committing)
 */
export const taskIntakes = pgTable(
  'task_intakes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),

    status: text('status', { enum: intakeStatusEnum }).notNull().default('open'),

    /** Whole conversation in one column — short-lived, no need for a side table yet. */
    messages: jsonb('messages').$type<IntakeMessage[]>().notNull().default(sql`'[]'::jsonb`),

    /** Intake agent's running summary of what the user wants. Becomes tasks.description on finalize. */
    draftBrief: text('draft_brief'),
    /** Intake agent's running suggested task title. Becomes tasks.title on finalize. */
    draftTitle: text('draft_title'),

    /** Set when status='finalized'. */
    finalizedTaskId: uuid('finalized_task_id').references(() => tasks.id, {
      onDelete: 'set null',
    }),
    finalizedAt: timestamp('finalized_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`now()`),
  },
  (table) => ({
    tenantStatusIdx: index('task_intakes_tenant_status_idx').on(table.tenantId, table.status),
    tenantUpdatedIdx: index('task_intakes_tenant_updated_idx').on(table.tenantId, table.updatedAt),
  }),
);

export type TaskIntake = typeof taskIntakes.$inferSelect;
export type NewTaskIntake = typeof taskIntakes.$inferInsert;
