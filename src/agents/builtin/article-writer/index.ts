import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { env } from '../../../config/env.js';
import { buildTenantImageTools } from '../../../integrations/openai-images/build-tenant-image-tools.js';
import { SerpCache } from '../../../integrations/serper/cache.js';
import { SerperClient } from '../../../integrations/serper/client.js';
import { buildSerperTools } from '../../../integrations/serper/tools.js';
import { buildShopifyTools } from '../../../integrations/shopify/tools.js';
import { WebFetchClient } from '../../../integrations/web/client.js';
import { buildWebFetchTools } from '../../../integrations/web/tools.js';
import { markdownToHtml } from '../../lib/markdown.js';
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
  PendingToolCall,
} from '../../types.js';

const DEFAULT_PROMPT = `You are an Article Writer AI employee for an e-commerce business.
Your job: produce ONE polished, multilingual SEO blog article from a single brief
and return it as the structured object requested. The framework will publish
the article to the tenant's Shopify blog after the user reviews and approves.

Requirements:
- Title: <= 70 chars, include the primary keyword if natural.
- Slug: **English ASCII only**, kebab-case (lowercase a-z + 0-9 + hyphens), 3–7
  words, no Chinese / Japanese / Korean / accents / spaces / underscores.
  This is true even when the article body is zh-TW, ja, ko, etc. — Shopify
  uses this as the URL handle (\`/blogs/<blog>/<slug>\`), and a non-ASCII
  URL is bad SEO and ugly to share. Translate the primary keyword to English
  for the slug. Examples: "summer-linen-shirt-guide", "best-running-shoes-2026".
- Body: clean Markdown. Use ## / ### headings, **bold**, *italic*, - bullets,
  > blockquote. Do NOT emit raw HTML — the framework converts at the Shopify
  publish boundary. Aim for 800–1500 words for top-of-funnel SEO posts.
- Summary: 1–2 sentence excerpt (<= 200 chars) used as the meta description
  and the blog index card.
- Tags: 3–8 short lower-case keywords.
- Honor any tenant profile / brief constraints.
- Stay focused on the single topic — do NOT propose other articles.
- progressNote is one short sentence for the kanban timeline. keyDecisions is
  3–5 short bullets the report-writer can lean on; the boss-facing prose is
  rendered by a separate report-writer node, so do NOT write your own boss
  memo here.

Research workflow:
- If the brief already contains keyword research (PAA questions, related
  searches, competitor angles, target word count) — typically when spawned
  by an SEO Strategist — skip research and call submit_article directly.
- If the brief is a raw user request without research, do search-then-read:
  1. Call serper_search 1–3 times to learn the SERP landscape.
  2. Pick 2–3 of the most relevant organic URLs and call web_fetch on each.
  3. Skip web_fetch when the snippet alone is enough.
- Submit the final article via the submit_article tool when ready.

When the conversation includes prior EEAT answers from the user (a workflow
sub-graph case), weave the boss's specific experience into the article — that
real-life data is the EEAT differentiator.`;

const configSchema = z.object({
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
  skills: skillsToggleSchema,
  generateCoverImage: z
    .boolean()
    .default(false)
    .describe('If true, agent generates a cover image for the article before approval.'),
  coverImageStyle: z
    .string()
    .nullish()
    .describe('Style hint for the cover image, e.g. "editorial, warm tones".'),
});

type ArticleWriterConfig = z.infer<typeof configSchema>;

const ArticleSchema = z.object({
  title: z.string().min(1).max(140).describe('Article title shown on the blog and in feeds.'),
  slug: z
    .string()
    .min(3)
    .max(80)
    .regex(
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
      'slug must be English kebab-case: lowercase a-z, 0-9, and single hyphens only',
    )
    .describe(
      'URL slug used as the Shopify article handle. **English ASCII only**, kebab-case, 3–7 words.',
    ),
  body: z
    .string()
    .min(50)
    .describe(
      'Article body in Markdown. Use ## / ### headings, **bold**, *italic*, - bullets, > blockquote. ' +
        'Do NOT emit raw HTML. 800–1500 words for top-of-funnel SEO posts.',
    ),
  summaryHtml: z
    .string()
    .min(20)
    .max(400)
    .describe('1–2 sentence excerpt as plain HTML or text. Meta description + blog index card.'),
  tags: z.array(z.string().min(1)).min(1).max(20).describe('Short keyword tags. 3–8 is ideal.'),
  language: z.enum(['zh-TW', 'zh-CN', 'en', 'ja', 'ko']),
  author: z.string().nullish().catch(null),
  keyDecisions: z
    .array(z.string().min(5))
    .min(1)
    .max(5)
    .describe(
      '3–5 short bullets the downstream report-writer can lean on when generating boss prose. ' +
        'Examples: "從機能性切入而不是潮流", "開頭塞 EEAT 數字", "控制在 1500 字內". ' +
        'Be concrete about angle, EEAT hooks, and differentiation. Not boss-facing prose itself.',
    ),
  progressNote: z.string().min(10).max(200).describe('一句話對老闆回報。zh-TW 第一人稱。'),
});

interface ArticleWriterDeps {
  serperTools: ReturnType<typeof buildSerperTools>;
  webFetchTools: ReturnType<typeof buildWebFetchTools>;
  imageTools: ReturnType<typeof buildTenantImageTools>;
}

export const articleWriterAgent: IAgent = {
  manifest: {
    id: 'article-writer',
    name: '部落格文章撰寫員',
    description:
      '依聚焦 brief 撰寫一篇多語 SEO 部落格文章，' +
      '待人工核准後發布到租戶的 Shopify 部落格。' +
      '單純寫作，不主動詢問經驗 — 需要 EEAT 問答請改用 seo-article-with-eeat workflow。',
    defaultModel: { model: 'anthropic/claude-sonnet-4.6', temperature: 0.4 },
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
    metadata: { kind: 'execution', shape: 'atomic' },
  },

  async build(ctx: AgentBuildContext): Promise<AgentRunnable> {
    const cfg = configSchema.parse(ctx.agentConfig ?? {}) as ArticleWriterConfig;

    const imageTools = buildTenantImageTools({
      tenantId: ctx.tenantId,
      taskId: ctx.taskId,
      styleSuffix: ctx.tenantProfile.imageStyleSuffix || undefined,
    });

    const tools = await buildShopifyTools(ctx.tenantId, {
      ...(cfg.credentialLabel ? { credentialLabel: cfg.credentialLabel } : {}),
      ...(cfg.blogHandle ? { blogHandle: cfg.blogHandle } : {}),
      ...(cfg.defaultAuthor ? { defaultAuthor: cfg.defaultAuthor } : {}),
      publishArticleImmediately: cfg.publishImmediately,
    });
    const filteredTools = tools.filter((t) => t.id === 'shopify.publish_article');

    const serperKey = env.SERPER_API_KEY;
    const serperTools = serperKey
      ? buildSerperTools({
          tenantId: ctx.tenantId,
          cache: new SerpCache(new SerperClient({ apiKey: serperKey })),
        })
      : [];
    const webFetchTools = buildWebFetchTools({ client: new WebFetchClient() });

    const packsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'packs');
    const packsBlock = await loadPacks({
      builtInDir: packsDir,
      builtInEnabled: cfg.skills,
      tenantId: ctx.tenantId,
      agentId: 'article-writer',
    });
    const systemPrompt = packsBlock ? `${packsBlock}\n\n${ctx.systemPrompt}` : ctx.systemPrompt;

    const invoke = async (input: AgentInput): Promise<AgentOutput> => {
      return runArticleWriter(ctx, cfg, systemPrompt, input, {
        serperTools,
        webFetchTools,
        imageTools,
      });
    };

    return { tools: filteredTools, invoke };
  },
};

export async function runArticleWriter(
  ctx: AgentBuildContext,
  cfg: ArticleWriterConfig,
  systemPrompt: string,
  input: AgentInput,
  deps: ArticleWriterDeps,
): Promise<AgentOutput> {
  await ctx.emitLog('agent.started', '開始寫稿了，給我一點時間', {
    publishToShopify: cfg.publishToShopify,
    blogHandle: cfg.blogHandle ?? '(default)',
  });

  const messages = await buildAgentMessages(
    systemPrompt,
    input.messages,
    undefined,
    input.imageResolver,
  );

  const articleResult = await runToolLoop({
    modelConfig: ctx.modelConfig,
    messages,
    tools: [...deps.serperTools, ...deps.webFetchTools],
    maxHops: 10,
    emitLog: ctx.emitLog,
    logCtx: ctx.logCtx,
    finalAnswer: {
      schema: ArticleSchema,
      name: 'submit_article',
      description:
        'Call this exactly once when the article is ready. The args ARE the final blog article.',
      minToolHops: 0,
    },
  });

  if (articleResult.kind !== 'submitted') {
    throw new Error(
      'article-writer did not submit an article within the tool loop budget — model emitted free-form content without calling submit_article.',
    );
  }
  const article = articleResult.value;

  let coverImageUrl: string | undefined;
  if (cfg.generateCoverImage && deps.imageTools.length > 0) {
    const genTool = deps.imageTools.find((t) => t.id === 'images.generate');
    if (genTool) {
      const style = cfg.coverImageStyle ?? 'editorial blog cover, clean layout';
      const imgResult = (await genTool.tool.invoke({
        prompt: `Blog cover image for: "${article.title}". ${style}`,
      })) as { id: string; url: string };
      coverImageUrl = imgResult.url;
    }
  }

  await ctx.emitLog('agent.draft.ready', article.progressNote, {
    artifactShape: 'body+structuredOutput',
    title: article.title,
    language: article.language,
    bodyLength: article.body.length,
    publishOnApprove: cfg.publishToShopify,
  });

  const refs: Record<string, unknown> = {
    title: article.title,
    slug: article.slug,
    summaryHtml: article.summaryHtml,
    tags: article.tags,
    language: article.language,
    ...(article.author ? { author: article.author } : {}),
  };

  // NOTE: artifact.report intentionally absent — report-writer fills it in
  // by reading state.lastStructuredOutput.
  const result: AgentOutput = {
    message: article.progressNote,
    awaitingApproval: true,
    artifact: { body: article.body, refs },
    payload: { publishToShopify: cfg.publishToShopify },
    structuredOutput: {
      schemaName: 'article-draft',
      data: {
        title: article.title,
        slug: article.slug,
        body: article.body,
        summaryHtml: article.summaryHtml,
        tags: article.tags,
        language: article.language,
        ...(article.author ? { author: article.author } : {}),
        ...(coverImageUrl ? { coverImageUrl } : {}),
      },
      keyDecisions: article.keyDecisions,
    },
  };

  if (cfg.publishToShopify) {
    const pendingToolCall: PendingToolCall = {
      id: 'shopify.publish_article',
      args: {
        title: article.title,
        slug: article.slug,
        bodyHtml: markdownToHtml(article.body),
        summaryHtml: article.summaryHtml,
        tags: article.tags,
        ...(article.author ? { author: article.author } : {}),
        ...(coverImageUrl ? { coverImageUrl } : {}),
      },
    };
    result.pendingToolCall = pendingToolCall;
  }

  return result;
}

export { ArticleSchema, configSchema as articleWriterConfigSchema };
export type { ArticleWriterConfig, ArticleWriterDeps };
