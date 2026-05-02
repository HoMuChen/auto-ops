import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type AIMessage,
  type BaseMessage,
  HumanMessage,
  ToolMessage,
} from '@langchain/core/messages';
import { z } from 'zod';
import { env } from '../../../config/env.js';
import { SerpCache } from '../../../integrations/serper/cache.js';
import { SerperClient } from '../../../integrations/serper/client.js';
import { buildSerperTools } from '../../../integrations/serper/tools.js';
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

const DEFAULT_PROMPT = `You are an SEO Strategist AI employee for an e-commerce business.
Your job: turn a high-level SEO brief (a season, a campaign, a product line) into a
concrete content plan — a list of focused article topics that, together, deliver
the strategy. You do NOT write the articles yourself; you pick which downstream
worker agent should handle each topic.

For every topic in the plan you MUST provide:
- A focused angle (single intent, single primary keyword cluster).
- The target language for that piece.
- Enough brief in "writerBrief" that a writer can start without asking questions.
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
3. Use the SERP results — top 10 titles, peopleAlsoAsk, relatedSearches — to:
   - Decide each topic's searchIntent.
   - Set paaQuestions = the most relevant 3–8 PAA items per topic.
   - Set relatedSearches = adjacent long-tail queries to weave in.
   - Set competitorTopAngles = patterns in the top 10 (e.g. "listicle of 7",
     "comparison guide", "tutorial").
   - Set competitorGaps = angles the top 10 ignore (the differentiation hook).
   - Set targetWordCount = roughly the median word count visible in top 10
     snippets (estimate; default 1200 if uncertain).
   - Set eeatHook = a 1-sentence note for the writer on which experience
     dimension matters most for this topic.
4. Only after research, build the structured plan.

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
    .min(20)
    .describe('Self-contained brief the writer agent receives as task.input.brief.'),
  assignedAgent: z
    .string()
    .describe(
      'Id of the worker agent that should produce this article. Must be one of the ids ' +
        'listed in "Available worker agents" in the system prompt.',
    ),
  scheduledAt: z
    .string()
    .datetime()
    .optional()
    .describe('Optional ISO timestamp if the article should be scheduled.'),
  searchIntent: z.enum(['informational', 'commercial', 'transactional', 'navigational']),
  paaQuestions: z.array(z.string()).max(8),
  relatedSearches: z.array(z.string()).max(10),
  competitorTopAngles: z.array(z.string()).max(5),
  competitorGaps: z.array(z.string()).max(5),
  targetWordCount: z.number().int().min(400).max(4000),
  eeatHook: z.string().min(20).max(300),
});

const PlanSchema = z.object({
  reasoning: z
    .string()
    .describe('One-paragraph rationale: why this set of topics covers the brief.'),
  progressNote: z
    .string()
    .min(10)
    .max(200)
    .describe(
      '一句話對老闆回報你的整體規劃思路（不要重複每篇文章細節）。' +
        '例：「規劃了 5 個切角，主軸是把夏季穿搭跟商品做關聯，我覺得第 2 篇是流量主力」。' +
        '用 zh-TW 第一人稱，對話對象是「老闆」。' +
        '這段會直接顯示在看板的進度時間軸上。',
    ),
  topics: z.array(TopicSchema).min(1),
});

type ContentPlan = z.infer<typeof PlanSchema>;
type ContentTopic = ContentPlan['topics'][number];

export type TopicResearch = Pick<
  ContentTopic,
  | 'searchIntent'
  | 'paaQuestions'
  | 'relatedSearches'
  | 'competitorTopAngles'
  | 'competitorGaps'
  | 'targetWordCount'
  | 'eeatHook'
>;

export const seoStrategistAgent: IAgent = {
  manifest: {
    id: 'seo-strategist',
    name: 'AI SEO Strategist',
    description:
      'Plans SEO campaigns: turns a high-level brief into a list of focused article topics, ' +
      'each spawned as an independent execution task for the Shopify Blog Writer.',
    defaultModel: { model: 'anthropic/claude-opus-4.7', temperature: 0.2 },
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

      const toolModel = (
        buildModel(ctx.modelConfig) as unknown as {
          bindTools: (tools: unknown[]) => { invoke: (msgs: BaseMessage[]) => Promise<AIMessage> };
        }
      ).bindTools(serperTools.map((t) => t.tool));
      const collected: BaseMessage[] = [
        ...(await buildAgentMessages(systemPrompt, input.messages, constraints)),
      ];

      for (let hop = 0; hop < 6; hop++) {
        const res = (await toolModel.invoke(collected)) as AIMessage;
        collected.push(res);
        if (!res.tool_calls?.length) break;
        for (const call of res.tool_calls) {
          const t = serperTools.find((x) => x.tool.name === call.name);
          if (!t) continue;
          const result = await t.tool.invoke(call.args as Record<string, unknown>);
          collected.push(
            new ToolMessage({ tool_call_id: call.id ?? '', content: JSON.stringify(result) }),
          );
        }
      }

      // Pass 2: produce the structured plan from the enriched conversation
      const planModel = buildModel(ctx.modelConfig).withStructuredOutput(PlanSchema, {
        name: 'seo_content_plan',
      });
      const plan = (await planModel.invoke([
        ...collected,
        new HumanMessage('Now produce the final structured plan.'),
      ])) as ContentPlan;

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
          primaryKeyword: t.primaryKeyword,
          language: t.language,
          research: {
            searchIntent: t.searchIntent,
            paaQuestions: t.paaQuestions,
            relatedSearches: t.relatedSearches,
            competitorTopAngles: t.competitorTopAngles,
            competitorGaps: t.competitorGaps,
            targetWordCount: t.targetWordCount,
            eeatHook: t.eeatHook,
          } satisfies TopicResearch,
        },
        ...(t.scheduledAt ? { scheduledAt: t.scheduledAt } : {}),
      }));

      const summary = [
        `# SEO Content Plan (${capped.length} articles)`,
        '',
        plan.reasoning,
        '',
        ...capped.map(
          (t: ContentTopic, i: number) =>
            `${i + 1}. **${t.title}** _(${t.language}, kw: ${t.primaryKeyword}${
              t.scheduledAt ? `, scheduled: ${t.scheduledAt}` : ''
            })_`,
        ),
        '',
        '_Approve to spawn each article as an independent writer task._',
      ].join('\n');

      await ctx.emitLog('agent.plan.ready', plan.progressNote, {
        topicCount: capped.length,
      });

      return {
        message: summary,
        awaitingApproval: true,
        payload: {
          plan: { reasoning: plan.reasoning, topics: capped },
        },
        spawnTasks,
      };
    };

    return { tools: [], invoke };
  },
};
