import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';

/**
 * Per-tenant markdown skill pack. Body is plain markdown (no frontmatter —
 * metadata lives in sibling columns). `applies_to` doubles as scope AND
 * activation: a pack with applies_to = ['article-writer'] is loaded
 * for that agent's prompt automatically; remove the agent id to disable.
 *
 * `key` must be `tenant.<slug>` to keep the namespace disjoint from
 * built-in pack keys (`eeat`, `seoFundamentals`, `aiSeo`, …).
 */
export const tenantSkillPacks = pgTable(
  'tenant_skill_packs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    name: text('name').notNull(),
    body: text('body').notNull(),
    appliesTo: text('applies_to').array().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantKeyUnique: uniqueIndex('tenant_skill_packs_tenant_key_uq').on(t.tenantId, t.key),
    tenantIdx: index('tenant_skill_packs_tenant_idx').on(t.tenantId),
    appliesToGin: index('tenant_skill_packs_applies_to_gin').using('gin', t.appliesTo),
  }),
);

export type TenantSkillPack = typeof tenantSkillPacks.$inferSelect;
export type NewTenantSkillPack = typeof tenantSkillPacks.$inferInsert;
