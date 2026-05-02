import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { env } from '../../../config/env.js';
import { CloudflareImagesClient } from '../../../integrations/cloudflare/images-client.js';
import { getImageById, insertImage } from '../../../integrations/cloudflare/images-repository.js';
import { OpenAIImagesClient } from '../../../integrations/openai-images/client.js';
import { buildImageTools } from '../../../integrations/openai-images/tools.js';
import { buildModel } from '../../../llm/model-registry.js';
import { buildAgentMessages } from '../../lib/messages.js';
import { loadPacks } from '../../lib/packs.js';
import type {
  AgentBuildContext,
  AgentInput,
  AgentOutput,
  AgentRunnable,
  IAgent,
  SpawnTaskRequest,
} from '../../types.js';
import type { ProductContent } from './content.js';

const DEFAULT_PROMPT = `You are a Product Content Specialist AI employee for an e-commerce business.
Your job: read a product brief and produce polished, platform-agnostic product content —
title, HTML description, tags, vendor — ready for the human to review.

You do NOT publish the product yourself. After approval, the framework will hand your
content to the appropriate platform publisher.

Hard rules:
- Never invent SKUs, prices, or stock counts; mention only what the brief includes.
- bodyHtml must be safe, well-formed HTML (<p>, <ul>/<li>, <h3>; no <script>/<style>).
- Tags: 3–8 short lower-case keywords.
- Default vendor and language come from the agent config; honour them unless the brief overrides.
- Use the tenant's default language for all copy.

Return strictly the structured object requested.`;

const configSchema = z.object({
  defaultLanguage: z
    .enum(['zh-TW', 'en', 'ja'])
    .default('zh-TW')
    .describe('Primary language for product copy'),
  defaultVendor: z.string().nullish().describe('Default vendor name'),
  images: z
    .object({
      autoGenerate: z
        .boolean()
        .default(true)
        .describe('Generate product images when none are uploaded'),
      style: z
        .string()
        .nullish()
        .describe('Image style hint, e.g. "clean white background, product photography"'),
    })
    .default({}),
  skills: z.object({ seoFundamentals: z.boolean().default(true) }).default({}),
});

type ProductStrategistConfig = z.infer<typeof configSchema>;

const ProductListingSchema = z.object({
  title: z.string().min(1).max(255).describe('Product title.'),
  bodyHtml: z.string().min(1).describe('Product description as HTML.'),
  tags: z.array(z.string().min(1)).min(1).max(20).describe('3–8 keyword tags.'),
  vendor: z.string().min(1).describe('Brand/vendor name.'),
  productType: z.string().optional().describe('Product category — leave blank if unsure.'),
  summary: z
    .string()
    .min(20)
    .max(500)
    .describe(
      '給老闆看的匯報摘要。說明你做了什麼、參考了什麼素材或資料、有什麼特別考量的地方。' +
        '老闆靠這段文字決定要不要 Approve，所以要夠詳細但不冗長。' +
        '用 zh-TW，語氣像員工向老闆口頭匯報，3–5 句話。',
    ),
  progressNote: z
    .string()
    .min(10)
    .max(200)
    .describe('一句話對老闆回報你剛完成什麼。用 zh-TW 第一人稱，對話對象是「老闆」。'),
});

type ProductListing = z.infer<typeof ProductListingSchema>;

export const productStrategistAgent: IAgent = {
  manifest: {
    id: 'product-strategist',
    name: 'AI Product Content Strategist',
    description:
      'Generates platform-agnostic product copy and images from a brief, ' +
      'then spawns publisher agents to distribute to enabled platforms.',
    defaultModel: { model: 'anthropic/claude-sonnet-4.6', temperature: 0.2 },
    defaultPrompt: DEFAULT_PROMPT,
    toolIds: ['images.generate', 'images.edit'],
    requiredCredentials: [],
    configSchema,
    metadata: { kind: 'strategy' },
  },

  async build(ctx: AgentBuildContext): Promise<AgentRunnable> {
    const cfg = configSchema.parse(ctx.agentConfig ?? {}) as ProductStrategistConfig;
    const model = buildModel(ctx.modelConfig).withStructuredOutput(ProductListingSchema, {
      name: 'product_listing',
    });

    const publishers = ctx.availableExecutionAgents.filter((a) => a.metadata?.kind === 'publisher');

    const packsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'packs');
    const packsBlock = await loadPacks(packsDir, cfg.skills);

    const accountId = env.CLOUDFLARE_ACCOUNT_ID;
    const r2AccessKey = env.CLOUDFLARE_R2_ACCESS_KEY_ID;
    const r2SecretKey = env.CLOUDFLARE_R2_SECRET_ACCESS_KEY;
    const r2Bucket = env.CLOUDFLARE_R2_BUCKET;
    const r2PublicBaseUrl = env.CLOUDFLARE_R2_PUBLIC_BASE_URL;
    const openaiKey = env.OPENAI_API_KEY;

    const r2Ready = accountId && r2AccessKey && r2SecretKey && r2Bucket && r2PublicBaseUrl;
    const imageTools =
      r2Ready && openaiKey
        ? buildImageTools(ctx.tenantId, {
            openaiClient: new OpenAIImagesClient({ apiKey: openaiKey }),
            cfClient: new CloudflareImagesClient({
              accountId,
              accessKeyId: r2AccessKey,
              secretAccessKey: r2SecretKey,
              bucket: r2Bucket,
              publicBaseUrl: r2PublicBaseUrl,
            }),
            insertImage,
            getImageById,
            fetchImageBuffer: async (url) => Buffer.from(await (await fetch(url)).arrayBuffer()),
            taskId: ctx.taskId,
          })
        : [];

    const invoke = async (input: AgentInput): Promise<AgentOutput> => {
      if (publishers.length === 0) {
        throw new Error(
          'no publisher agent available — product-strategist requires at least one agent ' +
            'with metadata.kind=publisher to be enabled for the tenant.',
        );
      }

      await ctx.emitLog('agent.started', '商品資料我來整理一下', {
        publishers: publishers.map((p) => p.id),
      });

      const systemPrompt = packsBlock ? `${packsBlock}\n\n${ctx.systemPrompt}` : ctx.systemPrompt;
      const constraints = [
        `Default vendor: ${cfg.defaultVendor ?? '(must infer from brief)'}`,
        `Default language: ${cfg.defaultLanguage}`,
      ];

      const messages = await buildAgentMessages(
        systemPrompt,
        input.messages,
        constraints,
        input.imageResolver,
      );
      const listing = (await model.invoke(messages)) as ProductListing;

      // Image handling in code — no LLM tool-calling needed.
      const imageUrls: string[] = [];
      const inputImageIds = (input.params as { imageIds?: string[] }).imageIds ?? [];

      if (inputImageIds.length > 0 && input.imageResolver) {
        imageUrls.push(...(await input.imageResolver(inputImageIds)));
      } else if (cfg.images.autoGenerate && imageTools.length > 0) {
        const genTool = imageTools.find((t) => t.id === 'images.generate');
        if (genTool) {
          const style = cfg.images.style ?? 'clean white background, product photography';
          const imgResult = (await genTool.tool.invoke({
            prompt: `${listing.title}. ${style}`,
          })) as { id: string; url: string };
          imageUrls.push(imgResult.url);
        }
      }

      const content: ProductContent = {
        title: listing.title,
        bodyHtml: listing.bodyHtml,
        tags: listing.tags,
        vendor: listing.vendor,
        productType: listing.productType,
        language: cfg.defaultLanguage,
        imageUrls,
        progressNote: listing.progressNote,
      };

      const spawnTasks: SpawnTaskRequest[] = publishers.map((p) => ({
        title: `${listing.title} → ${p.name}`,
        assignedAgent: p.id,
        input: { content },
      }));

      const imageBlock = imageUrls.map((url) => `![商品圖片](${url})`).join('\n');

      const message = [
        `# ${listing.title}`,
        '',
        listing.summary ??
          `**Vendor:** ${listing.vendor}　**Tags:** ${listing.tags.join(', ')}`,
        '',
        ...(imageBlock ? [imageBlock, ''] : []),
        `_準備送審上架 → ${publishers.map((p) => p.name).join(', ')}_`,
        '',
        '---',
        '',
        listing.bodyHtml,
      ].join('\n');

      await ctx.emitLog('agent.content.ready', listing.progressNote, {
        title: listing.title,
        publisherCount: spawnTasks.length,
        imageCount: imageUrls.length,
      });

      return {
        message,
        awaitingApproval: true,
        payload: { content },
        spawnTasks,
      };
    };

    return { tools: imageTools, invoke };
  },
};
