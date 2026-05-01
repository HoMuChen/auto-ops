import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { buildShopifyTools } from '../../../integrations/shopify/tools.js';
import { buildModel } from '../../../llm/model-registry.js';
import type {
  AgentBuildContext,
  AgentInput,
  AgentOutput,
  AgentRunnable,
  IAgent,
  PendingToolCall,
} from '../../types.js';

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
- Stay focused on the single topic — do NOT propose other articles.`;

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

  // Publishing config — controls what happens on approve(finalize=true).
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
});

type SeoWriterConfig = z.infer<typeof configSchema>;

/**
 * Structured article the LLM produces. Maps onto Shopify's Admin REST
 * `POST /blogs/:id/articles.json` body (the framework adds the rest).
 */
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
});

type ArticleDraft = z.infer<typeof ArticleSchema>;

export const shopifyBlogWriterAgent: IAgent = {
  manifest: {
    id: 'shopify-blog-writer',
    name: 'AI Shopify Blog Writer',
    description:
      'Writes a single multilingual SEO blog article from a focused brief and ' +
      'publishes it to the tenant Shopify blog after human approval.',
    defaultModel: { model: 'anthropic/claude-opus-4.7', temperature: 0.4 },
    defaultPrompt: DEFAULT_PROMPT,
    // The publish tool needs Shopify creds; surfaced as a static tool id so
    // the activation UI can preview the capability.
    toolIds: ['shopify.publish_article'],
    // Listed even though it's only required when publishToShopify=true (the
    // default). The activation gate will block until creds are bound; users
    // who don't want publishing should disable publishToShopify in the agent
    // config — see runtime check in build().
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
    const model = buildModel(ctx.modelConfig).withStructuredOutput(ArticleSchema, {
      name: 'seo_blog_article',
    });

    // Tools are built unconditionally — the closure captures tenantId/config
    // but doesn't fetch Shopify credentials until the tool is actually invoked
    // (after HITL approval). Building is therefore credential-free.
    const tools = await buildShopifyTools(ctx.tenantId, {
      ...(cfg.credentialLabel ? { credentialLabel: cfg.credentialLabel } : {}),
      ...(cfg.blogHandle ? { blogHandle: cfg.blogHandle } : {}),
      ...(cfg.defaultAuthor ? { defaultAuthor: cfg.defaultAuthor } : {}),
      publishArticleImmediately: cfg.publishImmediately,
    });

    // Whitelist this agent only to publish_article — create_product belongs
    // to shopify-ops, not the writer.
    const filteredTools = tools.filter((t) => t.id === 'shopify.publish_article');

    const invoke = async (input: AgentInput): Promise<AgentOutput> => {
      await ctx.emitLog(
        'agent.started',
        `Shopify Blog Writer drafting article for task ${ctx.taskId}`,
        {
          publishToShopify: cfg.publishToShopify,
          blogHandle: cfg.blogHandle ?? '(default)',
        },
      );

      const constraints: string[] = [];
      if (cfg.brandTone) constraints.push(`Tone: ${cfg.brandTone}`);
      if (cfg.preferredKeywords.length > 0) {
        constraints.push(`Preferred keywords: ${cfg.preferredKeywords.join(', ')}`);
      }
      if (cfg.bannedPhrases.length > 0) {
        constraints.push(`Avoid phrases: ${cfg.bannedPhrases.join(', ')}`);
      }
      constraints.push(`Writer fluent in: ${cfg.targetLanguages.join(', ')}`);

      const systemMessage =
        constraints.length > 0
          ? `${ctx.systemPrompt}\n\nTenant constraints:\n- ${constraints.join('\n- ')}`
          : ctx.systemPrompt;

      const messages = [
        new SystemMessage(systemMessage),
        ...input.messages.map((m) =>
          m.role === 'user' ? new HumanMessage(m.content) : new HumanMessage(m.content),
        ),
      ];

      const article = (await model.invoke(messages)) as ArticleDraft;

      const preview = renderArticleMarkdown(article, cfg);

      await ctx.emitLog('agent.draft.ready', 'SEO article ready, awaiting approval', {
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

      // Only attach a pending tool call when publishing is enabled. With
      // publishToShopify=false the task just transitions to done on approve
      // (writer-as-drafter mode) — useful for tenants without Shopify or for
      // one-off content the user will export elsewhere.
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
