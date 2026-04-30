import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { tasks } from './tasks.js';
import { tenants } from './tenants.js';
import { users } from './users.js';

export const messageRoleEnum = ['user', 'assistant', 'system', 'tool'] as const;
export type MessageRole = (typeof messageRoleEnum)[number];

/**
 * Conversation messages — both Supervisor clarification dialog and HITL feedback.
 *
 * Each conversation thread is anchored to a task (parent or child). When the user
 * sends a Feedback during a Waiting gate, a new message with role='user' is appended,
 * and the agent re-runs reading this history.
 */
export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    role: text('role', { enum: messageRoleEnum }).notNull(),
    /** When role='assistant', which agent produced this. */
    agentKey: text('agent_key'),
    content: text('content').notNull(),
    /** Tool calls / structured payloads attached to this message. */
    data: jsonb('data').$type<Record<string, unknown>>(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    taskCreatedIdx: index('messages_task_created_idx').on(table.taskId, table.createdAt),
    tenantIdx: index('messages_tenant_idx').on(table.tenantId),
  }),
);

export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
