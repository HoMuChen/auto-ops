import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { buildModel } from '../../../llm/model-registry.js';
import type {
  AgentBuildContext,
  AgentInput,
  AgentOutput,
  AgentRunnable,
  IAgent,
} from '../../types.js';

const DEFAULT_PROMPT = `You are an SEO Expert AI employee for an e-commerce business.
Your job: produce multilingual blog articles, product copy, and keyword strategies
that align with the tenant's brand voice. Always:
- Output structured Markdown with clear H1/H2 hierarchy.
- Include a meta_title (<= 60 chars) and meta_description (<= 155 chars).
- Honor any tone/keyword/forbidden constraints in the brief.
When you finish a draft, return it and request approval — never auto-publish.`;

export const seoExpertAgent: IAgent = {
  manifest: {
    id: 'seo-expert',
    name: 'AI SEO Expert',
    description: 'Researches keywords and writes multilingual SEO content.',
    availableInPlans: ['basic', 'pro', 'flagship'],
    defaultModel: { provider: 'anthropic', model: 'claude-opus-4-7', temperature: 0.4 },
    defaultPrompt: DEFAULT_PROMPT,
  },

  build(ctx: AgentBuildContext): AgentRunnable {
    const model = buildModel(ctx.modelConfig);

    const invoke = async (input: AgentInput): Promise<AgentOutput> => {
      await ctx.emitLog('agent.started', `SEO Expert starting on task ${ctx.taskId}`);

      const messages = [
        new SystemMessage(ctx.systemPrompt),
        ...input.messages.map((m) =>
          m.role === 'user' ? new HumanMessage(m.content) : new HumanMessage(m.content),
        ),
      ];

      const response = await model.invoke(messages);
      const text =
        typeof response.content === 'string' ? response.content : JSON.stringify(response.content);

      await ctx.emitLog('agent.draft.ready', 'SEO draft ready, awaiting approval', {
        length: text.length,
      });

      return {
        message: text,
        awaitingApproval: true,
        payload: { draft: text },
      };
    };

    return { tools: [], invoke };
  },
};
