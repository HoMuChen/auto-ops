import { jsonb, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';

/**
 * Per-(user, tenant) notification preferences. Stored as jsonb so future
 * channels (Slack, webhooks) and trigger types don't need a migration.
 *
 * Defaults differ by trigger: done is opt-in (`notifyOnDone` defaults false —
 * pure FYI signal) while waiting is opt-out (`notifyOnWaiting` defaults
 * true — waiting means the system is genuinely blocked on the user, so
 * staying silent is the worse failure mode).
 */
export interface NotificationSettings {
  notifyOnDone?: boolean;
  notifyOnWaiting?: boolean;
}

export const users = pgTable('users', {
  id: uuid('id').primaryKey(),
  email: text('email').notNull().unique(),
  displayName: text('display_name'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const userRoleEnum = ['owner', 'admin', 'operator', 'viewer'] as const;
export type UserRole = (typeof userRoleEnum)[number];

export const tenantMembers = pgTable(
  'tenant_members',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role', { enum: userRoleEnum }).notNull().default('operator'),
    notificationSettings: jsonb('notification_settings').$type<NotificationSettings>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.tenantId, table.userId] }),
  }),
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type TenantMember = typeof tenantMembers.$inferSelect;
