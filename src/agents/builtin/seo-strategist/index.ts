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

const DEFAULT_PROMPT = `You are an SEO Strategist AI employee for an e-commerce business.
Your job: turn a high-level SEO brief (a season, a campaign, a product line) into a
concrete content plan — a list of focused article topics that, together, deliver
the strategy. You do NOT write the articles yourself; you pick which downstream
worker agent should handle each topic.

For every topic in the plan you MUST provide:
- A focused angle (single intent, single primary keyword cluster).
- The target language for that piece.
- The "assignedAgent" id of the worker that should produce the article.
  Pick from the "Available worker agents" list below — each entry shows the
  agent's id and what it can do. If no listed agent fits a topic, drop the topic.

Constraints:
- Plan between 3 and {MAX_TOPICS} topics. Fewer is better than padding.
- Avoid duplicate angles or keyword cannibalisation.
- Honor any tone/keyword/language constraints the user mentions.
- If the user mentions a publishing cadence ("every 3 days", "weekly", "one per
  week starting next Monday"), set "scheduledAt" on each topic relative to the
  "Current time" given in the Runtime context block above. First topic at
  Current time + 0; subsequent topics offset by the requested interval. Use
  ISO 8601 with timezone (e.g. "2026-05-04T09:00:00Z"). When no cadence is
  mentioned, leave scheduledAt unset so the article runs immediately.

Workflow:
1. Identify 1–3 seed keyword clusters from the brief.
2. Call serper_search for each seed (and for any sub-cluster you want to validate).
3. Use the SERP results — top 10 titles, peopleAlsoAsk, relatedSearches — to write
   each topic's writerBrief. The writerBrief is **Markdown** that includes:
   - Search intent (informational / commercial / transactional / navigational)
   - The most relevant 3–8 PAA questions to address
   - Adjacent long-tail queries (relatedSearches) to weave in
   - Competitor top angles (e.g. "listicle of 7", "comparison guide")
   - Competitor gaps — the differentiation hook
   - Target word count (estimate from top-10 medians; default ~1200 if uncertain)
   - One concrete E-E-A-T hook the writer should lean into
   Write the brief as prose with subheads — not as a JSON-shaped list. The writer
   reads it as natural language context.
4. Compose \`overview\` — your zh-TW Markdown report explaining the overall strategy.

When ready, return the plan as the structured output requested. The plan will be
shown to the user for approval before any child article task is created.`;

const configSchema = z.object({
  maxTopics: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(10)
    .describe('Hard cap on how many article topics the strategist may plan per brief'),
  defaultLanguages: z
    .array(z.enum(['zh-TW', 'zh-CN', 'en', 'ja', 'ko']))
    .min(1)
    .default(['zh-TW'])
    .describe('Languages used when the brief does not specify per-topic languages'),
  brandTone: z
    .string()
    .nullish()
    .describe('Free-form tone description forwarded to each child writer task'),
  preferredKeywords: z
    .array(z.string())
    .default([])
    .describe('Keyword cluster the strategist should prioritise when planning topics'),
  skills: z
    .object({
      seoFundamentals: z.boolean().default(true),
      aiSeo: z.boolean().default(true),
      geo: z.boolean().default(true),
    })
    .default({}),
});

type SeoStrategistConfig = z.infer<typeof configSchema>;

const TopicSchema = z.object({
  title: z.string().min(1).describe('Article working title — also used as the kanban card.'),
  primaryKeyword: z.string().describe('The single primary keyword the article should rank for.'),
  language: z.enum(['zh-TW', 'zh-CN', 'en', 'ja', 'ko']),
  writerBrief: z
    .string()
    .min(80)
    .describe(
      'Self-contained zh-TW/zh-CN/en/ja/ko **Markdown** brief the writer agent will read directly. ' +
        'Embed all research findings as prose: search intent, top PAA questions, related searches to weave in, ' +
        "competitor top angles, competitor gaps (the differentiation hook), target word count, " +
        'and the most important E-E-A-T hook. Use ## / ### subheads + bullet lists. The writer ' +
        'reads this as the canonical context — be specific, not generic. ' +
        "The strategist's code wraps your brief inside `### {topic title}`, so do NOT start your " +
        'brief with H1 (`#`) or H2 (`##`); start with prose or a bullet list. You may use H3 ' +
        '(`###`) and H4 (`####`) inside the brief for sub-sections, since they nest correctly ' +
        'under the wrapping H3.',
    ),
  assignedAgent: z.string().describe('Id of the worker agent that should produce this article.'),
  scheduledAt: z.string().datetime().optional().describe('Optional ISO timestamp.'),
});

const PlanSchema = z.object({
  overview: z
    .string()
    .min(100)
    .max(4000)
    .describe(
      '整體規劃匯報。**用 zh-TW 繁體中文 + Markdown**。要回答：你做了什麼研究、市場觀察、為什麼選這幾個主題、競品缺口、整體策略、特別考量。' +
        '可用 ## / ### 子標題、**粗體**、- 條列、表格。300–1200 字。語氣像員工向老闆書面匯報。' +
        '注意：每個 topic 自己的細節寫在 topic 的 writerBrief 裡，這裡只放整體大局。',
    ),
  progressNote: z
    .string()
    .min(10)
    .max(200)
    .describe(
      '一句話對老闆回報你的整體規劃思路。zh-TW 第一人稱，對話對象是「老闆」。' +
        '會顯示在看板進度時間軸。',
    ),
  topics: z.array(TopicSchema).min(1),
});

type ContentPlan = z.infer<typeof PlanSchema>;
type ContentTopic = ContentPlan['topics'][number];

export const seoStrategistAgent: IAgent = {
  manifest: {
    id: 'seo-strategist',
    name: 'SEO Strategist',
    description:
      'Plans SEO campaigns: turns a high-level brief into a list of focused article topics, ' +
      'each spawned as an independent execution task for the Shopify Blog Writer.',
    defaultModel: { model: 'anthropic/claude-sonnet-4.6', temperature: 0.2 },
    defaultPrompt: DEFAULT_PROMPT,
    toolIds: ['serper.search'],
    requiredCredentials: [],
    configSchema,
    metadata: { kind: 'strategy' },
  },

  async build(ctx: AgentBuildContext): Promise<AgentRunnable> {
    const cfg = configSchema.parse(ctx.agentConfig ?? {}) as SeoStrategistConfig;

    if (ctx.availableExecutionAgents.length === 0) {
      throw new Error(
        'seo-strategist requires at least one peer worker agent to be enabled for the tenant',
      );
    }
    const validWorkerIds = new Set(ctx.availableExecutionAgents.map((a) => a.id));

    const packsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'packs');
    const packsBlock = await loadPacks(packsDir, cfg.skills);

    const invoke = async (input: AgentInput): Promise<AgentOutput> => {
      await ctx.emitLog('agent.started', '收到 brief，我來規劃幾個主題給老闆挑', {
        maxTopics: cfg.maxTopics,
        availableWorkers: [...validWorkerIds],
      });

      const constraints: string[] = [`Maximum topics: ${cfg.maxTopics}`];
      if (cfg.brandTone) constraints.push(`Brand tone: ${cfg.brandTone}`);
      if (cfg.preferredKeywords.length > 0) {
        constraints.push(`Preferred keyword cluster: ${cfg.preferredKeywords.join(', ')}`);
      }
      constraints.push(
        `Default languages if user did not specify: ${cfg.defaultLanguages.join(', ')}`,
      );

      const workerRoster = ctx.availableExecutionAgents
        .map((a) => `- ${a.id}: ${a.description}`)
        .join('\n');

      const basePrompt = ctx.systemPrompt.replace('{MAX_TOPICS}', String(cfg.maxTopics));
      const promptWithRoster = `${basePrompt}\n\nAvailable worker agents (pick one id per topic for the "assignedAgent" field):\n${workerRoster}`;
      const systemPrompt = packsBlock ? `${packsBlock}\n\n${promptWithRoster}` : promptWithRoster;

      // Pass 1: gather SERP data via tool-calling loop (max 6 hops)
      const serperKey = env.SERPER_API_KEY;
      const serperTools = serperKey
        ? buildSerperTools({
            tenantId: ctx.tenantId,
            cache: new SerpCache(new SerperClient({ apiKey: serperKey })),
          })
        : [];

      const baseMessages = await buildAgentMessages(
        systemPrompt,
        input.messages,
        constraints,
        input.imageResolver,
      );

      const { collected } = await runToolLoop({
        modelConfig: ctx.modelConfig,
        messages: baseMessages,
        tools: serperTools,
        maxHops: 6,
        emitLog: ctx.emitLog,
      });

      // Pass 2: produce the structured plan from the enriched conversation
      const plan = await invokeStructured(ctx.modelConfig, PlanSchema, 'seo_content_plan', [
        ...collected,
        new HumanMessage('Now produce the final structured plan.'),
      ]);

      const capped: ContentTopic[] = plan.topics.slice(0, cfg.maxTopics);

      const invalid = capped.filter((t) => !validWorkerIds.has(t.assignedAgent));
      if (invalid.length > 0) {
        throw new Error(
          `SEO Strategist picked unknown worker agent(s): ${invalid
            .map((t) => `"${t.assignedAgent}" for topic "${t.title}"`)
            .join('; ')}. Available workers: ${[...validWorkerIds].join(', ')}`,
        );
      }

      const spawnTasks: SpawnTaskRequest[] = capped.map((t) => ({
        title: t.title,
        description: `SEO article — primary keyword: ${t.primaryKeyword}`,
        assignedAgent: t.assignedAgent,
        input: {
          brief: t.writerBrief,
          refs: {
            primaryKeyword: t.primaryKeyword,
            language: t.language,
          },
        },
        ...(t.scheduledAt ? { scheduledAt: t.scheduledAt } : {}),
      }));

      await ctx.emitLog('agent.plan.ready', plan.progressNote, {
        artifactShape: 'report',
        topicCount: capped.length,
      });

      const report = [
        plan.overview,
        ...capped.map((t) => `### ${t.title}\n\n${t.writerBrief}`),
      ].join('\n\n');

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
