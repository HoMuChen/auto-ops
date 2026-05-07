import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { invokeStructured } from '../../lib/invoke-structured.js';
import { buildAgentMessages } from '../../lib/messages.js';
import { loadPacks } from '../../lib/packs.js';
import { skillsToggleSchema } from '../../lib/skills-schema.js';
import type {
  AgentBuildContext,
  AgentInput,
  AgentOutput,
  AgentRunnable,
  IAgent,
} from '../../types.js';

const DEFAULT_PROMPT = `You are an EEAT Interviewer AI employee for an e-commerce business.
Your job: read the brief and decide what specific, lived-experience questions
the boss must answer so the downstream article writer can ground the article
in real, defensible expertise (Experience, Expertise, Authoritativeness,
Trustworthiness — the EEAT pillars Google ranks on).

Output rules:
- Ask 1–5 concrete, answerable questions. Specific numbers and lived
  experiences only — never generic "what's your opinion on X" prompts.
- Each question must be answerable in 1–3 sentences by the boss in chat.
- Mark genuinely optional questions as optional=true; don't gate the article
  on a question that's nice-to-have.
- progressNote is one short sentence for the kanban timeline.
- narrative explains to the boss WHY you need this experience and how you'll
  use it. Do NOT list the questions in narrative — the agent renders them
  separately as a numbered list.`;

const configSchema = z.object({
  skills: skillsToggleSchema,
});

const EeatQuestionsSchema = z.object({
  questions: z
    .array(
      z.object({
        question: z.string().min(5).describe('Concrete experience question to the boss.'),
        hint: z.string().nullish().catch(null),
        optional: z.boolean().nullish().catch(false),
      }),
    )
    .min(1)
    .max(5),
  narrative: z
    .string()
    .min(20)
    .max(2000)
    .describe(
      '為什麼需要老闆親身經驗 + 你打算怎麼用這些答案。zh-TW Markdown。' +
        '不要在 narrative 裡列出問題本身 — agent 會在後面用 markdown 列出問題。',
    ),
  progressNote: z.string().min(10).max(200),
});

export const eeatInterviewerAgent: IAgent = {
  manifest: {
    id: 'eeat-interviewer',
    name: 'EEAT 訪談員',
    description:
      '在寫文章前先問老闆 1–5 個 EEAT 親身經驗問題，把答案存成 task feedback 供下游撰稿員引用。' +
      '配對 article-writer 使用最完整 — 多數情況下會被 seo-article-with-eeat workflow 自動串接。',
    defaultModel: { model: 'anthropic/claude-sonnet-4.6', temperature: 0.4 },
    defaultPrompt: DEFAULT_PROMPT,
    toolIds: [],
    requiredCredentials: [],
    configSchema,
    metadata: { kind: 'execution', shape: 'atomic' },
  },

  async build(ctx: AgentBuildContext): Promise<AgentRunnable> {
    const cfg = configSchema.parse(ctx.agentConfig ?? {});

    const packsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'packs');
    const packsBlock = await loadPacks({
      builtInDir: packsDir,
      builtInEnabled: cfg.skills,
      tenantId: ctx.tenantId,
      agentId: 'eeat-interviewer',
    });
    const systemPrompt = packsBlock ? `${packsBlock}\n\n${ctx.systemPrompt}` : ctx.systemPrompt;

    const invoke = (input: AgentInput) => runEeatInterviewer(ctx, systemPrompt, input);
    return { tools: [], invoke };
  },
};

export async function runEeatInterviewer(
  ctx: AgentBuildContext,
  systemPrompt: string,
  input: AgentInput,
): Promise<AgentOutput> {
  await ctx.emitLog('agent.started', '我先想幾個 EEAT 問題請老闆回答', {});

  const messages = await buildAgentMessages(
    systemPrompt,
    input.messages,
    undefined,
    input.imageResolver,
  );
  const q = await invokeStructured(
    ctx.modelConfig,
    EeatQuestionsSchema,
    'eeat_questions',
    messages,
    undefined,
    ctx.logCtx,
  );

  const askedAt = new Date().toISOString();
  const questionList = q.questions
    .map((qu, i) => {
      const hint = qu.hint ? ` — ${qu.hint}` : '';
      const optional = qu.optional ? ' *(選填)*' : '';
      return `${i + 1}. **${qu.question}**${hint}${optional}`;
    })
    .join('\n');

  // Layout: H2 → narrative → numbered list → CTA. Schema's narrative
  // description forbids listing questions in narrative to avoid duplication.
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
    payload: { eeatPending: { questions: q.questions, askedAt } },
    // Schema name MUST be in src/orchestrator/report-writer.ts:REPORT_SKIP_SCHEMAS.
    // The interviewer's artifact.report (above) IS the boss-facing surface;
    // report-writer would clobber it with a meta-summary if not skipped.
    structuredOutput: {
      schemaName: 'eeat-questions',
      data: { questions: q.questions, askedAt },
    },
  };
}

export { EeatQuestionsSchema };
