import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';

/**
 * Per-tenant agent configuration ("the user has hired this AI employee").
 *
 * `agentKey` references a registered agent in the AgentRegistry (e.g. "seo-expert").
 * `promptOverride` is an optional override of the agent's default system prompt.
 * `toolWhitelist` is an optional whitelist of tool ids the agent is allowed to call.
 * `config` is the user-supplied activation config, validated against
 *   `AgentManifest.configSchema` at activation time. Available at runtime as
 *   `AgentBuildContext.agentConfig`.
 *
 * Note: there is no per-tenant model override. Each agent picks its own model
 * in code (manifest.defaultModel) — every request goes through OpenRouter.
 *
 * If no row exists for a (tenant, agent) pair, the agent is implicitly enabled
 * and `config` defaults to {}. Subscription plans gate which agentKeys are allowed.
 */
export const agentConfigs = pgTable(
  'agent_configs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    agentKey: text('agent_key').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    promptOverride: text('prompt_override'),
    toolWhitelist: jsonb('tool_whitelist').$type<string[]>(),
    config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantAgentUnique: uniqueIndex('agent_configs_tenant_agent_uq').on(
      table.tenantId,
      table.agentKey,
    ),
    tenantIdx: index('agent_configs_tenant_idx').on(table.tenantId),
  }),
);

export type AgentConfig = typeof agentConfigs.$inferSelect;
export type NewAgentConfig = typeof agentConfigs.$inferInsert;
