import { sql } from 'drizzle-orm';
import { jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const subscriptionPlanEnum = ['basic', 'pro', 'flagship'] as const;
export type SubscriptionPlan = (typeof subscriptionPlanEnum)[number];

export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  plan: text('plan', { enum: subscriptionPlanEnum }).notNull().default('basic'),
  brandVoice: jsonb('brand_voice').$type<{
    tone?: string;
    languages?: string[];
    keywords?: string[];
    forbidden?: string[];
  }>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`now()`),
});

export type Tenant = typeof tenants.$inferSelect;
export type NewTenant = typeof tenants.$inferInsert;
