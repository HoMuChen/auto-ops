import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { buildModel } from '../../../llm/model-registry.js';
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

When ready, return the plan as the structured output requested. The plan will be
shown to the user for approval before any child article task is created.`;

/** User-facing activation config — controls planning aggressiveness and defaults. */
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
    .optional()
    .describe('Free-form tone description forwarded to each child writer task'),
  preferredKeywords: z
    .array(z.string())
    .default([])
    .describe('Keyword cluster the strategist should prioritise when planning topics'),
});

type SeoStrategistConfig = z.infer<typeof configSchema>;

const PlanSchema = z.object({
  reasoning: z
    .string()
    .describe('One-paragraph rationale: why this set of topics covers the brief.'),
  topics: z
    .array(
      z.object({
        title: z.string().min(1).describe('Article working title — also used as the kanban card.'),
        primaryKeyword: z
          .string()
          .describe('The single primary keyword the article should rank for.'),
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
      }),
    )
    .min(1),
});

type ContentPlan = z.infer<typeof PlanSchema>;
type ContentTopic = ContentPlan['topics'][number];

export const seoStrategistAgent: IAgent = {
  manifest: {
    id: 'seo-strategist',
    name: 'AI SEO Strategist',
    description:
      'Plans SEO campaigns: turns a high-level brief into a list of focused article topics, ' +
      'each spawned as an independent execution task for the SEO Writer.',
    availableInPlans: ['pro', 'flagship'],
    // Strategy is high-stakes routing logic — use Opus, low temperature so the
    // structured plan is consistent across runs of the same brief.
    defaultModel: { model: 'anthropic/claude-opus-4.7', temperature: 0.2 },
    defaultPrompt: DEFAULT_PROMPT,
    toolIds: [],
    requiredCredentials: [],
    configSchema,
    metadata: { kind: 'strategy' },
  },

  build(ctx: AgentBuildContext): AgentRunnable {
    const cfg = configSchema.parse(ctx.agentConfig ?? {}) as SeoStrategistConfig;
    const model = buildModel(ctx.modelConfig).withStructuredOutput(PlanSchema, {
      name: 'seo_content_plan',
    });

    // Whitelist of worker ids the LLM may pick from. Built once per build.
    const validWorkerIds = new Set(ctx.availableExecutionAgents.map((a) => a.id));
    if (validWorkerIds.size === 0) {
      // Fail fast at build time rather than producing a plan that would be
      // rejected at finalize time. Surfaces config drift early.
      throw new Error(
        'seo-strategist requires at least one peer worker agent to be enabled for the tenant',
      );
    }

    const invoke = async (input: AgentInput): Promise<AgentOutput> => {
      await ctx.emitLog('agent.started', `SEO Strategist planning task ${ctx.taskId}`, {
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

      const systemMessage = `${ctx.systemPrompt.replace('{MAX_TOPICS}', String(cfg.maxTopics))}

Available worker agents (pick one id per topic for the "assignedAgent" field):
${workerRoster}

Tenant constraints:
- ${constraints.join('\n- ')}`;

      const messages = [
        new SystemMessage(systemMessage),
        ...input.messages.map((m) =>
          m.role === 'user' ? new HumanMessage(m.content) : new HumanMessage(m.content),
        ),
      ];

      const plan = (await model.invoke(messages)) as ContentPlan;
      const capped: ContentTopic[] = plan.topics.slice(0, cfg.maxTopics);

      // Defensive validation: structured output gives us `assignedAgent: string`
      // but z.string() can't enforce membership in a runtime-built set. Catch
      // an LLM that hallucinates a worker id here so it surfaces as a clear
      // task error instead of an obscure "node not found" later.
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

      await ctx.emitLog('agent.plan.ready', 'SEO content plan ready, awaiting approval', {
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
