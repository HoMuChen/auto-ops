import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HumanMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { env } from '../../../config/env.js';
import { CloudflareImagesClient } from '../../../integrations/cloudflare/images-client.js';
import { getImageById, insertImage } from '../../../integrations/cloudflare/images-repository.js';
import { OpenAIImagesClient } from '../../../integrations/openai-images/client.js';
import { buildImageTools } from '../../../integrations/openai-images/tools.js';
import { buildModel } from '../../../llm/model-registry.js';
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
You receive a variant spec from the Product Planner and produce:
1. Images — call images.generate or images.edit based on the imagePlan and any user feedback.
2. Copy — title, HTML description, tags, vendor — tailored to the variant's platform and audience.

Image generation rules:
- The imagePlan lists required and optional shots with purpose and style hints.
- Your packs provide the correct aspect ratios and composition principles per shot type and platform.
- On first run: generate all "required" shots; generate "optional" if the brief supports it.
- On feedback: if user wants image changes, call images.edit with the previously generated URL
  (listed in "Previously generated images") or images.generate for new angles.
- If user feedback is copy-only, do NOT call any image tools.

Copy rules:
- bodyHtml must be safe, well-formed HTML (<p>, <ul>/<li>, <h3>; no <script>/<style>).
- Honor the variant's tone, keyMessages, and featuresToHighlight.
- Use the variant's language for all copy.
- Tags: 3–8 short lower-case keywords.

After tool calls (or if no tools needed), produce the structured listing object.`;

const ProductListingSchema = z.object({
  title: z.string().min(1).max(255),
  bodyHtml: z.string().min(1),
  tags: z.array(z.string().min(1)).min(1).max(20),
  vendor: z.string().min(1),
  productType: z.string().optional(),
  progressNote: z
    .string()
    .min(10)
    .max(200)
    .describe('一句話對老闆回報剛完成什麼。用 zh-TW 第一人稱，對話對象是「老闆」。'),
});

type ProductListing = z.infer<typeof ProductListingSchema>;

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
    name: 'AI Product Designer',
    description:
      'Generates product images and copy from a variant spec produced by the Product Planner, ' +
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

      const variantSpec = input.params.variantSpec as {
        platform?: string;
        language: string;
        marketingAngle: string;
        keyMessages: string[];
        copyBrief: { tone: string; featuresToHighlight: string[]; forbiddenClaims?: string[] };
        imagePlan: { purpose: string; styleHint: string; priority: string }[];
      };

      await ctx.emitLog('agent.started', '收到設計需求，開始畫圖跟寫文', {
        platform: variantSpec?.platform,
        publishers: publishers.map((p) => p.id),
      });

      // imageUrls state management across feedback rounds
      const previousImageUrls =
        (input.taskOutput?.payload as { content?: { imageUrls?: string[] } } | undefined)?.content
          ?.imageUrls ?? [];

      const imageUrls: string[] = [...previousImageUrls];

      const originalImageIds =
        (input.params as { originalImageIds?: string[] }).originalImageIds ?? [];

      const constraints: string[] = [
        `Variant language: ${variantSpec?.language ?? cfg.defaultLanguage}`,
        `Default vendor: ${cfg.defaultVendor ?? '(must infer from brief)'}`,
      ];

      if (variantSpec?.imagePlan) {
        constraints.push(
          `Image plan:\n${variantSpec.imagePlan
            .map((s) => `- [${s.priority}] ${s.purpose}: ${s.styleHint}`)
            .join('\n')}`,
        );
      }
      if (variantSpec?.copyBrief) {
        constraints.push(`Tone: ${variantSpec.copyBrief.tone}`);
        constraints.push(
          `Features to highlight: ${variantSpec.copyBrief.featuresToHighlight.join(', ')}`,
        );
        if (variantSpec.copyBrief.forbiddenClaims?.length) {
          constraints.push(`Forbidden claims: ${variantSpec.copyBrief.forbiddenClaims.join(', ')}`);
        }
      }
      if (variantSpec?.keyMessages?.length) {
        constraints.push(`Key messages: ${variantSpec.keyMessages.join(' / ')}`);
      }
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
      const listingModel = buildModel(ctx.modelConfig).withStructuredOutput(ProductListingSchema, {
        name: 'product_listing',
      });
      const listing = (await listingModel.invoke([
        ...collectedMessages,
        new HumanMessage('Now produce the structured product listing.'),
      ])) as ProductListing;

      const content: ProductContent = {
        title: listing.title,
        bodyHtml: listing.bodyHtml,
        tags: listing.tags,
        vendor: listing.vendor,
        productType: listing.productType,
        language: variantSpec?.language ?? cfg.defaultLanguage,
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
        `**Vendor:** ${listing.vendor}　**Tags:** ${listing.tags.join(', ')}`,
        ...(variantSpec?.platform ? [`**Platform:** ${variantSpec.platform}`] : []),
        '',
        ...(imageBlock ? [imageBlock, ''] : []),
        `_準備送審上架 → ${publishers.map((p) => p.name).join(', ')}_`,
        '',
        '---',
        '',
        '```html',
        listing.bodyHtml,
        '```',
      ].join('\n');

      await ctx.emitLog('agent.content.ready', listing.progressNote, {
        title: listing.title,
        imageCount: imageUrls.length,
        publisherCount: spawnTasks.length,
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
