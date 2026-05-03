import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { agentRegistry } from '../agents/registry.js';
import { invokeStructured } from '../agents/lib/invoke-structured.js';
import type { ModelConfig } from '../llm/types.js';
import { buildRuntimeContext } from './runtime-context.js';
import type { GraphState } from './state.js';

const SUPERVISOR_PROMPT = `You are the Supervisor of a team of AI digital employees for an e-commerce business.
Your job: read the user's brief, decide which employee to dispatch next, or ask for clarification if the brief is ambiguous.

Routing rules:
- Choose exactly one employee from the available list, by their id.
- Strategy vs Execution: planning briefs (e.g. "plan the summer SEO campaign", "design a content calendar")
  belong to a *strategist* employee — they produce a plan that the platform splits into independent
  child execution tasks for downstream workers. Single, focused work (e.g. "write THIS one article",
  "list THIS one product") belongs to an *execution* employee. Pick the strategist when the user is
  asking for a plan with multiple deliverables; pick the execution worker when they're asking for one
  concrete artifact.
- If the brief lacks essential parameters (e.g. target language, product SKU, audience), set "nextAgent"
  to null and write a clarifying question into "clarification".
- If the work is complete and no further employee should be dispatched, set "nextAgent" to null and
  "done" to true.

Output strictly the JSON schema requested.`;

const RouteSchema = z.object({
  nextAgent: z.string().nullable(),
  clarification: z.string().nullable(),
  done: z.boolean().default(false),
  reasoning: z.string().optional(),
});
export type SupervisorRoute = z.infer<typeof RouteSchema>;

// Routing decisions are short and high-stakes: use a smart model with low
// temperature so the structured output is deterministic.
const SUPERVISOR_MODEL: ModelConfig = {
  model: 'anthropic/claude-sonnet-4.6',
  temperature: 0.1,
};

/**
 * The Supervisor node.
 *
 * Reads the conversation + tenant's available agent manifests, then asks the
 * model to either route to an agent, ask for clarification, or finish.
 *
 * IMPORTANT: when an agent has just returned with `awaitingApproval=true`, the
 * graph routes back through this node. We MUST NOT issue a new LLM call or
 * overwrite the gate flag — otherwise the HITL pause never reaches the runner
 * and the task races straight to `done`. Short-circuit and let the conditional
 * edge route to END.
 */
export async function runSupervisor(state: GraphState): Promise<Partial<GraphState>> {
  if (state.awaitingApproval) {
    return {};
  }

  // Deterministic shortcut for execution children: when the parent strategy
  // already named the owning agent, skip the routing LLM call on the first
  // hop. After the agent runs once (lastOutput set) we let normal routing
  // resume so multi-step execution flows still work.
  if (state.pinnedAgent && !state.lastOutput) {
    return { nextAgent: state.pinnedAgent };
  }

  const available = await agentRegistry.listForTenant(state.tenantId);
  const roster = available.map((a) => `- ${a.manifest.id}: ${a.manifest.description}`).join('\n');

  const userBrief =
    state.messages
      .filter((m) => m.getType() === 'human')
      .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
      .join('\n\n') || JSON.stringify(state.params);

  const decision = await invokeStructured(SUPERVISOR_MODEL, RouteSchema, 'route_decision', [
    new SystemMessage(buildRuntimeContext() + SUPERVISOR_PROMPT),
    new HumanMessage(`Available employees:\n${roster}\n\nUser brief:\n${userBrief}`),
  ]);

  if (decision.clarification) {
    // Treat the supervisor as a first-class node when it speaks to the user:
    // tag the message as AI (so the next supervisor turn doesn't re-feed it as
    // a fake follow-up brief) and fill `lastOutput` so the runner persists it
    // through the same path agents use — clarification then surfaces in the
    // `messages` table and `tasks.output`, not just in the checkpoint blob.
    return {
      messages: [new AIMessage(`[supervisor] ${decision.clarification}`)],
      nextAgent: null,
      awaitingApproval: true,
      lastOutput: {
        agentId: 'supervisor',
        message: decision.clarification,
        artifact: {
          kind: 'clarification',
          data: { question: decision.clarification },
        },
      },
    };
  }

  if (decision.done || !decision.nextAgent) {
    return { nextAgent: null, awaitingApproval: false };
  }

  return { nextAgent: decision.nextAgent };
}
