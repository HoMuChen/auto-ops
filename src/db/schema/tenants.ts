import { sql } from 'drizzle-orm';
import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const subscriptionPlanEnum = ['basic', 'pro', 'flagship'] as const;
export type SubscriptionPlan = (typeof subscriptionPlanEnum)[number];

export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  plan: text('plan', { enum: subscriptionPlanEnum }).notNull().default('basic'),
  profileMd: text('profile_md').notNull().default(''),
  timezone: text('timezone').notNull().default('UTC'),
  imageStyleSuffix: text('image_style_suffix').notNull().default(''),
  imageStyleReferenceImageIds: uuid('image_style_reference_image_ids').array().notNull().default([]),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`now()`),
});

export type Tenant = typeof tenants.$inferSelect;
export type NewTenant = typeof tenants.$inferInsert;
