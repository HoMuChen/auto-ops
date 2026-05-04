import { z } from 'zod';
import { env } from '../../../config/env.js';
import { SerpCache } from '../../../integrations/serper/cache.js';
import { SerperClient } from '../../../integrations/serper/client.js';
import { buildSerperTools } from '../../../integrations/serper/tools.js';
import { WebFetchClient } from '../../../integrations/web/client.js';
import { buildWebFetchTools } from '../../../integrations/web/tools.js';
import { buildAgentMessages } from '../../lib/messages.js';
import { runToolLoop } from '../../lib/tool-loop.js';
import type {
  AgentBuildContext,
  AgentInput,
  AgentOutput,
  AgentRunnable,
  IAgent,
} from '../../types.js';

const DEFAULT_PROMPT = `You are a Market Researcher AI employee for an e-commerce business.
Your job: produce ONE comprehensive market research report from the user's brief
and return it as the structured object requested. The report is the deliverable —
the user reviews it and either approves (task done) or asks for refinements.

Research workflow (search-then-read):
1. Call serper_search 2-4 times from different angles to map the landscape.
   Examples: "<category> 競爭", "<category> 市場規模", "<category> 痛點",
   "<category> 趨勢", "<category> 評論". Different queries surface different
   results — don't waste searches on minor variants of the same phrase.
2. From the SERP results, pick 3-6 of the most relevant URLs and call web_fetch
   on each to read the full content. Focus on: industry analyses, comparison
   reviews, top competitor product pages, news/feature articles. Do NOT fetch
   every result — each fetch costs latency and tokens. Skip thin pages
   (listings, splash homepages without analysis).
3. Synthesize. Cross-reference what multiple sources say. Cite specifics
   (pricing, feature names, review themes) from the fetched content, not from
   snippets alone. Note where sources disagree.

Report structure (the markdown body in the \`report\` field):
- ## 市場概況 — size, growth, geography, time-frame
- ## 主要競品 — 3-8 competitors with positioning, pricing tier, key strengths/weaknesses
- ## 市場缺口 — observed unmet needs, underserved segments, weak product-market fit
- ## 消費者趨勢 — emerging behaviors, demand shifts, social signals
- ## 切入建議 — concrete strategic recommendations, ranked by feasibility

Tone: like an analyst writing a memo to the boss. Use the language specified
in tenant constraints (default zh-TW). Length: 600-2000 words in target
language. Avoid filler. Cite findings inline like (來源: example.com).
List every URL you fetched (and any other URL you cite) in the \`sources\`
field — the framework renders the source list separately.

progressNote: one-liner for the kanban timeline. Don't duplicate the report —
say what you focused on or what stood out.

Submit the final report via submit_report when ready.`;

const configSchema = z
  .object({
    defaultLanguage: z
      .enum(['zh-TW', 'zh-CN', 'en', 'ja', 'ko'])
      .default('zh-TW')
      .describe('Output language for the report when the brief does not specify.'),
    searchLocale: z
      .string()
      .default('tw')
      .describe(
        'Default Serper search locale (geo), e.g. "tw", "us", "jp". The agent may override per-query.',
      ),
  })
  .default({});

type MarketResearcherConfig = z.infer<typeof configSchema>;

const ReportSchema = z.object({
  report: z
    .string()
    .min(300)
    .max(8000)
    .describe(
      'Full market research report in Markdown. Sections: ## 市場概況 / ## 主要競品 / ## 市場缺口 / ## 消費者趨勢 / ## 切入建議. ' +
        '600-2000 words in the target language. Cite sources inline like (來源: example.com).',
    ),
  sources: z
    .array(z.string().url())
    .max(30)
    .describe(
      'Every URL you cited or fetched. The framework renders this as the sources panel; do NOT also list URLs in the report body to avoid duplication.',
    ),
  progressNote: z
    .string()
    .min(10)
    .max(200)
    .describe(
      '一句話對老闆回報這份研究的重點或意外發現。' +
        '例：「報告好了，這個品類最大缺口是中價位的設計感商品，老闆看一下切入建議」。' +
        '用 zh-TW 第一人稱，對話對象是「老闆」，不要寫成翻譯腔。',
    ),
});

export const marketResearcherAgent: IAgent = {
  manifest: {
    id: 'market-researcher',
    name: '市場研究員',
    description:
      '市場研究的入口；產出一份結構化 markdown 研究報告，' +
      '透過 serper 搜尋 + web 讀取競品/分析文章，' +
      '輸出市場概況、競品、缺口、趨勢、切入建議。不寫文章、不上架。',
    defaultModel: { model: 'anthropic/claude-sonnet-4.6', temperature: 0.3 },
    defaultPrompt: DEFAULT_PROMPT,
    requiredCredentials: [],
    configSchema,
  },

  async build(ctx: AgentBuildContext): Promise<AgentRunnable> {
    const cfg = configSchema.parse(ctx.agentConfig ?? {}) as MarketResearcherConfig;

    const serperKey = env.SERPER_API_KEY;
    const serperTools = serperKey
      ? buildSerperTools({
          tenantId: ctx.tenantId,
          cache: new SerpCache(new SerperClient({ apiKey: serperKey })),
        })
      : [];
    const webFetchTools = buildWebFetchTools({ client: new WebFetchClient() });

    const invoke = async (input: AgentInput): Promise<AgentOutput> => {
      await ctx.emitLog('agent.started', '開始研究市場，給我幾分鐘', {
        searchAvailable: serperTools.length > 0,
      });

      const constraints: string[] = [
        `Output language: ${cfg.defaultLanguage}`,
        `Default search locale: ${cfg.searchLocale}`,
      ];

      const messages = await buildAgentMessages(
        ctx.systemPrompt,
        input.messages,
        constraints,
        input.imageResolver,
      );

      // Researcher needs more research budget than writer: 2-4 searches +
      // 3-6 fetches + 1 submit ≈ 6-11 hops. maxHops 14 leaves headroom for
      // the model to follow up on a surprising finding without exhausting.
      const result = await runToolLoop({
        modelConfig: ctx.modelConfig,
        messages,
        tools: [...serperTools, ...webFetchTools],
        maxHops: 14,
        emitLog: ctx.emitLog,
        finalAnswer: {
          schema: ReportSchema,
          name: 'submit_report',
          description:
            'Call this exactly once when your research is complete. The args ARE the final research report shown to the user for approval.',
          // Force at least one search hop when serper is available — a
          // training-data-only "research" report is the failure mode.
          minToolHops: serperTools.length > 0 ? 1 : 0,
        },
      });

      if (result.kind !== 'submitted') {
        throw new Error(
          'Market Researcher did not submit a report within the tool loop budget — model emitted free-form content without calling submit_report.',
        );
      }
      const report = result.value;

      await ctx.emitLog('agent.report.ready', report.progressNote, {
        artifactShape: 'report',
        sourceCount: report.sources.length,
        reportLength: report.report.length,
      });

      return {
        message: report.progressNote,
        awaitingApproval: true,
        artifact: {
          report: report.report,
          refs: { sources: report.sources, sourceCount: report.sources.length },
        },
      };
    };

    return { tools: [], invoke };
  },
};
