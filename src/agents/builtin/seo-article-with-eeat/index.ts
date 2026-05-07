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
import { loadPacks } from '../../lib/packs.js';
import { skillsToggleSchema } from '../../lib/skills-schema.js';
import type {
  AgentBuildContext,
  AgentInput,
  AgentOutput,
  AgentRunnable,
  IAgent,
} from '../../types.js';
import {
  type ArticleWriterConfig,
  articleWriterAgent,
  runArticleWriter,
} from '../article-writer/index.js';
import { eeatInterviewerAgent, runEeatInterviewer } from '../eeat-interviewer/index.js';

const configSchema = z.object({
  // EEAT toggle — when false, the workflow skips the interviewer and runs
  // article-writer directly. Equivalent to spawning article-writer as the
  // atomic agent, but the boss may prefer keeping the workflow registration
  // and toggling at config-time.
  eeatEnabled: z
    .boolean()
    .default(true)
    .describe(
      'When true (default), workflow asks EEAT questions before writing. ' +
        'When false, workflow goes straight to article-writer (the same as ' +
        'using the article-writer atomic agent directly).',
    ),

  // The remaining fields are forwarded verbatim to the inner article-writer.
  publishToShopify: z.boolean().default(true),
  blogHandle: z.string().nullish(),
  defaultAuthor: z.string().nullish(),
  publishImmediately: z.boolean().default(false),
  credentialLabel: z.string().nullish(),
  skills: skillsToggleSchema,
  generateCoverImage: z.boolean().default(false),
  coverImageStyle: z.string().nullish(),
});

type WorkflowConfig = z.infer<typeof configSchema>;

function toArticleWriterCfg(cfg: WorkflowConfig): ArticleWriterConfig {
  return {
    publishToShopify: cfg.publishToShopify,
    blogHandle: cfg.blogHandle ?? null,
    defaultAuthor: cfg.defaultAuthor ?? null,
    publishImmediately: cfg.publishImmediately,
    credentialLabel: cfg.credentialLabel ?? null,
    skills: cfg.skills,
    generateCoverImage: cfg.generateCoverImage,
    coverImageStyle: cfg.coverImageStyle ?? null,
  };
}

export const seoArticleWithEeatAgent: IAgent = {
  manifest: {
    id: 'seo-article-with-eeat',
    name: 'SEO 文章 + EEAT 訪談',
    description:
      '兩階段文章工作流：先問老闆 EEAT 親身經驗問題、等回覆後再寫文章。' +
      '適合：單篇深度長文，老闆有具體實戰經驗想塞進文章但不想自己編排問題。' +
      '不適合：策略師批次派發的多篇 (請改用 article-writer 直接寫)。',
    defaultModel: { model: 'anthropic/claude-sonnet-4.6', temperature: 0.4 },
    defaultPrompt: '',
    toolIds: ['shopify.publish_article'],
    requiredCredentials: [
      {
        provider: 'shopify',
        description: 'Shopify Admin API token + store URL — needed to publish blog articles',
        setupUrl: 'https://help.shopify.com/en/manual/apps/app-types/custom-apps',
      },
    ],
    configSchema,
    metadata: { kind: 'execution', shape: 'workflow' },
  },

  async build(ctx: AgentBuildContext): Promise<AgentRunnable> {
    const cfg = configSchema.parse(ctx.agentConfig ?? {});

    // Resolve the article-writer's deps once at build time.
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

    // Both inner agents have their own packs; load each separately so each
    // inner run sees the right pack block + the right manifest prompt.
    const articleWriterPacksDir = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      'article-writer',
      'packs',
    );
    const interviewerPacksDir = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      'eeat-interviewer',
      'packs',
    );
    const articleWriterPacksBlock = await loadPacks({
      builtInDir: articleWriterPacksDir,
      builtInEnabled: cfg.skills,
      tenantId: ctx.tenantId,
      agentId: 'article-writer',
    });
    const interviewerPacksBlock = await loadPacks({
      builtInDir: interviewerPacksDir,
      builtInEnabled: cfg.skills,
      tenantId: ctx.tenantId,
      agentId: 'eeat-interviewer',
    });

    const articleWriterSystemPrompt = articleWriterPacksBlock
      ? `${articleWriterPacksBlock}\n\n${articleWriterAgent.manifest.defaultPrompt}`
      : articleWriterAgent.manifest.defaultPrompt;
    const interviewerSystemPrompt = interviewerPacksBlock
      ? `${interviewerPacksBlock}\n\n${eeatInterviewerAgent.manifest.defaultPrompt}`
      : eeatInterviewerAgent.manifest.defaultPrompt;

    const articleDeps = { serperTools, webFetchTools, imageTools };

    const invoke = async (input: AgentInput): Promise<AgentOutput> => {
      const out = (input.taskOutput ?? {}) as { eeatPending?: unknown };
      const eeatAsked = !!out.eeatPending;
      const lastMessage = input.messages[input.messages.length - 1];
      const eeatAnswered = lastMessage?.role === 'user';
      const skipEeat = !cfg.eeatEnabled;

      // Router (mirrors design §"Workflow sub-graph contract"):
      //   skipEeat                       → article-writer
      //   !eeatAsked                     → eeat-interviewer
      //   eeatAsked && eeatAnswered      → article-writer
      //   else (defensive fallback)      → article-writer
      if (skipEeat || (eeatAsked && eeatAnswered)) {
        return runArticleWriter(
          ctx,
          toArticleWriterCfg(cfg),
          articleWriterSystemPrompt,
          input,
          articleDeps,
        );
      }
      if (!eeatAsked) {
        return runEeatInterviewer(ctx, interviewerSystemPrompt, input);
      }
      return runArticleWriter(
        ctx,
        toArticleWriterCfg(cfg),
        articleWriterSystemPrompt,
        input,
        articleDeps,
      );
    };

    return { tools: filteredTools, invoke };
  },
};
