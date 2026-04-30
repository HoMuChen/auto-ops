import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type SubscriptionPlan, agentConfigs, tenants } from '../db/schema/index.js';
import { NotFoundError } from '../lib/errors.js';
import type { AgentManifest, IAgent } from './types.js';

/**
 * Process-wide AgentRegistry.
 *
 * - Agents register themselves at bootstrap (see agents/index.ts).
 * - The Supervisor calls `listForTenant(tenantId)` to discover which agents are
 *   enabled given the tenant's subscription plan AND any explicit per-tenant
 *   enable/disable in `agent_configs`.
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
   * Resolve the agents available to a tenant. Filters by subscription plan and
   * by explicit `enabled` flags in agent_configs.
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
      // Default to enabled if no explicit override exists
      return overrideMap.get(agent.manifest.id) ?? true;
    });
  }

  /**
   * Variant that also accepts a transaction handle, for callers already
   * inside a tenant-scoped transaction.
   */
  async resolveAgent(tenantId: string, agentId: string): Promise<IAgent> {
    const list = await this.listForTenant(tenantId);
    const agent = list.find((a) => a.manifest.id === agentId);
    if (!agent) {
      throw new NotFoundError(`Agent ${agentId} (not enabled for tenant ${tenantId})`);
    }
    return agent;
  }
}

export const agentRegistry = new AgentRegistry();
