import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { logger } from '../lib/logger.js';
import { buildModel } from '../llm/model-registry.js';
import type { ModelConfig } from '../llm/types.js';
import type { GraphState } from './state.js';

/**
 * Schemas whose output is NOT a retrospective summary — for these, the
 * agent's own artifact.report (the question prompt, the action invitation)
 * is the right thing for the boss to see, not a meta-narration of it.
 */
const REPORT_SKIP_SCHEMAS = new Set<string>(['eeat-questions']);

const REPORT_MODEL: ModelConfig = {
  model: 'anthropic/claude-haiku-4-5',
  temperature: 0.4,
};

const SYSTEM_PROMPT = `你是這個團隊的敘述者。基於 agent 剛產出的結構化資料，寫一段給老闆看的 zh-TW 繁體中文 Markdown 匯報。
語氣：員工書面回報老闆，300-800 字，可用 ## / ### 子標題、**粗體**、- 條列。
重點放在：
1. 我做了什麼決定
2. 為什麼這樣選
3. 老闆要特別看哪裡
不要逐字背誦結構化資料的內容（老闆會直接看 artifact）。`;

function buildUserPrompt(input: {
  brief: string;
  agentId: string;
  schemaName: string;
  data: Record<string, unknown>;
  keyDecisions?: string[];
}): string {
  const decisionsBlock = input.keyDecisions?.length
    ? `\n關鍵決策（agent 自述）:\n${input.keyDecisions.map((d) => `- ${d}`).join('\n')}`
    : '';
  return `任務 brief: ${input.brief}
Agent: ${input.agentId}
產出類型: ${input.schemaName}

結構化資料:
${JSON.stringify(input.data, null, 2)}${decisionsBlock}`;
}

/**
 * Boundary node that turns an agent's structured output into boss-facing
 * markdown prose. Wired so the supervisor routes here whenever the next
 * step would have been END or HITL pause — every other hop bypasses it.
 *
 * No-ops (returns `{}`) when:
 *   - `state.lastStructuredOutput` is null (supervisor clarification path —
 *      no agent ran)
 *   - the schemaName is in REPORT_SKIP_SCHEMAS (e.g. eeat-interviewer's
 *      question prompt — agent's hand-written `artifact.report` IS the
 *      boss-facing output and must survive intact)
 *
 * On normal paths, calls a small LLM to render the report and writes it
 * to `state.lastOutput.artifact.report`. Failure is non-fatal: a fallback
 * line is written + a warn log emitted; the task lifecycle is never
 * blocked by report-writer's own errors.
 */
export async function runReportWriter(state: GraphState): Promise<Partial<GraphState>> {
  const sout = state.lastStructuredOutput;
  if (!sout) return {};
  if (REPORT_SKIP_SCHEMAS.has(sout.schemaName)) return {};

  const briefMessage = state.messages[0];
  const brief =
    typeof briefMessage?.content === 'string'
      ? briefMessage.content
      : JSON.stringify(briefMessage?.content ?? '');

  let reportMarkdown: string;
  try {
    const model = buildModel(REPORT_MODEL);
    const response = await model.invoke([
      new SystemMessage(SYSTEM_PROMPT),
      new HumanMessage(
        buildUserPrompt({
          brief,
          agentId: sout.agentId,
          schemaName: sout.schemaName,
          data: sout.data,
          ...(sout.keyDecisions ? { keyDecisions: sout.keyDecisions } : {}),
        }),
      ),
    ]);
    reportMarkdown =
      typeof response.content === 'string' ? response.content : JSON.stringify(response.content);
  } catch (err) {
    // Report-writer failures must never block task delivery. Log warn,
    // write a short fallback so the boss isn't left staring at a missing
    // section, and let the graph continue to END.
    logger.warn(
      { err, taskId: state.taskId, agentId: sout.agentId, schemaName: sout.schemaName },
      'report-writer LLM call failed — using fallback prose',
    );
    reportMarkdown = '> ⚠️ 匯報生成失敗。請直接看下方 artifact 內容，或重新觸發 task。';
  }

  // Preserve everything else on lastOutput; only fill in artifact.report.
  const prevArtifact = state.lastOutput?.artifact ?? {};
  return {
    lastOutput: state.lastOutput
      ? {
          ...state.lastOutput,
          artifact: { ...prevArtifact, report: reportMarkdown },
        }
      : null,
  };
}
