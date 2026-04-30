import type { StructuredToolInterface } from '@langchain/core/tools';
import type { ZodType } from 'zod';
import type { CredentialProvider, SubscriptionPlan } from '../db/schema/index.js';
import type { ModelConfig } from '../llm/types.js';

/**
 * The pluggable Agent contract.
 *
 * Each AI employee (SEO Expert, Ops Assistant, Domain Expert…) implements this
 * interface and registers itself with the AgentRegistry. The Supervisor never
 * imports concrete agents; it only sees `IAgent` instances via the registry.
 *
 * Lifecycle:
 *   1. Bootstrap: registry.register(agent)
 *   2. Per request: registry.list({ tenantId }) → enabled agents for that tenant
 *   3. Graph build: each agent's `buildNode(ctx)` is added as a LangGraph node
 *   4. Execution: Supervisor routes by `agent.id`; agent runs with tenant-scoped tools
 */
export interface RequiredCredential {
  /** Which provider (matches tenant_credentials.provider). */
  provider: CredentialProvider;
  /** UI-facing reason this agent needs the credential. */
  description: string;
  /** Optional link to provider docs explaining how to obtain the secret. */
  setupUrl?: string;
  /**
   * Optional `tenant_credentials.label` selector; defaults to whichever row
   * the agent's tools resolve at runtime.
   */
  defaultLabel?: string;
}

export interface AgentManifest {
  /** Stable identifier, used as DB key and as LangGraph node id. e.g. "seo-expert". */
  id: string;
  /** Human-readable name shown in UI. */
  name: string;
  /** One-line description used by Supervisor for routing decisions. */
  description: string;
  /** Subscription plans that include this agent. */
  availableInPlans: readonly SubscriptionPlan[];
  /** Default model used when no per-tenant override exists. */
  defaultModel: ModelConfig;
  /** Default system prompt used when no per-tenant override exists. */
  defaultPrompt: string;

  /**
   * Tool ids this agent contributes. Static — used by the activation UI to
   * preview "what this employee can do" and by `tool_whitelist` validation.
   */
  toolIds?: readonly string[];

  /**
   * Provider credentials required for this agent's tools to function. The
   * activation flow refuses to enable the agent until each listed provider
   * has at least one row in `tenant_credentials`.
   */
  requiredCredentials?: readonly RequiredCredential[];

  /**
   * User-supplied configuration schema (Zod). Validated on activation; the
   * resulting parsed value is persisted to `agent_configs.config` and made
   * available to `build()` via `AgentBuildContext.agentConfig`.
   *
   * If undefined, the agent has no per-tenant config and `agentConfig` will
   * be an empty object at runtime.
   */
  // biome-ignore lint/suspicious/noExplicitAny: zod schema is intentionally generic
  configSchema?: ZodType<any>;

  /** Optional metadata (icon, category, etc). */
  metadata?: Record<string, unknown>;
}

/** Context passed when building an agent's runnable node. */
export interface AgentBuildContext {
  tenantId: string;
  taskId: string;
  /** The model resolved for this (tenant, agent) pair. */
  modelConfig: ModelConfig;
  /** The system prompt resolved for this (tenant, agent) pair. */
  systemPrompt: string;
  /** Tool whitelist if the tenant has restricted tools; undefined = all. */
  toolWhitelist?: string[] | undefined;
  /**
   * Validated agent config (already parsed against `manifest.configSchema`).
   * Empty object when the agent has no schema or no row in `agent_configs`.
   */
  agentConfig: Record<string, unknown>;
  /** Logger callback — agents emit atomic logs through this. */
  emitLog: (event: string, message: string, data?: Record<string, unknown>) => Promise<void>;
}

/**
 * Tool registration. Tools belong to agents but the registry exposes them as a
 * flat namespace ("agentId.toolName") so the Supervisor and HITL gates can
 * reference any tool by id.
 */
export interface AgentTool {
  /** Stable id, e.g. "shopify.create_product". */
  id: string;
  /** LangChain StructuredTool instance. */
  tool: StructuredToolInterface;
  /** If true, this tool requires a Waiting (HITL) gate before execution. */
  requiresApproval?: boolean;
}

/**
 * The runnable surface of an agent. `invoke` returns a partial state update
 * that the LangGraph supervisor merges into the shared GraphState.
 */
export interface AgentRunnable {
  /** Tools this agent contributes (may be filtered by toolWhitelist). */
  tools: AgentTool[];
  /** Run a single agent step. */
  invoke(input: AgentInput): Promise<AgentOutput>;
}

export interface AgentInput {
  /** The conversation thread visible to the agent. */
  messages: { role: 'user' | 'assistant' | 'system' | 'tool'; content: string }[];
  /** Free-form params from the task input. */
  params: Record<string, unknown>;
}

export interface AgentOutput {
  /** Assistant message produced by the agent. */
  message: string;
  /** Whether the agent is requesting a HITL gate (Waiting state). */
  awaitingApproval?: boolean;
  /** Output payload to attach to the task (final or intermediate). */
  payload?: Record<string, unknown>;
  /** Tool calls the agent made, for audit. */
  toolCalls?: { id: string; args: Record<string, unknown>; result?: unknown }[];
}

/** The full Agent: manifest + a factory that produces a runnable for a given context. */
export interface IAgent {
  manifest: AgentManifest;
  build(ctx: AgentBuildContext): Promise<AgentRunnable> | AgentRunnable;
}
