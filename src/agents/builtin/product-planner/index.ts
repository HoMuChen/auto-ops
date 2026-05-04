import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { env } from '../../../config/env.js';
import { SerpCache } from '../../../integrations/serper/cache.js';
import { SerperClient } from '../../../integrations/serper/client.js';
import { buildSerperTools } from '../../../integrations/serper/tools.js';
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

const DEFAULT_PROMPT = `You are a Product Marketing Planner AI employee for an e-commerce business.
Your job: read a product brief and produce a set of content variants — one per target
platform/language/audience combination — each ready to hand off to a product designer.

For every variant you MUST provide:
- A short \`title\` for the kanban card.
- The target \`platform\` (e.g. "shopify", "instagram", "facebook") and \`language\`.
- The \`assignedAgent\` must always be "product-designer".
- A self-contained Markdown \`brief\` the designer reads directly. Fold all the planning
  details into prose with subheads:
    - \`### Marketing angle\` — who this is for, what pain it solves.
    - \`### Key messages\` — 3–5 bullets the designer must weave into the copy.
    - \`### Copy brief\` — tone, features to highlight, forbidden claims.
    - \`### Image plan\` — for each shot: purpose, style hint, required vs optional.
      Do NOT specify ratios or exact prompts — the designer's domain knowledge handles those.
  Write the brief as prose with subheads — not as a JSON-shaped list. Start with prose or
  a bullet list (NOT with H1 / H2). The strategist's code wraps your brief inside
  \`### {variant title}\`, so don't open with \`#\` or \`##\`. Use the variant's \`language\`
  field's language for the entire brief content.

Workflow:
1. If serper_search is available, search 1–3 queries to understand competitor angles and
   trending keywords for this product category.
2. Use SERP insights to identify differentiation gaps and audience angles.
3. Compose \`overview\` — your zh-TW Markdown report explaining the overall strategy.
4. Produce the structured variant plan.

Constraints:
- Plan between 1 and {MAX_VARIANTS} variants.
- Each variant targets a distinct audience/platform combination — do not duplicate angles.
- Honor any brand tone or keyword constraints from the config.`;

const DesignerVariantSchema = z.object({
  title: z
    .string()
    .min(1)
    .describe('Short label for the kanban card, e.g. "亞麻短袖 - 電商版 (zh-TW)"'),
  platform: z
    .string()
    .nullish()
    .describe('Target platform: "shopify", "instagram", "facebook", etc.'),
  language: z.enum(['zh-TW', 'zh-CN', 'en', 'ja', 'ko']),
  brief: z
    .string()
    .min(80)
    .describe(
      'Self-contained Markdown brief the Product Designer reads directly. ' +
        'Embed all the planning details as prose: marketing angle (who this is for, what pain it solves), ' +
        'key messages (3–5 bullets), copy brief (tone, features to highlight, forbidden claims), ' +
        'image plan (each shot: purpose, style hint, required/optional). ' +
        "Use H3 (`###`) and H4 (`####`) sub-headings + bullet lists. The planner's code wraps " +
        'your brief inside `### {variant title}`, so do NOT start with H1 (`#`) or H2 (`##`); ' +
        'start with prose or a bullet list. You may use H3 (`###`) and H4 (`####`) inside the brief ' +
        'for sub-sections — they nest correctly under the wrapping H3.',
    ),
  assignedAgent: z.literal('product-designer'),
  // .nullish() not .optional() — see seo-strategist scheduledAt for the rationale.
  scheduledAt: z.string().datetime().nullish(),
});

const PlanSchema = z.object({
  overview: z
    .string()
    .min(100)
    .max(4000)
    .describe(
      '整體規劃匯報。**用 zh-TW 繁體中文 + Markdown**。要回答：你做了什麼研究（competitor SERP 看到什麼）、' +
        '為什麼選這些 variants、差異化切角是什麼、特別考量。' +
        '可用 ## / ### 子標題、**粗體**、- 條列、表格。300–1200 字。語氣像員工向老闆書面匯報。' +
        '注意：每個 variant 自己的細節寫在 variant 的 brief 裡，這裡只放整體大局。',
    ),
  progressNote: z
    .string()
    .min(10)
    .max(200)
    .describe('一句話對老闆回報整體規劃思路。用 zh-TW 第一人稱，對話對象是「老闆」。'),
  variants: z.array(DesignerVariantSchema).min(1),
});

const configSchema = z.object({
  maxVariants: z
    .number()
    .int()
    .min(1)
    .max(10)
    .default(5)
    .describe('Maximum number of content variants to plan per brief'),
  defaultLanguages: z
    .array(z.enum(['zh-TW', 'zh-CN', 'en', 'ja', 'ko']))
    .min(1)
    .default(['zh-TW']),
  brandTone: z.string().nullish(),
  preferredKeywords: z.array(z.string()).default([]),
  useSerperSearch: z.boolean().default(true).describe('Search competitor SERPs before planning'),
  skills: z
    .object({
      seoFundamentals: z.boolean().default(true),
      productPositioning: z.boolean().default(true),
      ecommerceMarketing: z.boolean().default(true),
    })
    .default({}),
});

type ProductPlannerConfig = z.infer<typeof configSchema>;

export const productPlannerAgent: IAgent = {
  manifest: {
    id: 'product-planner',
    name: '產品企劃師',
    description:
      '新商品上架的入口；規劃產品內容策略：' +
      '透過 Serper 研究競品切角，產出多組內容變體（平台 × 語言 × 受眾），' +
      '並為每個變體派發一筆產品設計師任務。',
    defaultModel: { model: 'anthropic/claude-sonnet-4.6', temperature: 0.2 },
    defaultPrompt: DEFAULT_PROMPT,
    toolIds: ['serper.search'],
    requiredCredentials: [],
    configSchema,
    metadata: { kind: 'strategy' },
  },

  async build(ctx: AgentBuildContext): Promise<AgentRunnable> {
    const cfg = configSchema.parse(ctx.agentConfig ?? {}) as ProductPlannerConfig;

    const packsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'packs');
    const packsBlock = await loadPacks(packsDir, cfg.skills as Record<string, boolean>);

    const serperKey = env.SERPER_API_KEY;
    const serperTools =
      cfg.useSerperSearch && serperKey
        ? buildSerperTools({
            tenantId: ctx.tenantId,
            cache: new SerpCache(new SerperClient({ apiKey: serperKey })),
          })
        : [];

    const invoke = async (input: AgentInput): Promise<AgentOutput> => {
      if (!ctx.availableExecutionAgents.find((a) => a.id === 'product-designer')) {
        throw new Error('product-planner requires product-designer to be enabled for this tenant');
      }

      await ctx.emitLog('agent.started', '研究一下競品，幫你規劃幾個方向', {
        maxVariants: cfg.maxVariants,
        useSerper: serperTools.length > 0,
      });

      const constraints: string[] = [
        `Maximum variants: ${cfg.maxVariants}`,
        `Default languages: ${cfg.defaultLanguages.join(', ')}`,
        ...(cfg.brandTone ? [`Brand tone: ${cfg.brandTone}`] : []),
        ...(cfg.preferredKeywords.length > 0
          ? [`Preferred keywords: ${cfg.preferredKeywords.join(', ')}`]
          : []),
      ];

      const basePrompt = ctx.systemPrompt.replace('{MAX_VARIANTS}', String(cfg.maxVariants));
      const systemPrompt = packsBlock ? `${packsBlock}\n\n${basePrompt}` : basePrompt;

      const baseMessages = await buildAgentMessages(
        systemPrompt,
        input.messages,
        constraints,
        input.imageResolver,
      );

      // Single pass: research via serper_search, finalize via submit_plan.
      // Same finalAnswer pattern as seo-strategist — no second LLM round-trip.
      const result = await runToolLoop({
        modelConfig: ctx.modelConfig,
        messages: baseMessages,
        tools: serperTools,
        maxHops: 8,
        emitLog: ctx.emitLog,
        finalAnswer: {
          schema: PlanSchema,
          name: 'submit_plan',
          description:
            'Call this exactly once when your research is complete. The args ARE the final product content plan that will be shown to the user for approval.',
          minToolHops: serperTools.length > 0 ? 1 : 0,
        },
      });

      if (result.kind !== 'submitted') {
        throw new Error(
          'Product planner did not submit a plan within the tool loop budget — model emitted free-form content without calling submit_plan.',
        );
      }
      const plan = result.value;

      const capped = plan.variants.slice(0, cfg.maxVariants);

      const originalImageIds = (input.params as { imageIds?: string[] }).imageIds ?? [];

      const spawnTasks: SpawnTaskRequest[] = capped.map((v) => ({
        title: v.title,
        description: v.title,
        assignedAgent: 'product-designer',
        input: {
          brief: v.brief,
          refs: {
            language: v.language,
            ...(originalImageIds.length > 0 ? { originalImageIds } : {}),
          },
        },
        ...(v.scheduledAt ? { scheduledAt: v.scheduledAt } : {}),
      }));

      await ctx.emitLog('agent.plan.ready', plan.progressNote, {
        artifactShape: 'report',
        variantCount: capped.length,
      });

      const report = [plan.overview, ...capped.map((v) => `### ${v.title}\n\n${v.brief}`)].join(
        '\n\n',
      );

      return {
        message: plan.progressNote,
        awaitingApproval: true,
        artifact: { report },
        spawnTasks,
      };
    };

    return { tools: [], invoke };
  },
};
