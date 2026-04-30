import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  type SubscriptionPlan,
  agentConfigs,
  tenantCredentials,
  tenants,
} from '../db/schema/index.js';
import { ForbiddenError, NotFoundError } from '../lib/errors.js';
import {
  type CredentialChecklistItem,
  type CredentialPresence,
  assertCredentialsBound,
  buildCredentialChecklist,
  validateAgentConfig,
} from './activation.js';
import type { AgentManifest, IAgent } from './types.js';

export interface ActivationStatus {
  agent: IAgent;
  enabled: boolean;
  planAllowed: boolean;
  config: Record<string, unknown>;
  modelOverride: NonNullable<typeof agentConfigs.$inferSelect.modelConfig> | null;
  promptOverride: string | null;
  toolWhitelist: string[] | null;
  credentials: CredentialChecklistItem[];
  /** True iff the activate endpoint would succeed right now without further input. */
  ready: boolean;
}

export interface ActivateInput {
  tenantId: string;
  agentId: string;
  config: unknown;
  modelOverride?: {
    provider: 'anthropic' | 'openai';
    model: string;
    temperature?: number;
    maxTokens?: number;
  } | null;
  promptOverride?: string | null;
  toolWhitelist?: string[] | null;
}

/**
 * Process-wide AgentRegistry.
 *
 * - Agents register themselves at bootstrap (see agents/index.ts).
 * - `listForTenant(tenantId)` discovers enabled agents (plan + explicit toggle).
 * - `getActivationStatus()` powers the UI's "hire this employee" preview.
 * - `activate()` is the single write path for enabling an agent — it validates
 *   plan, required credentials, and configSchema before upserting.
 *
 * This is the single insertion point for "聘用 AI 員工" gating logic.
 */
export class AgentRegistry {
  private agents = new Map<string, IAgent>();

  register(agent: IAgent): void {
    if (this.agents.has(agent.manifest.id)) {
      throw new Error(`Agent ${agent.manifest.id} is already registered`);
    }
    this.agents.set(agent.manifest.id, agent);
  }

  unregister(id: string): void {
    this.agents.delete(id);
  }

  get(id: string): IAgent {
    const agent = this.agents.get(id);
    if (!agent) throw new NotFoundError(`Agent ${id}`);
    return agent;
  }

  has(id: string): boolean {
    return this.agents.has(id);
  }

  /** All registered manifests, regardless of tenant. */
  manifests(): AgentManifest[] {
    return [...this.agents.values()].map((a) => a.manifest);
  }

  /**
   * Agents currently enabled for a tenant (plan-allowed + agent_configs.enabled).
   * Used by the Supervisor + graph builder.
   */
  async listForTenant(tenantId: string): Promise<IAgent[]> {
    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
    if (!tenant) throw new NotFoundError(`Tenant ${tenantId}`);

    const overrides = await db
      .select({ agentKey: agentConfigs.agentKey, enabled: agentConfigs.enabled })
      .from(agentConfigs)
      .where(eq(agentConfigs.tenantId, tenantId));

    const overrideMap = new Map(overrides.map((o) => [o.agentKey, o.enabled]));

    return [...this.agents.values()].filter((agent) => {
      const planAllowed = agent.manifest.availableInPlans.includes(tenant.plan as SubscriptionPlan);
      if (!planAllowed) return false;
      return overrideMap.get(agent.manifest.id) ?? true;
    });
  }

  async resolveAgent(tenantId: string, agentId: string): Promise<IAgent> {
    const list = await this.listForTenant(tenantId);
    const agent = list.find((a) => a.manifest.id === agentId);
    if (!agent) {
      throw new NotFoundError(`Agent ${agentId} (not enabled for tenant ${tenantId})`);
    }
    return agent;
  }

  /**
   * Activation preview for a tenant: shows the missing credentials, current
   * config, and whether `activate()` would succeed. The frontend uses this to
   * render the "hire this employee" form.
   */
  async getActivationStatus(tenantId: string, agentId: string): Promise<ActivationStatus> {
    const agent = this.get(agentId);

    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
    if (!tenant) throw new NotFoundError(`Tenant ${tenantId}`);
    const planAllowed = agent.manifest.availableInPlans.includes(tenant.plan as SubscriptionPlan);

    const [override] = await db
      .select()
      .from(agentConfigs)
      .where(and(eq(agentConfigs.tenantId, tenantId), eq(agentConfigs.agentKey, agentId)))
      .limit(1);

    const presence = await loadCredentialPresence(tenantId);
    const credentials = buildCredentialChecklist(agent.manifest, presence);

    const credsReady = credentials.every((c) => c.bound);
    const ready = planAllowed && credsReady;

    return {
      agent,
      enabled: override?.enabled ?? false,
      planAllowed,
      config: (override?.config as Record<string, unknown>) ?? {},
      modelOverride: override?.modelConfig ?? null,
      promptOverride: override?.promptOverride ?? null,
      toolWhitelist: override?.toolWhitelist ?? null,
      credentials,
      ready,
    };
  }

  /**
   * Activate an agent for a tenant. Validates:
   *   1. Agent exists in the registry.
   *   2. Tenant's subscription plan includes this agent.
   *   3. All `requiredCredentials` are bound.
   *   4. `config` parses against `manifest.configSchema`.
   *
   * On success, upserts the `agent_configs` row with `enabled=true`. Idempotent —
   * re-activating with new config replaces the old config.
   */
  async activate(input: ActivateInput): Promise<{
    enabled: true;
    config: Record<string, unknown>;
  }> {
    const agent = this.get(input.agentId);

    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, input.tenantId)).limit(1);
    if (!tenant) throw new NotFoundError(`Tenant ${input.tenantId}`);
    if (!agent.manifest.availableInPlans.includes(tenant.plan as SubscriptionPlan)) {
      throw new ForbiddenError(
        `Agent ${agent.manifest.id} is not available on the ${tenant.plan} plan`,
      );
    }

    const presence = await loadCredentialPresence(input.tenantId);
    assertCredentialsBound(agent.manifest, presence);

    const validatedConfig = validateAgentConfig(agent.manifest, input.config);

    if (input.toolWhitelist && agent.manifest.toolIds) {
      const known = new Set(agent.manifest.toolIds);
      const unknown = input.toolWhitelist.filter((t) => !known.has(t));
      if (unknown.length > 0) {
        throw new ForbiddenError(`Unknown tool ids: ${unknown.join(', ')}`, { unknown });
      }
    }

    await db
      .insert(agentConfigs)
      .values({
        tenantId: input.tenantId,
        agentKey: input.agentId,
        enabled: true,
        config: validatedConfig,
        modelConfig: input.modelOverride ?? null,
        promptOverride: input.promptOverride ?? null,
        toolWhitelist: input.toolWhitelist ?? null,
      })
      .onConflictDoUpdate({
        target: [agentConfigs.tenantId, agentConfigs.agentKey],
        set: {
          enabled: true,
          config: validatedConfig,
          modelConfig: input.modelOverride ?? null,
          promptOverride: input.promptOverride ?? null,
          toolWhitelist: input.toolWhitelist ?? null,
          updatedAt: sql`now()`,
        },
      });

    return { enabled: true, config: validatedConfig };
  }

  /** Disable without deleting config (so re-activation restores the previous setup). */
  async deactivate(tenantId: string, agentId: string): Promise<void> {
    this.get(agentId); // existence check
    await db
      .update(agentConfigs)
      .set({ enabled: false, updatedAt: sql`now()` })
      .where(and(eq(agentConfigs.tenantId, tenantId), eq(agentConfigs.agentKey, agentId)));
  }

  /** Read the persisted config for runtime use (graph builder). Empty {} if none. */
  async loadConfig(
    tenantId: string,
    agentId: string,
  ): Promise<{
    config: Record<string, unknown>;
    promptOverride: string | null;
    toolWhitelist: string[] | null;
  }> {
    const [row] = await db
      .select({
        config: agentConfigs.config,
        promptOverride: agentConfigs.promptOverride,
        toolWhitelist: agentConfigs.toolWhitelist,
      })
      .from(agentConfigs)
      .where(and(eq(agentConfigs.tenantId, tenantId), eq(agentConfigs.agentKey, agentId)))
      .limit(1);
    return {
      config: (row?.config as Record<string, unknown>) ?? {},
      promptOverride: row?.promptOverride ?? null,
      toolWhitelist: row?.toolWhitelist ?? null,
    };
  }
}

async function loadCredentialPresence(tenantId: string): Promise<CredentialPresence[]> {
  const rows = await db
    .select({
      provider: tenantCredentials.provider,
      label: tenantCredentials.label,
    })
    .from(tenantCredentials)
    .where(eq(tenantCredentials.tenantId, tenantId));

  const map = new Map<string, string[]>();
  for (const r of rows) {
    const list = map.get(r.provider) ?? [];
    list.push(r.label ?? '');
    map.set(r.provider, list);
  }
  return [...map.entries()].map(([provider, labels]) => ({
    provider: provider as CredentialPresence['provider'],
    labels,
  }));
}

export const agentRegistry = new AgentRegistry();
