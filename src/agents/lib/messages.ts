import { AIMessage, type BaseMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { AgentInput } from '../types.js';

type ImageResolver = (imageIds: string[]) => Promise<string[]>;

/**
 * Build the LangChain message array an agent feeds to its LLM.
 *
 * - Stitches the system prompt with optional tenant constraints.
 * - Maps history to LangChain message types: assistant → AIMessage, others → HumanMessage.
 * - When imageResolver is provided and a message has imageIds, injects image_url content blocks
 *   so vision-capable models can see the uploaded images.
 */
export async function buildAgentMessages(
  systemPrompt: string,
  history: AgentInput['messages'],
  constraints?: readonly string[],
  imageResolver?: ImageResolver,
): Promise<BaseMessage[]> {
  const system =
    constraints && constraints.length > 0
      ? `${systemPrompt}\n\nTenant constraints:\n- ${constraints.join('\n- ')}`
      : systemPrompt;

  const historyMessages = await Promise.all(
    history.map(async (m) => {
      const hasImages = imageResolver && m.imageIds && m.imageIds.length > 0;
      if (m.role === 'assistant') return new AIMessage(m.content);
      if (!hasImages) return new HumanMessage(m.content);

      const urls = await imageResolver!(m.imageIds!);
      const content: { type: string; image_url?: { url: string }; text?: string }[] = [
        ...urls.map((url) => ({ type: 'image_url', image_url: { url } })),
        { type: 'text', text: m.content },
      ];
      return new HumanMessage({ content });
    }),
  );

  return [new SystemMessage(system), ...historyMessages];
}
