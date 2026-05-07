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
    name: 'Shopify 商品發布員',
    description:
      '把現成的 ProductContent 包上架到租戶的 Shopify 商店；' +
      '預期 task.input.params.content 為 ProductContent 物件。',
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
    metadata: { kind: 'publisher', shape: 'atomic' },
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
      const { title, tags, vendor, productType, language, imageUrls } = content.refs;
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

      // Image markdown for boss-facing display only — Shopify gets images via
      // the `images[]` field, not inline in body_html. Same shape as the
      // designer's bodyWithImages; inlined here rather than shared because the
      // logic is 3 lines and only used in two callsites (PR7 plan §"Architecture").
      const imageMarkdown =
        imageUrls.length > 0
          ? `\n\n## 生成的圖片\n\n${imageUrls.map((url, i) => `![圖 ${i + 1}](${url})`).join('\n\n')}`
          : '';
      const bodyWithImages = `${content.body}${imageMarkdown}`;

      // NOTE: artifact.report intentionally absent — the shared report-writer
      // node fills it from state.lastStructuredOutput at the HITL boundary.
      return {
        message: content.progressNote,
        awaitingApproval: true,
        artifact: {
          body: bodyWithImages,
          refs: { ...content.refs, ready: true },
        },
        payload: { content },
        pendingToolCall,
        structuredOutput: {
          schemaName: 'shopify-publish-intent',
          data: {
            title,
            vendor,
            tags,
            language,
            ...(productType ? { productType } : {}),
            imageCount: imageUrls.length,
            imageUrls,
          },
          // Deterministic — no LLM call. Three concrete bullets the
          // report-writer leans on to render boss prose.
          keyDecisions: [
            `準備上架「${title}」到 Shopify (${language})`,
            `品牌 ${vendor}${productType ? ` / ${productType}` : ''}`,
            `${tags.length} 個標籤、${imageUrls.length} 張圖片`,
          ],
        },
      };
    };

    return { tools: filtered, invoke };
  },
};
