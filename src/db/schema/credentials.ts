import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';

export const credentialProviderEnum = ['shopify', 'threads', 'instagram', 'facebook'] as const;
export type CredentialProvider = (typeof credentialProviderEnum)[number];

/**
 * Credential Vault: encrypted at the application layer before persisting.
 * `secret` is opaque ciphertext; `metadata` holds non-sensitive, queryable fields
 * (store URL, OAuth scopes, expiration, etc).
 */
export const tenantCredentials = pgTable(
  'tenant_credentials',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    provider: text('provider', { enum: credentialProviderEnum }).notNull(),
    label: text('label'),
    secret: text('secret').notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantProviderIdx: index('tenant_credentials_tenant_provider_idx').on(
      table.tenantId,
      table.provider,
    ),
    tenantProviderLabelUnique: uniqueIndex('tenant_credentials_tenant_provider_label_uq').on(
      table.tenantId,
      table.provider,
      table.label,
    ),
  }),
);

export type TenantCredential = typeof tenantCredentials.$inferSelect;
export type NewTenantCredential = typeof tenantCredentials.$inferInsert;
