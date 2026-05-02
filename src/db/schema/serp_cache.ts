import { jsonb, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';

export const serpCache = pgTable(
  'serp_cache',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    queryHash: text('query_hash').notNull(),
    locale: text('locale').notNull().default(''),
    payload: jsonb('payload').notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.tenantId, table.queryHash, table.locale] }),
    // expiresAt index omitted — table is small; add if needed
  }),
);

export type SerpCacheRow = typeof serpCache.$inferSelect;
export type NewSerpCacheRow = typeof serpCache.$inferInsert;
