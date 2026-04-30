import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { buildShopifyTools } from '../../../integrations/shopify/tools.js';
import { buildModel } from '../../../llm/model-registry.js';
import type {
  AgentBuildContext,
  AgentInput,
  AgentOutput,
  AgentRunnable,
  IAgent,
} from '../../types.js';

const DEFAULT_PROMPT = `You are an Operations Assistant for a Shopify store.
Your job: prepare product listings (title, description, specs, tags) and call the
Shopify Admin API to create or update them. Always:
- Surface a structured listing for human approval BEFORE calling any write tool.
- Never invent SKUs, prices, or stock counts; use what the user provides.
- After approval, call shopify.create_product or shopify.update_product as needed.`;

export const opsAssistantAgent: IAgent = {
  manifest: {
    id: 'ops-assistant',
    name: 'AI Ops Assistant',
    description: 'Prepares product listings and pushes them to Shopify.',
    availableInPlans: ['basic', 'pro', 'flagship'],
    defaultModel: { provider: 'anthropic', model: 'claude-opus-4-7', temperature: 0.2 },
    defaultPrompt: DEFAULT_PROMPT,
  },

  async build(ctx: AgentBuildContext): Promise<AgentRunnable> {
    const model = buildModel(ctx.modelConfig);
    const tools = await buildShopifyTools(ctx.tenantId);

    const filteredTools = ctx.toolWhitelist
      ? tools.filter((t) => ctx.toolWhitelist?.includes(t.id))
      : tools;

    const invoke = async (input: AgentInput): Promise<AgentOutput> => {
      await ctx.emitLog('agent.started', `Ops Assistant starting on task ${ctx.taskId}`);

      const messages = [
        new SystemMessage(ctx.systemPrompt),
        ...input.messages.map((m) =>
          m.role === 'user' ? new HumanMessage(m.content) : new HumanMessage(m.content),
        ),
      ];

      // MVP: produce the listing draft and request approval. Tool execution
      // happens in a separate step after the user approves the Waiting gate.
      const response = await model.invoke(messages);
      const text =
        typeof response.content === 'string' ? response.content : JSON.stringify(response.content);

      await ctx.emitLog('agent.listing.ready', 'Product listing prepared, awaiting approval', {
        toolsAvailable: filteredTools.map((t) => t.id),
      });

      return {
        message: text,
        awaitingApproval: true,
        payload: { listing: text },
      };
    };

    return { tools: filteredTools, invoke };
  },
};
