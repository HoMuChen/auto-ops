import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { END, START, StateGraph } from '@langchain/langgraph';
import { agentRegistry } from '../agents/registry.js';
import type { AgentBuildContext } from '../agents/types.js';
import { getImagesByIds } from '../integrations/cloudflare/images-repository.js';
import { getCheckpointer } from './checkpointer.js';
import { buildRuntimeContext } from './runtime-context.js';
import { type GraphState, GraphStateAnnotation } from './state.js';
import { runSupervisor } from './supervisor.js';

/**
 * Build the LangGraph for a tenant.
 *
 * Topology:
 *
 *   START → supervisor ─┬→ <agent-1> → supervisor (loop)
 *                       ├→ <agent-2> → supervisor (loop)
 *                       └→ END (when nextAgent is null)
 *
 * Agents are discovered dynamically per tenant. Each agent's runnable receives
 * its own tenant-scoped context (resolved model, prompt overrides, tool whitelist).
 *
 * Persistence: PostgresSaver checkpoints state under thread_id == taskId.
 */
export interface BuildGraphOptions {
  tenantId: string;
  taskId: string;
  /**
   * Framework emitLog. Wider signature than `AgentBuildContext.emitLog` —
   * accepts an optional `speaker` so the graph wrapper can tag every agent
   * log with the agent's id (or 'supervisor' / 'system' from the runner).
   * Agents themselves still see the simpler 3-arg surface.
   */
  emitLog: (
    event: string,
    message: string,
    data?: Record<string, unknown>,
    speaker?: string,
  ) => Promise<void>;
}

export async function buildGraph(opts: BuildGraphOptions) {
  const agents = await agentRegistry.listForTenant(opts.tenantId);

  const graph = new StateGraph(GraphStateAnnotation).addNode('supervisor', runSupervisor);

  for (const agent of agents) {
    const manifest = agent.manifest;
    // Peers visible to *this* agent: every other tenant-enabled agent. Strategy
    // agents use this list to decide who to assign each child to.
    const peerDescriptors = agents
      .filter((a) => a.manifest.id !== manifest.id)
      .map((a) => ({
        id: a.manifest.id,
        name: a.manifest.name,
        description: a.manifest.description,
        metadata: a.manifest.metadata,
      }));

    graph.addNode(manifest.id, async (state: GraphState) => {
      const override = await agentRegistry.loadConfig(opts.tenantId, manifest.id);
      // Prepend the runtime context block — agents need not opt in; they just
      // use ctx.systemPrompt as before and automatically get "Current time"
      // (and, in future, tenant industry / brand voice / timezone).
      const basePrompt = override.promptOverride ?? manifest.defaultPrompt;
      // Wrap the framework emitLog so every entry the agent writes is auto-
      // tagged with `speaker = manifest.id`. Agents stay ignorant of the
      // speaker concept; the kanban timeline always knows who's talking.
      const agentEmitLog: AgentBuildContext['emitLog'] = (event, message, data) =>
        opts.emitLog(event, message, data, manifest.id);
      const ctx: AgentBuildContext = {
        tenantId: opts.tenantId,
        taskId: opts.taskId,
        // Model is fixed in the manifest — no per-tenant override.
        modelConfig: manifest.defaultModel,
        systemPrompt: buildRuntimeContext() + basePrompt,
        ...(override.toolWhitelist ? { toolWhitelist: override.toolWhitelist } : {}),
        agentConfig: override.config,
        availableExecutionAgents: peerDescriptors,
        emitLog: agentEmitLog,
      };
      const runnable = await agent.build(ctx);

      const imageResolver = state.taskImageIds?.length
        ? async (ids: string[]) => {
            const imgs = await getImagesByIds(opts.tenantId, ids);
            return imgs.map((i) => i.url);
          }
        : undefined;

      const agentMessages = state.messages.map((m, idx) => ({
        role: m.getType() === 'human' ? 'user' : m.getType() === 'ai' ? 'assistant' : 'system',
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        // Attach all task imageIds to the first human message so the agent sees all uploads.
        imageIds: state.taskImageIds && idx === 0 ? state.taskImageIds : undefined,
      })) as {
        role: 'user' | 'assistant' | 'system' | 'tool';
        content: string;
        imageIds?: string[];
      }[];

      const result = await runnable.invoke({
        messages: agentMessages,
        params: state.params,
        taskOutput: state.currentTaskOutput ?? undefined,
        imageResolver,
      });

      return {
        messages: [new AIMessage(result.message)],
        lastOutput: {
          agentId: manifest.id,
          message: result.message,
          payload: result.payload,
          ...(result.spawnTasks ? { spawnTasks: result.spawnTasks } : {}),
          ...(result.pendingToolCall ? { pendingToolCall: result.pendingToolCall } : {}),
        },
        awaitingApproval: result.awaitingApproval ?? false,
        nextAgent: null,
      };
    });
  }

  graph.addEdge(START, 'supervisor').addConditionalEdges('supervisor', (state: GraphState) => {
    if (state.awaitingApproval) return END;
    if (!state.nextAgent) return END;
    return state.nextAgent;
  });

  for (const agent of agents) {
    graph.addEdge(agent.manifest.id as never, 'supervisor' as never);
  }

  const checkpointer = await getCheckpointer();
  return graph.compile({ checkpointer });
}

/** Helper to seed an initial state for a fresh task. */
export function initialState(input: {
  tenantId: string;
  taskId: string;
  brief: string;
  params: Record<string, unknown>;
  /** Set for execution children spawned with an explicit owner — bypasses the supervisor LLM. */
  pinnedAgent?: string | null;
  taskImageIds?: string[] | null;
}): Partial<GraphState> {
  return {
    tenantId: input.tenantId,
    taskId: input.taskId,
    messages: [new HumanMessage(input.brief)],
    params: input.params,
    nextAgent: null,
    pinnedAgent: input.pinnedAgent ?? null,
    awaitingApproval: false,
    lastOutput: null,
    taskImageIds: input.taskImageIds ?? null,
  };
}
