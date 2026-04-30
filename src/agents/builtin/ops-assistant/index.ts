import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { SHOPIFY_TOOL_IDS, buildShopifyTools } from '../../../integrations/shopify/tools.js';
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

/**
 * User-facing activation config. The frontend renders this as a form (via
 * zod-to-json-schema → JSON Schema) when the tenant "hires" this agent.
 */
const configSchema = z.object({
  shopify: z
    .object({
      credentialLabel: z
        .string()
        .optional()
        .describe('Which Shopify connection to use when multiple are bound'),
      defaultVendor: z
        .string()
        .optional()
        .describe('Vendor name applied when the AI does not infer one'),
      autoPublish: z
        .boolean()
        .default(false)
        .describe('If true, products are created as Active; otherwise Draft'),
    })
    .default({}),
  defaultLanguage: z
    .enum(['zh-TW', 'en', 'ja'])
    .default('zh-TW')
    .describe('Primary language used in product listings'),
});

type OpsConfig = z.infer<typeof configSchema>;

export const opsAssistantAgent: IAgent = {
  manifest: {
    id: 'ops-assistant',
    name: 'AI Ops Assistant',
    description: 'Prepares product listings and pushes them to Shopify.',
    availableInPlans: ['basic', 'pro', 'flagship'],
    // Sonnet is fast + cheap + strong at structured output — well-suited to
    // turning a brief into a tidy product listing.
    defaultModel: { model: 'anthropic/claude-sonnet-4.6', temperature: 0.2 },
    defaultPrompt: DEFAULT_PROMPT,

    toolIds: SHOPIFY_TOOL_IDS,

    requiredCredentials: [
      {
        provider: 'shopify',
        description: 'Shopify Admin API token + store URL — needed to create products',
        setupUrl: 'https://help.shopify.com/en/manual/apps/app-types/custom-apps',
      },
    ],

    configSchema,
  },

  async build(ctx: AgentBuildContext): Promise<AgentRunnable> {
    const cfg = configSchema.parse(ctx.agentConfig ?? {}) as OpsConfig;
    const model = buildModel(ctx.modelConfig);
    const tools = await buildShopifyTools(ctx.tenantId, {
      ...(cfg.shopify.credentialLabel ? { credentialLabel: cfg.shopify.credentialLabel } : {}),
      ...(cfg.shopify.defaultVendor ? { defaultVendor: cfg.shopify.defaultVendor } : {}),
      autoPublish: cfg.shopify.autoPublish,
    });

    const filteredTools = ctx.toolWhitelist
      ? tools.filter((t) => ctx.toolWhitelist?.includes(t.id))
      : tools;

    const invoke = async (input: AgentInput): Promise<AgentOutput> => {
      await ctx.emitLog('agent.started', `Ops Assistant starting on task ${ctx.taskId}`, {
        language: cfg.defaultLanguage,
        autoPublish: cfg.shopify.autoPublish,
      });

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
        payload: { listing: text, language: cfg.defaultLanguage },
      };
    };

    return { tools: filteredTools, invoke };
  },
};
