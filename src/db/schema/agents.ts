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
 * Per-tenant agent configuration.
 *
 * `agentKey` references a registered agent in the AgentRegistry (e.g. "seo-expert").
 * `modelConfig` lets each tenant pick a different LLM per agent (provider + model + temperature).
 * `prompt` is an optional override of the agent's default system prompt.
 * `tools` is an optional override/whitelist of tool ids.
 *
 * If no row exists for a (tenant, agent) pair, defaults from the registry apply.
 * Subscription plans can gate which agentKeys are allowed for which plan.
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
    modelConfig: jsonb('model_config').$type<{
      provider: 'anthropic' | 'openai';
      model: string;
      temperature?: number;
      maxTokens?: number;
    }>(),
    promptOverride: text('prompt_override'),
    toolWhitelist: jsonb('tool_whitelist').$type<string[]>(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
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
