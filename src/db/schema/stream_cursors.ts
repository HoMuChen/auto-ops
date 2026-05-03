import { pgTable, primaryKey, timestamp, uuid } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';
import { users } from './users.js';

/**
 * Tracks how far each user has explicitly read in the tenant activity stream.
 * Updated by the frontend via PUT /v1/stream/cursor when the user marks logs as read.
 * Used by GET /v1/stream as the replay start point when no ?since= is provided.
 */
export const userStreamCursors = pgTable(
  'user_stream_cursors',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    cursorAt: timestamp('cursor_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.userId, table.tenantId] }),
  }),
);

export type UserStreamCursor = typeof userStreamCursors.$inferSelect;
