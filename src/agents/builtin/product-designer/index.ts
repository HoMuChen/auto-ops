import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { buildTenantImageTools } from '../../../integrations/openai-images/build-tenant-image-tools.js';
import { buildAgentMessages } from '../../lib/messages.js';
import { loadPacks } from '../../lib/packs.js';
import { skillsToggleSchema } from '../../lib/skills-schema.js';
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
- progressNote is one short sentence for the kanban timeline.
- keyDecisions is 3-5 short bullets the report-writer can lean on when generating
  the boss-facing memo. These are NOT boss-facing prose themselves — keep them
  short and concrete (e.g. "從 brief 推斷 Acme 為品牌", "主圖白底突出布料").
- Do NOT write a boss memo as part of your output. The shared report-writer
  node renders the boss-facing prose from your structured fields at the HITL
  boundary — your job is to produce the deliverable (title/body/tags/etc.) and
  the keyDecisions hints; the rendering is downstream.`;

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
  // Optional UI hint — `.catch(null)` so model sloppiness on this metadata
  // field doesn't reject the whole submission. See lenient-schemas.ts.
  productType: z.string().nullish().catch(null),
  keyDecisions: z
    .array(z.string().min(5))
    .min(1)
    .max(5)
    .describe(
      '3-5 short bullets the downstream report-writer can lean on when generating boss prose. ' +
        'Examples: "機能透氣切台灣通勤實戰", "從 brief 推斷 Acme 為品牌", "主圖白底突出布料". ' +
        'Be concrete about copy angle, vendor inference, and image choices. Not boss-facing prose itself.',
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
  skills: skillsToggleSchema,
});

type ProductDesignerConfig = z.infer<typeof configSchema>;

export const productDesignerAgent: IAgent = {
  manifest: {
    id: 'product-designer',
    name: '產品設計師',
    description:
      '依產品企劃師產出的 markdown brief 生成產品圖片與文案，' +
      '再派發發布員 agent 上架到已啟用的平台。',
    defaultModel: { model: 'anthropic/claude-sonnet-4.6', temperature: 0.3 },
    defaultPrompt: DEFAULT_PROMPT,
    toolIds: ['images.generate', 'images.edit'],
    requiredCredentials: [],
    configSchema,
    metadata: { kind: 'execution', shape: 'atomic' },
  },

  async build(ctx: AgentBuildContext): Promise<AgentRunnable> {
    const cfg = configSchema.parse(ctx.agentConfig ?? {}) as ProductDesignerConfig;

    const publishers = ctx.availableExecutionAgents.filter((a) => a.metadata?.kind === 'publisher');

    const packsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'packs');
    const packsBlock = await loadPacks({
      builtInDir: packsDir,
      builtInEnabled: cfg.skills,
      tenantId: ctx.tenantId,
      agentId: 'product-designer',
    });

    const imageTools = buildTenantImageTools({
      tenantId: ctx.tenantId,
      taskId: ctx.taskId,
      styleSuffix: ctx.tenantProfile.imageStyleSuffix || undefined,
      enableEdit: true,
    });

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

      // Single pass: image generation (optional) + structured copy via the
      // submit_listing tool. Same finalAnswer pattern as seo-strategist;
      // model can call image tools any number of times then submit. If
      // imageTools is empty (no Cloudflare config), the loop runs with just
      // the submit tool — model goes straight to copy.
      const result = await runToolLoop({
        modelConfig: ctx.modelConfig,
        messages: baseMessages,
        tools: imageTools,
        maxHops: 6,
        emitLog: ctx.emitLog,
        logCtx: ctx.logCtx,
        finalAnswer: {
          schema: ProductListingSchema,
          name: 'submit_listing',
          description:
            'Call this exactly once when ready. The args ARE the final product listing copy that will be shown to the user for approval.',
          // Images are optional — feedback rounds may keep the existing imageUrls.
          minToolHops: 0,
        },
      });

      if (result.kind !== 'submitted') {
        throw new Error(
          'Product designer did not submit a listing within the tool loop budget — model emitted free-form content without calling submit_listing.',
        );
      }
      const listing = result.value;

      const toolGeneratedUrls = result.calls
        .map((c) => (c.result as { url?: string }).url)
        .filter((u): u is string => Boolean(u));

      if (toolGeneratedUrls.length > 0) {
        imageUrls.length = 0;
        imageUrls.push(...toolGeneratedUrls);
      }
      // If no tools called: imageUrls retains previousImageUrls (copy-only feedback).

      const refsOut: ProductContent['refs'] = {
        title: listing.title,
        tags: listing.tags,
        vendor: listing.vendor,
        ...(listing.productType ? { productType: listing.productType } : {}),
        language: inputLanguage,
        imageUrls,
      };

      // Image markdown is appended only to `artifact.body` (boss-facing
      // display); `content.body` stays image-free so the publisher's
      // markdown→HTML conversion doesn't double-include images — Shopify
      // takes them via the `images[]` field, not inline in body_html.
      const imageMarkdown =
        imageUrls.length > 0
          ? `\n\n## 生成的圖片\n\n${imageUrls.map((url, i) => `![圖 ${i + 1}](${url})`).join('\n\n')}`
          : '';
      const bodyWithImages = `${listing.body}${imageMarkdown}`;

      // ProductContent carries machine-readable fields only. The publisher
      // rebuilds bodyWithImages locally for its own artifact.body display,
      // and emits its own structuredOutput so report-writer fills its
      // artifact.report — designer no longer pre-renders any of it.
      const content: ProductContent = {
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
        artifactShape: 'body+structuredOutput',
        title: listing.title,
        imageCount: imageUrls.length,
        publisherCount: spawnTasks.length,
      });

      // NOTE: artifact.report intentionally absent — the shared report-writer
      // node fills it from state.lastStructuredOutput at the HITL boundary.
      return {
        message: listing.progressNote,
        awaitingApproval: true,
        artifact: {
          body: bodyWithImages,
          refs: refsOut,
        },
        payload: { content },
        spawnTasks,
        structuredOutput: {
          schemaName: 'product-listing',
          data: {
            title: listing.title,
            body: listing.body,
            tags: listing.tags,
            vendor: listing.vendor,
            ...(listing.productType ? { productType: listing.productType } : {}),
            language: inputLanguage,
            imageUrls,
          },
          keyDecisions: listing.keyDecisions,
        },
      };
    };

    return { tools: imageTools, invoke };
  },
};
