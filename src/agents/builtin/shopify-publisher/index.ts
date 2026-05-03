import { z } from 'zod';
import { SHOPIFY_TOOL_IDS, buildShopifyTools } from '../../../integrations/shopify/tools.js';
import { markdownToHtml } from '../../lib/markdown.js';
import type {
  AgentBuildContext,
  AgentInput,
  AgentOutput,
  AgentRunnable,
  IAgent,
} from '../../types.js';
import type { ProductContent } from './content.js';

const configSchema = z.object({
  shopify: z
    .object({
      credentialLabel: z.string().nullish(),
      autoPublish: z.boolean().default(false),
    })
    .default({}),
});

type ShopifyPublisherConfig = z.infer<typeof configSchema>;

export const shopifyPublisherAgent: IAgent = {
  manifest: {
    id: 'shopify-publisher',
    name: 'Shopify Product Publisher',
    description:
      'Publishes a ready-made ProductContent package to the tenant Shopify store. ' +
      'Expects task.input.params.content to be a ProductContent object.',
    defaultModel: { model: 'anthropic/claude-sonnet-4.6', temperature: 0 },
    defaultPrompt: '',
    toolIds: SHOPIFY_TOOL_IDS,
    requiredCredentials: [
      {
        provider: 'shopify',
        description: 'Shopify Admin API token + store URL — needed to create products',
        setupUrl: 'https://help.shopify.com/en/manual/apps/app-types/custom-apps',
      },
    ],
    configSchema,
    metadata: { kind: 'publisher' },
  },

  async build(ctx: AgentBuildContext): Promise<AgentRunnable> {
    const cfg = configSchema.parse(ctx.agentConfig ?? {}) as ShopifyPublisherConfig;
    const tools = await buildShopifyTools(ctx.tenantId, {
      ...(cfg.shopify.credentialLabel ? { credentialLabel: cfg.shopify.credentialLabel } : {}),
      autoPublish: cfg.shopify.autoPublish,
    });
    const filtered = tools.filter((t) => t.id === 'shopify.create_product');

    const invoke = async (input: AgentInput): Promise<AgentOutput> => {
      const content = input.params.content as ProductContent;
      const { title, tags, vendor, productType, imageUrls } = content.refs;
      const bodyHtml = markdownToHtml(content.body);

      await ctx.emitLog('agent.started', content.progressNote, {
        title,
        imageCount: imageUrls.length,
      });

      const pendingToolCall = {
        id: 'shopify.create_product',
        args: {
          title,
          bodyHtml,
          tags,
          vendor,
          ...(productType ? { productType } : {}),
          ...(imageUrls.length > 0 ? { images: imageUrls.map((url) => ({ url })) } : {}),
        },
      };

      return {
        message: content.progressNote,
        awaitingApproval: true,
        artifact: {
          report: content.report,
          body: content.body,
          refs: { ...content.refs, ready: true },
        },
        payload: { content },
        pendingToolCall,
      };
    };

    return { tools: filtered, invoke };
  },
};
