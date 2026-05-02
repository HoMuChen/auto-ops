import { AIMessage, type BaseMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { AgentInput } from '../types.js';

/**
 * Build the LangChain message array an agent feeds to its LLM.
 *
 * - Stitches the system prompt with optional tenant constraints in the
 *   "Tenant constraints:\n- a\n- b" form every built-in agent uses.
 * - Maps `input.messages` to LangChain message types: assistant turns become
 *   AIMessage so the model sees the canonical user/assistant interleave;
 *   anything else collapses to HumanMessage (system/tool turns are rare for
 *   our agents and should not be re-injected as system prompts mid-thread).
 */
export function buildAgentMessages(
  systemPrompt: string,
  history: AgentInput['messages'],
  constraints?: readonly string[],
): BaseMessage[] {
  const system =
    constraints && constraints.length > 0
      ? `${systemPrompt}\n\nTenant constraints:\n- ${constraints.join('\n- ')}`
      : systemPrompt;
  return [
    new SystemMessage(system),
    ...history.map((m) =>
      m.role === 'assistant' ? new AIMessage(m.content) : new HumanMessage(m.content),
    ),
  ];
}
