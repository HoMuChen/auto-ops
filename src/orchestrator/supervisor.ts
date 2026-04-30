import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { agentRegistry } from '../agents/registry.js';
import { buildModel } from '../llm/model-registry.js';
import type { ModelConfig } from '../llm/types.js';
import type { GraphState } from './state.js';

const SUPERVISOR_PROMPT = `You are the Supervisor of a team of AI digital employees for an e-commerce business.
Your job: read the user's brief, decide which employee to dispatch next, or ask for clarification if the brief is ambiguous.

Routing rules:
- Choose exactly one employee from the available list, by their id.
- If the brief lacks essential parameters (e.g. target language, product SKU, audience), set "nextAgent" to null and write a clarifying question into "clarification".
- If the work is complete and no further employee should be dispatched, set "nextAgent" to null and "done" to true.

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
  model: 'anthropic/claude-opus-4.7',
  temperature: 0.1,
};

/**
 * The Supervisor node.
 *
 * Reads the conversation + tenant's available agent manifests, then asks the
 * model to either route to an agent, ask for clarification, or finish.
 */
export async function runSupervisor(state: GraphState): Promise<Partial<GraphState>> {
  const available = await agentRegistry.listForTenant(state.tenantId);
  const roster = available.map((a) => `- ${a.manifest.id}: ${a.manifest.description}`).join('\n');

  const model = buildModel(SUPERVISOR_MODEL).withStructuredOutput(RouteSchema, {
    name: 'route_decision',
  });

  const userBrief =
    state.messages
      .filter((m) => m.getType() === 'human')
      .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
      .join('\n\n') || JSON.stringify(state.params);

  const decision = await model.invoke([
    new SystemMessage(SUPERVISOR_PROMPT),
    new HumanMessage(`Available employees:\n${roster}\n\nUser brief:\n${userBrief}`),
  ]);

  if (decision.clarification) {
    return {
      messages: [new HumanMessage(`[supervisor] ${decision.clarification}`)],
      nextAgent: null,
      awaitingApproval: true,
    };
  }

  if (decision.done || !decision.nextAgent) {
    return { nextAgent: null, awaitingApproval: false };
  }

  return { nextAgent: decision.nextAgent };
}
