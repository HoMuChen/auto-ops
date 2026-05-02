import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { buildShopifyTools } from '../../../integrations/shopify/tools.js';
import { buildModel } from '../../../llm/model-registry.js';
import { buildAgentMessages } from '../../lib/messages.js';
import { loadPacks } from '../../lib/packs.js';
import type {
  AgentBuildContext,
  AgentInput,
  AgentOutput,
  AgentRunnable,
  IAgent,
  PendingToolCall,
} from '../../types.js';
import type { TopicResearch } from '../seo-strategist/index.js';

const DEFAULT_PROMPT = `You are an Shopify Blog Writer AI employee for an e-commerce business.
Your job: produce ONE polished, multilingual blog article from a single brief
and return it as the structured object requested. The framework will publish
the article to the tenant's Shopify blog after the user reviews and approves.

Requirements:
- Title: <= 70 chars, include the primary keyword if natural.
- Body: clean, semantic HTML (<h2>, <p>, <ul>/<li>, <blockquote>; never
  <script>/<style>). Aim for 800–1500 words for top-of-funnel SEO posts.
- Summary: 1–2 sentence excerpt (<= 200 chars) used as the meta description
  and the blog index card.
- Tags: 3–8 short lower-case keywords.
- Honor any tone/keyword/forbidden-phrase constraints in the brief.
- Stay focused on the single topic — do NOT propose other articles.

When you have EEAT research hooks from the strategist, ask the boss 2–3
concrete experience questions BEFORE drafting. Use the eeatHook to focus them.`;

const configSchema = z.object({
  targetLanguages: z
    .array(z.enum(['zh-TW', 'zh-CN', 'en', 'ja', 'ko']))
    .min(1)
    .default(['zh-TW'])
    .describe('Languages this writer is fluent in (informational; the brief picks one).'),
  brandTone: z
    .string()
    .nullish()
    .describe('Free-form tone description, e.g. "warm, professional, slightly playful"'),
  bannedPhrases: z.array(z.string()).default([]).describe('Phrases the agent must never use'),
  preferredKeywords: z
    .array(z.string())
    .default([])
    .describe('Keywords the agent should weave in when natural'),

  publishToShopify: z
    .boolean()
    .default(true)
    .describe(
      'If true, approve(finalize=true) publishes the article to the tenant Shopify blog ' +
        'via shopify.publish_article. If false, the task just goes to done with the draft.',
    ),
  blogHandle: z
    .string()
    .nullish()
    .describe('Shopify blog handle (e.g. "news"). Defaults to the first blog on the store.'),
  defaultAuthor: z
    .string()
    .nullish()
    .describe('Author byline written to the article when the brief does not specify one.'),
  publishImmediately: z
    .boolean()
    .default(false)
    .describe(
      'If true, the article goes live on the storefront immediately. Default false → draft.',
    ),
  credentialLabel: z
    .string()
    .nullish()
    .describe('Which Shopify credential row to use when the tenant has multiple stores.'),

  skills: z
    .object({
      seoFundamentals: z.boolean().default(true),
      eeat: z.boolean().default(true),
      aiSeo: z.boolean().default(false),
      geo: z.boolean().default(false),
    })
    .default({}),
});

type SeoWriterConfig = z.infer<typeof configSchema>;

const ArticleSchema = z.object({
  title: z.string().min(1).max(140).describe('Article title shown on the blog and in feeds.'),
  bodyHtml: z
    .string()
    .min(50)
    .describe(
      'Article body as semantic HTML. Use <h2>, <p>, <ul>/<li>, <blockquote>; never <script>/<style>.',
    ),
  summaryHtml: z
    .string()
    .min(20)
    .max(400)
    .describe('1–2 sentence excerpt — used as meta description and blog index card.'),
  tags: z.array(z.string().min(1)).min(1).max(20).describe('Short keyword tags. 3–8 is ideal.'),
  language: z
    .enum(['zh-TW', 'zh-CN', 'en', 'ja', 'ko'])
    .describe('The language the article is written in.'),
  author: z.string().optional().describe('Author byline. Leave blank to use the agent default.'),
  progressNote: z
    .string()
    .min(10)
    .max(200)
    .describe(
      '一句話對老闆回報你剛完成什麼、有什麼特別著重的點。' +
        '例：「草稿好了，這篇我特別強調機能麻料適合台灣濕熱夏天，老闆看一下開頭那段」。' +
        '用 zh-TW 第一人稱，對話對象是「老闆」，不要寫成「I have completed...」這種翻譯腔。' +
        '這段會直接顯示在看板的進度時間軸上，所以要像員工口頭回報而不是技術 log。',
    ),
});

type ArticleDraft = z.infer<typeof ArticleSchema>;

const EeatQuestionsSchema = z.object({
  questions: z
    .array(
      z.object({
        question: z.string().min(5).describe('Concrete experience question to the boss.'),
        hint: z.string().optional().describe('Optional hint shown under the question.'),
        optional: z.boolean().optional().describe('If true, boss may skip without blocking.'),
      }),
    )
    .min(1)
    .max(5),
  progressNote: z.string().min(10).max(200),
});

type EeatQuestions = z.infer<typeof EeatQuestionsSchema>;
type EeatQuestion = EeatQuestions['questions'][number];

/**
 * Stage 1 fires when the task has research from the strategist (eeatHook present)
 * AND the boss hasn't yet answered the EEAT questions (eeatPending not set).
 * Stage 2 fires for all other cases (direct tasks, or after EEAT answers received).
 */
function shouldDoStage1(
  taskOutput: Record<string, unknown> | undefined,
  params: Record<string, unknown>,
  messages: AgentInput['messages'],
): boolean {
  const research = (params as { research?: TopicResearch }).research;
  if (!research?.eeatHook) return false;
  const pending = (taskOutput as { eeatPending?: unknown } | undefined)?.eeatPending;
  if (!pending) return true;
  if (messages[messages.length - 1]?.role === 'user') return false;
  throw new Error('eeatPending set but last message is not from user — double-execution guard');
}

export const shopifyBlogWriterAgent: IAgent = {
  manifest: {
    id: 'shopify-blog-writer',
    name: 'AI Shopify Blog Writer',
    description:
      'Writes a single multilingual SEO blog article from a focused brief and ' +
      'publishes it to the tenant Shopify blog after human approval.',
    defaultModel: { model: 'anthropic/claude-opus-4.7', temperature: 0.4 },
    defaultPrompt: DEFAULT_PROMPT,
    toolIds: ['shopify.publish_article'],
    requiredCredentials: [
      {
        provider: 'shopify',
        description: 'Shopify Admin API token + store URL — needed to publish blog articles',
        setupUrl: 'https://help.shopify.com/en/manual/apps/app-types/custom-apps',
      },
    ],
    configSchema,
  },

  async build(ctx: AgentBuildContext): Promise<AgentRunnable> {
    const cfg = configSchema.parse(ctx.agentConfig ?? {}) as SeoWriterConfig;

    const tools = await buildShopifyTools(ctx.tenantId, {
      ...(cfg.credentialLabel ? { credentialLabel: cfg.credentialLabel } : {}),
      ...(cfg.blogHandle ? { blogHandle: cfg.blogHandle } : {}),
      ...(cfg.defaultAuthor ? { defaultAuthor: cfg.defaultAuthor } : {}),
      publishArticleImmediately: cfg.publishImmediately,
    });
    const filteredTools = tools.filter((t) => t.id === 'shopify.publish_article');

    const packsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'packs');
    const packsBlock = await loadPacks(packsDir, cfg.skills);
    const systemPrompt = packsBlock ? `${packsBlock}\n\n${ctx.systemPrompt}` : ctx.systemPrompt;

    const invoke = async (input: AgentInput): Promise<AgentOutput> => {
      await ctx.emitLog('agent.started', '開始寫稿了，給我一點時間', {
        publishToShopify: cfg.publishToShopify,
        blogHandle: cfg.blogHandle ?? '(default)',
      });

      const constraints: string[] = [];
      if (cfg.brandTone) constraints.push(`Tone: ${cfg.brandTone}`);
      if (cfg.preferredKeywords.length > 0) {
        constraints.push(`Preferred keywords: ${cfg.preferredKeywords.join(', ')}`);
      }
      if (cfg.bannedPhrases.length > 0) {
        constraints.push(`Avoid phrases: ${cfg.bannedPhrases.join(', ')}`);
      }
      constraints.push(`Writer fluent in: ${cfg.targetLanguages.join(', ')}`);

      // Build research section if task came from the Strategist
      const research = (input.params as { research?: TopicResearch }).research;
      const researchSection = research
        ? [
            'Research from the strategist:',
            `- Search intent: ${research.searchIntent}`,
            `- People Also Ask: ${research.paaQuestions.join(' / ')}`,
            `- Related searches: ${research.relatedSearches.join(' / ')}`,
            `- Competitor top angles: ${research.competitorTopAngles.join(' / ')}`,
            `- Competitor gaps: ${research.competitorGaps.join(' / ')}`,
            `- Target word count: ${research.targetWordCount}`,
            `- EEAT hook: ${research.eeatHook}`,
          ].join('\n')
        : '';
      const systemWithResearch = researchSection
        ? `${systemPrompt}\n\n${researchSection}`
        : systemPrompt;

      if (shouldDoStage1(input.taskOutput, input.params, input.messages)) {
        const questionModel = buildModel(ctx.modelConfig).withStructuredOutput(
          EeatQuestionsSchema,
          { name: 'eeat_questions' },
        );
        const messages = buildAgentMessages(systemWithResearch, input.messages, constraints);
        const q = (await questionModel.invoke(messages)) as EeatQuestions;
        await ctx.emitLog('agent.questions.asked', q.progressNote, {
          count: q.questions.length,
        });
        return {
          message: renderQuestionsMarkdown(q.questions),
          awaitingApproval: true,
          payload: {
            eeatPending: { questions: q.questions, askedAt: new Date().toISOString() },
          },
        };
      }

      const articleModel = buildModel(ctx.modelConfig).withStructuredOutput(ArticleSchema, {
        name: 'seo_blog_article',
      });
      const messages = buildAgentMessages(systemWithResearch, input.messages, constraints);
      const article = (await articleModel.invoke(messages)) as ArticleDraft;

      const preview = renderArticleMarkdown(article, cfg);

      await ctx.emitLog('agent.draft.ready', article.progressNote, {
        title: article.title,
        language: article.language,
        bodyLength: article.bodyHtml.length,
        publishOnApprove: cfg.publishToShopify,
      });

      const result: AgentOutput = {
        message: preview,
        awaitingApproval: true,
        payload: { article, language: article.language, publishToShopify: cfg.publishToShopify },
      };

      if (cfg.publishToShopify) {
        const pendingToolCall: PendingToolCall = {
          id: 'shopify.publish_article',
          args: {
            title: article.title,
            bodyHtml: article.bodyHtml,
            summaryHtml: article.summaryHtml,
            tags: article.tags,
            ...(article.author ? { author: article.author } : {}),
          },
        };
        result.pendingToolCall = pendingToolCall;
      }

      return result;
    };

    return { tools: filteredTools, invoke };
  },
};

function renderQuestionsMarkdown(questions: EeatQuestion[]): string {
  return [
    '## EEAT Experience Questions',
    '',
    'Before I draft the article, could you share a bit about your first-hand experience? ' +
      "This helps ground the content in real expertise that competitors can't easily replicate.",
    '',
    ...questions.map(
      (q, i) =>
        `**${i + 1}. ${q.question}**${q.optional ? ' _(optional)_' : ''}${
          q.hint ? `\n   _${q.hint}_` : ''
        }`,
    ),
    '',
    "_Reply with your answers (skip optional ones if short on time). I'll draft the full article once you reply._",
  ].join('\n');
}

function renderArticleMarkdown(article: ArticleDraft, cfg: SeoWriterConfig): string {
  const publishLine = cfg.publishToShopify
    ? `**On approve:** publish to Shopify blog \`${cfg.blogHandle ?? '(first blog)'}\` as ${
        cfg.publishImmediately ? '`published`' : '`draft`'
      }`
    : '**On approve:** task closes as done; no publishing — copy the body below to use elsewhere.';

  return [
    `# ${article.title}`,
    '',
    `**Language:** ${article.language} · **Tags:** ${article.tags.join(', ')}${
      article.author ? ` · **Author:** ${article.author}` : ''
    }`,
    publishLine,
    '',
    `> ${article.summaryHtml}`,
    '',
    '---',
    '',
    article.bodyHtml,
    '',
    '_Approve to proceed; Feedback to ask for revisions._',
  ].join('\n');
}
