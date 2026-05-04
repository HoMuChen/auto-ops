import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { env } from '../../../config/env.js';
import { CloudflareImagesClient } from '../../../integrations/cloudflare/images-client.js';
import { insertImage } from '../../../integrations/cloudflare/images-repository.js';
import { OpenAIImagesClient } from '../../../integrations/openai-images/client.js';
import { buildImageTools } from '../../../integrations/openai-images/tools.js';
import { SerpCache } from '../../../integrations/serper/cache.js';
import { SerperClient } from '../../../integrations/serper/client.js';
import { buildSerperTools } from '../../../integrations/serper/tools.js';
import { buildShopifyTools } from '../../../integrations/shopify/tools.js';
import { invokeStructured } from '../../lib/invoke-structured.js';
import { markdownToHtml } from '../../lib/markdown.js';
import { buildAgentMessages } from '../../lib/messages.js';
import { loadPacks } from '../../lib/packs.js';
import { runToolLoop } from '../../lib/tool-loop.js';
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
- Body: clean Markdown. Use ## / ### headings, **bold**, *italic*, - bullets, > blockquote. Do NOT emit raw HTML — the framework converts at the Shopify publish boundary. Aim for 800–1500 words for top-of-funnel SEO posts.
- Summary: 1–2 sentence excerpt (<= 200 chars) used as the meta description
  and the blog index card.
- Tags: 3–8 short lower-case keywords.
- Honor any tone/keyword/forbidden-phrase constraints in the brief.
- Stay focused on the single topic — do NOT propose other articles.
- progressNote is one short sentence for the kanban timeline. report is the
  full memo for the boss-review panel. Don't duplicate them.

Research workflow (when serper_search is available):
- If the brief already contains keyword research (PAA questions, related
  searches, competitor angles, target word count) — typically when spawned
  by an SEO Strategist — skip serper_search and call submit_article directly.
- If the brief is a raw user request without research, call serper_search
  1–3 times to learn the SERP landscape (top-10 titles, PAA, related searches)
  before writing. Use findings to shape the article angle.
- Submit the final article via the submit_article tool when ready.

When the task is Stage 1 (EEAT questions), the agent prompt will explicitly ask you for questions; otherwise produce the article.`;

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
  generateCoverImage: z
    .boolean()
    .default(false)
    .describe('If true, agent generates a cover image for the article before approval.'),
  coverImageStyle: z
    .string()
    .nullish()
    .describe('Style hint for the cover image, e.g. "editorial, warm tones".'),
});

type SeoWriterConfig = z.infer<typeof configSchema>;

const ArticleSchema = z.object({
  title: z.string().min(1).max(140).describe('Article title shown on the blog and in feeds.'),
  body: z
    .string()
    .min(50)
    .describe(
      'Article body in Markdown. Use ## / ### headings, **bold**, *italic*, - bullets, ' +
        '> blockquote. Do NOT emit raw HTML. The framework converts to HTML at the ' +
        'Shopify publish boundary. 800–1500 words for top-of-funnel SEO posts.',
    ),
  summaryHtml: z
    .string()
    .min(20)
    .max(400)
    .describe(
      '1–2 sentence excerpt as plain HTML (or plain text — Shopify accepts either). ' +
        'Used as meta description and blog index card. Do not include block-level tags.',
    ),
  tags: z.array(z.string().min(1)).min(1).max(20).describe('Short keyword tags. 3–8 is ideal.'),
  language: z
    .enum(['zh-TW', 'zh-CN', 'en', 'ja', 'ko'])
    .describe('The language the article is written in.'),
  author: z.string().nullish().describe('Author byline. Leave blank to use the agent default.'),
  report: z
    .string()
    .min(80)
    .max(4000)
    .describe(
      '給老闆看的匯報。**用 zh-TW 繁體中文 + Markdown**。' +
        '說明：你的切入角度、為什麼選這個標題、E-E-A-T 強化點、特別考量。' +
        '可用 ## / ### 子標題、**粗體**、- 條列。' +
        '不要重複文章內容（boss 會直接看 body）。長度 200–800 字。' +
        '語氣像員工向老闆書面匯報。',
    ),
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

const EeatQuestionsSchema = z.object({
  questions: z
    .array(
      z.object({
        question: z.string().min(5).describe('Concrete experience question to the boss.'),
        hint: z.string().nullish().describe('Optional hint shown under the question.'),
        optional: z.boolean().nullish().describe('If true, boss may skip without blocking.'),
      }),
    )
    .min(1)
    .max(5),
  narrative: z
    .string()
    .min(20)
    .max(2000)
    .describe(
      '給老闆看的詳細說明。**用 zh-TW 繁體中文** + Markdown 格式。' +
        '說明：為什麼需要老闆親身經驗（這是 EEAT 加分項）、你打算怎麼用這些答案。' +
        '可用 ## / ### 子標題、**粗體**、- 條列。長度建議 100–500 字。' +
        '注意：不要在這段裡列出問題本身（agent 會在 narrative 後面用 markdown 列出問題）。',
    ),
  progressNote: z.string().min(10).max(200),
});

/**
 * Stage 1 fires when (1) the writer's `cfg.skills.eeat` is enabled, (2) the
 * task came from the SEO Strategist (signalled by `params.refs.primaryKeyword`)
 * AND (3) the boss hasn't yet answered the EEAT questions (`eeatPending` not
 * set). Tenants who disable the EEAT skill in writer config skip Stage 1
 * entirely; direct user-created tasks (no primaryKeyword) also skip.
 */
function shouldDoStage1(
  taskOutput: Record<string, unknown> | undefined,
  params: Record<string, unknown>,
  messages: AgentInput['messages'],
  eeatSkillEnabled: boolean,
): boolean {
  if (!eeatSkillEnabled) return false;
  const refs = (params as { refs?: { primaryKeyword?: unknown } }).refs;
  if (!refs?.primaryKeyword) return false;
  const pending = (taskOutput as { eeatPending?: unknown } | undefined)?.eeatPending;
  if (!pending) return true;
  if (messages[messages.length - 1]?.role === 'user') return false;
  throw new Error('eeatPending set but last message is not from user — double-execution guard');
}

export const shopifyBlogWriterAgent: IAgent = {
  manifest: {
    id: 'shopify-blog-writer',
    name: 'Shopify Blog Writer',
    description:
      'Writes a single multilingual SEO blog article from a focused brief and ' +
      'publishes it to the tenant Shopify blog after human approval.',
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
  },

  async build(ctx: AgentBuildContext): Promise<AgentRunnable> {
    const cfg = configSchema.parse(ctx.agentConfig ?? {}) as SeoWriterConfig;

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
            taskId: ctx.taskId,
          })
        : [];

    const tools = await buildShopifyTools(ctx.tenantId, {
      ...(cfg.credentialLabel ? { credentialLabel: cfg.credentialLabel } : {}),
      ...(cfg.blogHandle ? { blogHandle: cfg.blogHandle } : {}),
      ...(cfg.defaultAuthor ? { defaultAuthor: cfg.defaultAuthor } : {}),
      publishArticleImmediately: cfg.publishImmediately,
    });
    const filteredTools = tools.filter((t) => t.id === 'shopify.publish_article');

    // SERP research tools — used during Stage 2 article writing when the
    // brief lacks keyword research (direct user path). Strategy-spawned
    // children typically already have research baked into the writerBrief
    // and the model will skip serper_search per the prompt instructions.
    const serperKey = env.SERPER_API_KEY;
    const serperTools = serperKey
      ? buildSerperTools({
          tenantId: ctx.tenantId,
          cache: new SerpCache(new SerperClient({ apiKey: serperKey })),
        })
      : [];

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

      if (shouldDoStage1(input.taskOutput, input.params, input.messages, cfg.skills.eeat)) {
        const messages = await buildAgentMessages(
          systemPrompt,
          input.messages,
          constraints,
          input.imageResolver,
        );
        const q = await invokeStructured(
          ctx.modelConfig,
          EeatQuestionsSchema,
          'eeat_questions',
          messages,
        );
        const askedAt = new Date().toISOString();
        const questionList = q.questions
          .map((qu, i) => {
            const hint = qu.hint ? ` — ${qu.hint}` : '';
            const optional = qu.optional ? ' *(選填)*' : '';
            return `${i + 1}. **${qu.question}**${hint}${optional}`;
          })
          .join('\n');

        // Layout contract: H2 header → q.narrative (LLM's "why" prose, schema forbids
        // listing questions in this string) → numbered list rendered from q.questions
        // → CTA footer. If narrative drifts and lists questions too, the user sees
        // duplication; mitigated by EeatQuestionsSchema.narrative description.
        const report = `## 我需要先請你回答幾個問題

${q.narrative}

${questionList}

答完後我會把這些經驗融進文章裡。`;

        await ctx.emitLog('agent.questions.asked', q.progressNote, {
          artifactShape: 'report',
          count: q.questions.length,
        });

        return {
          message: q.progressNote,
          awaitingApproval: true,
          artifact: { report, refs: { askedAt } },
          payload: {
            eeatPending: { questions: q.questions, askedAt },
          },
        };
      }

      const messages = await buildAgentMessages(
        systemPrompt,
        input.messages,
        constraints,
        input.imageResolver,
      );

      // Single-pass tool loop. serper_search is optional research; when the
      // brief is comprehensive (strategy-spawned), the model goes straight to
      // submit_article. Direct-path tasks (no upstream research) trigger 1–3
      // search calls before submission. minToolHops=0 lets the model decide.
      const articleResult = await runToolLoop({
        modelConfig: ctx.modelConfig,
        messages,
        tools: serperTools,
        maxHops: 8,
        emitLog: ctx.emitLog,
        finalAnswer: {
          schema: ArticleSchema,
          name: 'submit_article',
          description:
            'Call this exactly once when the article is ready. The args ARE the final blog article — title, body (Markdown), summaryHtml, tags, language, optional author, plus your boss-review report and progressNote.',
          minToolHops: 0,
        },
      });

      if (articleResult.kind !== 'submitted') {
        throw new Error(
          'Shopify Blog Writer did not submit an article within the tool loop budget — model emitted free-form content without calling submit_article.',
        );
      }
      const article = articleResult.value;

      let coverImageUrl: string | undefined;
      if (cfg.generateCoverImage && imageTools.length > 0) {
        const genTool = imageTools.find((t) => t.id === 'images.generate');
        if (genTool) {
          const style = cfg.coverImageStyle ?? 'editorial blog cover, clean layout';
          const imgResult = (await genTool.tool.invoke({
            prompt: `Blog cover image for: "${article.title}". ${style}`,
          })) as { id: string; url: string };
          coverImageUrl = imgResult.url;
        }
      }

      await ctx.emitLog('agent.draft.ready', article.progressNote, {
        artifactShape: 'report+body',
        title: article.title,
        language: article.language,
        bodyLength: article.body.length,
        publishOnApprove: cfg.publishToShopify,
      });

      // Note: summaryHtml stays HTML (not markdown). Shopify's article excerpt
      // field accepts HTML or text and the LLM emits a short, safe excerpt;
      // markdown→HTML conversion would add a dependency for negligible benefit.
      const refs: Record<string, unknown> = {
        title: article.title,
        summaryHtml: article.summaryHtml,
        tags: article.tags,
        language: article.language,
        ...(article.author ? { author: article.author } : {}),
      };

      const result: AgentOutput = {
        message: article.progressNote,
        awaitingApproval: true,
        artifact: { report: article.report, body: article.body, refs },
        payload: { publishToShopify: cfg.publishToShopify },
      };

      if (cfg.publishToShopify) {
        const pendingToolCall: PendingToolCall = {
          id: 'shopify.publish_article',
          args: {
            title: article.title,
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
    };

    return { tools: filteredTools, invoke };
  },
};
