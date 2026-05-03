import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HumanMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { env } from '../../../config/env.js';
import { SerpCache } from '../../../integrations/serper/cache.js';
import { SerperClient } from '../../../integrations/serper/client.js';
import { buildSerperTools } from '../../../integrations/serper/tools.js';
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

const DEFAULT_PROMPT = `You are a Product Marketing Planner AI employee for an e-commerce business.
Your job: read a product brief and produce a set of content variants — one per target
platform/language/audience combination — each ready to hand off to a product designer.

For every variant you MUST provide:
- A clear marketing angle (one sentence: who this is for, what pain it solves).
- The key messages (2–4 bullets the designer must weave into the copy).
- A copy brief (tone, features to highlight, forbidden claims).
- An image plan: list of shots with purpose and style hint. Do NOT specify ratios or
  exact prompts — the designer's domain knowledge handles those.
- The assignedAgent must always be "product-designer".

Workflow:
1. If serper_search is available, search 1–3 queries to understand competitor angles and
   trending keywords for this product category.
2. Use SERP insights to identify differentiation gaps and audience angles.
3. Produce the structured variant plan.

Constraints:
- Plan between 1 and {MAX_VARIANTS} variants.
- Each variant targets a distinct audience/platform combination — do not duplicate angles.
- Honor any brand tone or keyword constraints from the config.`;

const ImageBriefSchema = z.object({
  purpose: z
    .string()
    .min(2)
    .describe('Shot type and scene, e.g. "hero shot" or "lifestyle - morning commute"'),
  styleHint: z
    .string()
    .min(2)
    .describe('Lighting, mood, background direction. No ratios or prompts.'),
  priority: z.enum(['required', 'optional']),
});

const DesignerVariantSchema = z.object({
  title: z
    .string()
    .min(1)
    .describe('Short label for the kanban card, e.g. "亞麻短袖 - 電商版 (zh-TW)"'),
  platform: z
    .string()
    .optional()
    .describe('Target platform: "shopify", "instagram", "facebook", etc.'),
  language: z.enum(['zh-TW', 'zh-CN', 'en', 'ja', 'ko']),
  marketingAngle: z
    .string()
    .min(10)
    .describe('One sentence: who this is for and what pain it solves.'),
  keyMessages: z.array(z.string().min(1)).min(1).max(5),
  copyBrief: z.object({
    tone: z.string().min(2),
    featuresToHighlight: z.array(z.string()).min(1),
    forbiddenClaims: z.array(z.string()).default([]),
  }),
  imagePlan: z.array(ImageBriefSchema).min(1).max(6),
  assignedAgent: z.literal('product-designer'),
  scheduledAt: z.string().datetime().optional(),
});

const PlanSchema = z.object({
  summary: z
    .string()
    .min(20)
    .max(2000)
    .describe(
      '給老闆看的詳細匯報。**用 zh-TW 繁體中文** + Markdown 格式。' +
        '說明：你做了什麼研究（competitor SERP 看到什麼）、為什麼選這些 variants、' +
        '差異化切角是什麼、特別考量的地方。可用 ## / ### 子標題、**粗體**、- 條列、表格。' +
        '老闆靠這段決定 Approve / Feedback，要詳實但不要重複每個 variant 細節（variants 陣列已有）。' +
        '語氣像員工向老闆書面匯報。長度建議 200–800 字。',
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
    name: 'Product Planner',
    description:
      'Plans product content strategy: researches competitor angles via Serper, ' +
      'produces N content variants (platform × language × audience), ' +
      'and spawns a Product Designer task for each variant.',
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

      // Pass 1: serper research loop
      const { collected } = await runToolLoop({
        modelConfig: ctx.modelConfig,
        messages: baseMessages,
        tools: serperTools,
        maxHops: 6,
        emitLog: ctx.emitLog,
      });

      // Pass 2: structured variant plan
      const plan = await invokeStructured(ctx.modelConfig, PlanSchema, 'product_content_plan', [
        ...collected,
        new HumanMessage('Now produce the final structured content plan.'),
      ]);

      const capped = plan.variants.slice(0, cfg.maxVariants);

      const originalImageIds = (input.params as { imageIds?: string[] }).imageIds ?? [];

      const spawnTasks: SpawnTaskRequest[] = capped.map((v) => ({
        title: v.title,
        description: `Product content — ${v.marketingAngle}`,
        assignedAgent: 'product-designer',
        input: {
          variantSpec: v,
          originalImageIds,
        },
        ...(v.scheduledAt ? { scheduledAt: v.scheduledAt } : {}),
      }));

      await ctx.emitLog('agent.plan.ready', plan.progressNote, {
        artifactKind: 'product-plan',
        variantCount: capped.length,
      });

      const variantsForArtifact = capped.map((v) => ({
        ...v,
        copyBrief: {
          ...v.copyBrief,
          forbiddenClaims: v.copyBrief.forbiddenClaims ?? [],
        },
      }));

      return {
        message: plan.progressNote,
        awaitingApproval: true,
        artifact: {
          kind: 'product-plan',
          data: {
            summary: plan.summary,
            variants: variantsForArtifact,
          },
        },
        spawnTasks,
      };
    };

    return { tools: [], invoke };
  },
};
