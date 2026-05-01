import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { buildModel } from '../../../llm/model-registry.js';
import type {
  AgentBuildContext,
  AgentInput,
  AgentOutput,
  AgentRunnable,
  IAgent,
} from '../../types.js';

const DEFAULT_PROMPT = `You are an SEO Writer AI employee for an e-commerce business.
Your job: produce ONE polished, multilingual blog article from a single brief.
Always:
- Output structured Markdown with clear H1/H2 hierarchy.
- Include a meta_title (<= 60 chars) and meta_description (<= 155 chars).
- Honor any tone/keyword/forbidden constraints in the brief.
- Stay focused on the single topic in the brief — do NOT propose other articles.
When you finish a draft, return it and request approval — never auto-publish.`;

const configSchema = z.object({
  targetLanguages: z
    .array(z.enum(['zh-TW', 'zh-CN', 'en', 'ja', 'ko']))
    .min(1)
    .default(['zh-TW'])
    .describe('Languages to produce content in (multiple → multilingual output)'),
  brandTone: z
    .string()
    .optional()
    .describe('Free-form tone description, e.g. "warm, professional, slightly playful"'),
  bannedPhrases: z.array(z.string()).default([]).describe('Phrases the agent must never use'),
  preferredKeywords: z
    .array(z.string())
    .default([])
    .describe('Keywords the agent should weave in when natural'),
});

type SeoWriterConfig = z.infer<typeof configSchema>;

export const seoWriterAgent: IAgent = {
  manifest: {
    id: 'seo-writer',
    name: 'AI SEO Writer',
    description: 'Writes a single multilingual SEO article from a focused brief.',
    availableInPlans: ['basic', 'pro', 'flagship'],
    defaultModel: { model: 'anthropic/claude-opus-4.7', temperature: 0.4 },
    defaultPrompt: DEFAULT_PROMPT,
    toolIds: [],
    requiredCredentials: [],
    configSchema,
  },

  build(ctx: AgentBuildContext): AgentRunnable {
    const cfg = configSchema.parse(ctx.agentConfig ?? {}) as SeoWriterConfig;
    const model = buildModel(ctx.modelConfig);

    const invoke = async (input: AgentInput): Promise<AgentOutput> => {
      await ctx.emitLog('agent.started', `SEO Writer starting on task ${ctx.taskId}`, {
        languages: cfg.targetLanguages,
      });

      const constraints: string[] = [];
      if (cfg.brandTone) constraints.push(`Tone: ${cfg.brandTone}`);
      if (cfg.preferredKeywords.length > 0) {
        constraints.push(`Preferred keywords: ${cfg.preferredKeywords.join(', ')}`);
      }
      if (cfg.bannedPhrases.length > 0) {
        constraints.push(`Avoid phrases: ${cfg.bannedPhrases.join(', ')}`);
      }
      constraints.push(`Target languages: ${cfg.targetLanguages.join(', ')}`);

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

      const response = await model.invoke(messages);
      const text =
        typeof response.content === 'string' ? response.content : JSON.stringify(response.content);

      await ctx.emitLog('agent.draft.ready', 'SEO draft ready, awaiting approval', {
        length: text.length,
      });

      return {
        message: text,
        awaitingApproval: true,
        payload: { draft: text, languages: cfg.targetLanguages },
      };
    };

    return { tools: [], invoke };
  },
};
