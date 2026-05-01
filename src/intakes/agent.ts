import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { agentRegistry } from '../agents/registry.js';
import type { IntakeMessage } from '../db/schema/index.js';
import { buildModel } from '../llm/model-registry.js';

/**
 * The intake agent runs OUTSIDE the supervisor LangGraph. It is a lightweight,
 * stateless turn-taker whose only job is to clarify a fuzzy ask from the boss
 * into a brief that the real worker agents can run with. It never touches the
 * tasks table, never fires tools, never persists checkpoints.
 *
 * Output shape lets the API layer:
 *   - render `reply` as the next assistant turn,
 *   - cache `draftBrief` / `draftTitle` so the UI can show "目前我理解你要做..."
 *   - flip a "建立任務" button on when `readyToFinalize=true`.
 */
const IntakeOutputSchema = z.object({
  reply: z
    .string()
    .min(1)
    .describe(
      'The next assistant turn shown to the boss in the chat. Use zh-TW, conversational, ' +
        'like a smart secretary. Ask one focused follow-up question if anything is unclear, ' +
        'or summarise what you have and propose finalising.',
    ),
  draftTitle: z
    .string()
    .min(1)
    .max(120)
    .describe(
      'Short kanban-card title (under 120 chars) that captures the task as currently understood. ' +
        'Always emit your best current guess — never blank.',
    ),
  draftBrief: z
    .string()
    .min(1)
    .describe(
      'Self-contained brief the worker agent will receive as task.input.brief. Always emit your ' +
        'current best version — even early in the conversation. The boss can preview it live.',
    ),
  readyToFinalize: z
    .boolean()
    .describe(
      'True only when the brief is concrete enough that a worker agent could start without further ' +
        'clarification: clear goal, target/audience if relevant, deliverable type, any hard constraints. ' +
        'Default to false when in doubt — the boss can always force-finalise.',
    ),
  missingInfo: z
    .array(z.string())
    .default([])
    .describe(
      'Short bullet list of what is still unclear. Empty when readyToFinalize=true. Used by the UI ' +
        'as a checklist beside the chat.',
    ),
});

export type IntakeAgentOutput = z.infer<typeof IntakeOutputSchema>;

const DEFAULT_PROMPT = `你是 AI 自動化平台的「任務接案助理」。老闆會用很模糊的話描述他想做的事，你的工作是：

1. 用 zh-TW、輕鬆但專業的語氣對話，每次只問 1～2 個最關鍵的釐清問題（不要一次列十題逼問）。
2. 在每一輪同時更新 draftTitle / draftBrief —— 即使資訊還不完整，也要寫出當下最佳版本，讓老闆隨時看得到「目前 AI 理解的任務長什麼樣」。
3. 確認以下都清楚了，才把 readyToFinalize 設為 true：
   - 任務目標（要產出什麼？要達成什麼？）
   - 範圍 / 數量（一篇？五篇？單品還是全店？）
   - 任何硬性限制（語言、deadline、品牌調性、不能碰的東西）
   - 如果適合的話，建議一個 assignedAgent（從下面 Available worker agents 清單）
4. 如果老闆已經給夠了資訊，不要硬擠多餘的問題 —— 直接 readyToFinalize=true，並在 reply 裡簡潔複述任務、邀請按下「建立任務」。
5. 你 **不需要** 自己執行任務，也不要承諾「我來幫你做」—— 你只負責確認任務內容。
6. missingInfo 是給 UI 顯示的待補清單，readyToFinalize=true 時必須清空。

不要編造老闆沒講的細節。寧可問清楚，不要假設。`;

export interface IntakeAgentDeps {
  /**
   * Available worker agents for this tenant. Used to give the intake agent a
   * sense of what the platform can actually do, so it can suggest reasonable
   * `assignedAgent`s and reject asks that don't match any available worker.
   */
  availableAgents: { id: string; name: string; description: string }[];
  /** Override the default model — primarily for tests. */
  model?: BaseChatModel;
}

/**
 * Run a single intake turn.
 *
 * @param history Full conversation so far (excluding the new user message).
 * @param newUserMessage The boss's latest message.
 */
export async function runIntakeTurn(
  history: IntakeMessage[],
  newUserMessage: string,
  deps: IntakeAgentDeps,
): Promise<IntakeAgentOutput> {
  const baseModel =
    deps.model ?? buildModel({ model: 'anthropic/claude-sonnet-4.6', temperature: 0.4 });
  const model = baseModel.withStructuredOutput(IntakeOutputSchema, {
    name: 'intake_clarification',
  });

  const roster =
    deps.availableAgents.length > 0
      ? deps.availableAgents.map((a) => `- ${a.id}: ${a.description}`).join('\n')
      : '(no worker agents are enabled yet — note this in your reply if the user asks for execution)';

  const system = `${DEFAULT_PROMPT}

Available worker agents (suggest one if appropriate):
${roster}`;

  const messages = [
    new SystemMessage(system),
    ...history.map((m) =>
      m.role === 'user'
        ? new HumanMessage(m.content)
        : new HumanMessage(`(assistant) ${m.content}`),
    ),
    new HumanMessage(newUserMessage),
  ];

  const result = (await model.invoke(messages)) as IntakeAgentOutput;
  return result;
}

/**
 * Convenience: pull the available-agent roster for a tenant from the registry.
 * Mirrors the data shape `runIntakeTurn` consumes so route handlers don't have
 * to peek into the registry directly.
 */
export async function loadAvailableAgentsForTenant(
  tenantId: string,
): Promise<IntakeAgentDeps['availableAgents']> {
  const agents = await agentRegistry.listForTenant(tenantId);
  return agents.map((a) => ({
    id: a.manifest.id,
    name: a.manifest.name,
    description: a.manifest.description,
  }));
}
