import { z } from 'zod';
import { SHOPIFY_TOOL_IDS, buildShopifyTools } from '../../../integrations/shopify/tools.js';
import type {
  AgentBuildContext,
  AgentInput,
  AgentOutput,
  AgentRunnable,
  IAgent,
} from '../../types.js';
import type { ProductContent } from '../product-strategist/content.js';

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

      await ctx.emitLog('agent.started', content.progressNote, {
        title: content.title,
        imageCount: content.imageUrls.length,
      });

      const pendingToolCall = {
        id: 'shopify.create_product',
        args: {
          title: content.title,
          bodyHtml: content.bodyHtml,
          tags: content.tags,
          vendor: content.vendor,
          ...(content.productType ? { productType: content.productType } : {}),
          ...(content.imageUrls.length > 0
            ? { images: content.imageUrls.map((url) => ({ url })) }
            : {}),
        },
      };

      return {
        message: renderProductPreview(content, cfg.shopify.autoPublish),
        awaitingApproval: true,
        payload: { content },
        pendingToolCall,
      };
    };

    return { tools: filtered, invoke };
  },
};

function renderProductPreview(content: ProductContent, autoPublish: boolean): string {
  return [
    `# ${content.title}`,
    '',
    `**Vendor:** ${content.vendor}${content.productType ? ` · **Type:** ${content.productType}` : ''}`,
    `**Tags:** ${content.tags.join(', ')}`,
    `**Language:** ${content.language}`,
    content.imageUrls.length > 0
      ? `**Images:** ${content.imageUrls.length} 張已備妥`
      : '**Images:** 無',
    `**On approve:** create product as \`${autoPublish ? 'active' : 'draft'}\` in Shopify`,
    '',
    '---',
    '',
    content.bodyHtml,
    '',
    '_Approve to push to Shopify; Discard to abandon._',
  ].join('\n');
}
