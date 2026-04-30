import { pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';

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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.tenantId, table.userId] }),
  }),
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type TenantMember = typeof tenantMembers.$inferSelect;
