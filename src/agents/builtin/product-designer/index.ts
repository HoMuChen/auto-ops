import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HumanMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { env } from '../../../config/env.js';
import { CloudflareImagesClient } from '../../../integrations/cloudflare/images-client.js';
import { getImageById, insertImage } from '../../../integrations/cloudflare/images-repository.js';
import { OpenAIImagesClient } from '../../../integrations/openai-images/client.js';
import { buildImageTools } from '../../../integrations/openai-images/tools.js';
import { invokeStructured } from '../../lib/invoke-structured.js';
import { buildAgentMessages } from '../../lib/messages.js';
import { loadPacks } from '../../lib/packs.js';
import { runToolLoop } from '../../lib/tool-loop.js';
import type {
  AgentBuildContext,
  AgentInput,
  AgentOutput,
  AgentRunnable,
  IAgent,
  SpawnTaskRequest,
} from '../../types.js';
import type { ProductContent } from '../shopify-publisher/content.js';

const DEFAULT_PROMPT = `You are a Product Designer AI employee for an e-commerce business.
You receive a markdown brief from the Product Planner and produce:
1. Images — call images.generate or images.edit based on the image plan in the
   brief and any user feedback.
2. Copy — title, markdown product description (\`body\`), tags, vendor — tailored
   to the variant's platform and audience as described in the brief.

Image generation rules:
- The brief lists required and optional shots with purpose and style hints.
- Your packs provide the correct aspect ratios and composition principles per
  shot type and platform.
- On first run: generate all "required" shots; generate "optional" if the brief
  supports it.
- On feedback: if the user wants image changes, call images.edit with the
  previously generated URL (listed in "Previously generated images") or
  images.generate for new angles.
- If user feedback is copy-only, do NOT call any image tools.

Copy rules:
- body must be valid Markdown. Use ## / ### subheads, **bold**, - bullets,
  > blockquote. Do NOT emit raw HTML; the publisher converts to HTML at the
  Shopify Admin API boundary.
- Honor the variant's tone, key messages, and features-to-highlight from the
  brief.
- Use the variant's language (from refs or inferred from the brief) for all copy.
- Tags: 3–8 short lower-case keywords.

After tool calls (or if no tools needed), produce the structured listing object.
- progressNote is one short sentence for the kanban timeline. report is the
  full memo for the boss-review panel. Don't duplicate them.`;

const ProductListingSchema = z.object({
  title: z.string().min(1).max(255),
  body: z
    .string()
    .min(20)
    .describe(
      'Product description body in Markdown. Use <h3>-equivalent ## / ### subheads, ' +
        '**bold**, *italic*, - bullets, > blockquote. Do NOT emit raw HTML — the publisher ' +
        'converts to HTML at the Shopify Admin API boundary.',
    ),
  tags: z.array(z.string().min(1)).min(1).max(20),
  vendor: z.string().min(1),
  productType: z.string().nullish(),
  report: z
    .string()
    .min(80)
    .max(4000)
    .describe(
      '給老闆看的詳細匯報。**用 zh-TW 繁體中文** + Markdown 格式。' +
        '說明：你怎麼解讀 brief、文案的切角是什麼、為什麼選這幾張圖、' +
        '特別考量的地方（受眾、平台、語言、素材限制）。' +
        '可用 ## / ### 子標題、**粗體**、- 條列、表格。' +
        '老闆靠這段決定 Approve / Feedback，要詳實但不要重複 body 的內容。' +
        '長度建議 200–800 字。' +
        '注意：圖片會由 agent code 在你的 report 後面附上 markdown image syntax，' +
        '所以你的 report 不需要插入 ![](url)。',
    ),
  progressNote: z
    .string()
    .min(10)
    .max(200)
    .describe('一句話對老闆回報剛完成什麼。用 zh-TW 第一人稱，對話對象是「老闆」。'),
});

const configSchema = z.object({
  defaultVendor: z.string().nullish(),
  defaultLanguage: z.enum(['zh-TW', 'zh-CN', 'en', 'ja', 'ko']).default('zh-TW'),
  skills: z
    .object({
      productPhotography: z.boolean().default(true),
      socialMediaImages: z.boolean().default(true),
    })
    .default({}),
});

type ProductDesignerConfig = z.infer<typeof configSchema>;

export const productDesignerAgent: IAgent = {
  manifest: {
    id: 'product-designer',
    name: 'Product Designer',
    description:
      'Generates product images and copy from a markdown brief produced by the Product Planner, ' +
      'then spawns publisher agents to distribute to enabled platforms.',
    defaultModel: { model: 'anthropic/claude-sonnet-4.6', temperature: 0.3 },
    defaultPrompt: DEFAULT_PROMPT,
    toolIds: ['images.generate', 'images.edit'],
    requiredCredentials: [],
    configSchema,
  },

  async build(ctx: AgentBuildContext): Promise<AgentRunnable> {
    const cfg = configSchema.parse(ctx.agentConfig ?? {}) as ProductDesignerConfig;

    const publishers = ctx.availableExecutionAgents.filter((a) => a.metadata?.kind === 'publisher');

    const packsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'packs');
    const packsBlock = await loadPacks(packsDir, cfg.skills as Record<string, boolean>);

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
          'no publisher agent available — product-designer requires at least one agent ' +
            'with metadata.kind=publisher to be enabled for the tenant.',
        );
      }

      // NOTE: input.messages[0] carries the markdown brief — runner.ts seeds it from
      // task.input.brief on first invocation. We deliberately do NOT read params.brief
      // here; the LLM consumes the brief through the conversation thread, and only
      // machine-actionable fields (language, originalImageIds) live on params.refs.
      const refs = (input.params as { refs?: { language?: string; originalImageIds?: string[] } })
        .refs;
      const inputLanguage = refs?.language ?? cfg.defaultLanguage;

      await ctx.emitLog('agent.started', '收到設計需求，開始畫圖跟寫文', {
        language: inputLanguage,
        publishers: publishers.map((p) => p.id),
      });

      const previousImageUrls =
        (input.taskOutput?.payload as { content?: { refs?: { imageUrls?: string[] } } } | undefined)
          ?.content?.refs?.imageUrls ?? [];
      const imageUrls: string[] = [...previousImageUrls];

      const originalImageIds = refs?.originalImageIds ?? [];

      const constraints: string[] = [
        `Variant language: ${inputLanguage}`,
        `Default vendor: ${cfg.defaultVendor ?? '(must infer from brief)'}`,
      ];

      if (previousImageUrls.length > 0) {
        constraints.push(
          `Previously generated images (pass to images.edit to modify): ${previousImageUrls.join(', ')}`,
        );
      }

      if (originalImageIds.length > 0 && input.imageResolver) {
        const referenceImageUrls = await input.imageResolver(originalImageIds);
        if (referenceImageUrls.length > 0) {
          constraints.push(
            `Original reference image(s) — use for style matching or as images.edit source: ${referenceImageUrls.join(', ')}`,
          );
        }
      }

      const systemPrompt = packsBlock ? `${packsBlock}\n\n${ctx.systemPrompt}` : ctx.systemPrompt;
      const baseMessages = await buildAgentMessages(
        systemPrompt,
        input.messages,
        constraints,
        input.imageResolver,
      );

      // Pass 1: image generation tool loop
      let collectedMessages = baseMessages;
      if (imageTools.length > 0) {
        const { collected, calls } = await runToolLoop({
          modelConfig: ctx.modelConfig,
          messages: baseMessages,
          tools: imageTools,
          maxHops: 4,
          emitLog: ctx.emitLog,
        });
        collectedMessages = collected;

        const toolGeneratedUrls = calls
          .map((c) => (c.result as { url?: string }).url)
          .filter((u): u is string => Boolean(u));

        if (toolGeneratedUrls.length > 0) {
          imageUrls.length = 0;
          imageUrls.push(...toolGeneratedUrls);
        }
        // If no tools called: imageUrls retains previousImageUrls (copy-only feedback)
      }

      // Pass 2: structured copy
      const listing = await invokeStructured(
        ctx.modelConfig,
        ProductListingSchema,
        'product_listing',
        [...collectedMessages, new HumanMessage('Now produce the structured product listing.')],
      );

      const refsOut: ProductContent['refs'] = {
        title: listing.title,
        tags: listing.tags,
        vendor: listing.vendor,
        ...(listing.productType ? { productType: listing.productType } : {}),
        language: inputLanguage,
        imageUrls,
      };

      // Append generated images to the report so the boss panel renders them inline.
      const imageMarkdown =
        imageUrls.length > 0
          ? `\n\n## 生成的圖片\n\n${imageUrls.map((url, i) => `![圖 ${i + 1}](${url})`).join('\n\n')}`
          : '';
      const reportWithImages = `${listing.report}${imageMarkdown}`;

      const content: ProductContent = {
        report: reportWithImages,
        body: listing.body,
        refs: refsOut,
        progressNote: listing.progressNote,
      };

      const spawnTasks: SpawnTaskRequest[] = publishers.map((p) => ({
        title: `${listing.title} → ${p.name}`,
        assignedAgent: p.id,
        input: { content },
      }));

      await ctx.emitLog('agent.content.ready', listing.progressNote, {
        artifactShape: 'report+body',
        title: listing.title,
        imageCount: imageUrls.length,
        publisherCount: spawnTasks.length,
      });

      return {
        message: listing.progressNote,
        awaitingApproval: true,
        artifact: {
          report: reportWithImages,
          body: listing.body,
          refs: refsOut,
        },
        payload: { content },
        spawnTasks,
      };
    };

    return { tools: imageTools, invoke };
  },
};
