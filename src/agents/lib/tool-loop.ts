import {
  type AIMessage,
  type BaseMessage,
  HumanMessage,
  ToolMessage,
} from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import type { ZodType } from 'zod';
import { logger } from '../../lib/logger.js';
import { buildModel } from '../../llm/model-registry.js';
import type { ModelConfig } from '../../llm/types.js';
import type { AgentTool } from '../types.js';

type EmitLog = (event: string, message: string, data?: Record<string, unknown>) => Promise<void>;

interface ToolLogFormatter {
  calling: (args: Record<string, unknown>) => { message: string; data?: Record<string, unknown> };
  result: (
    args: Record<string, unknown>,
    result: unknown,
  ) => { message: string; data?: Record<string, unknown> };
}

// Default log messages for known tools. Keyed by tool.name (the LangChain name).
const DEFAULT_FORMATTERS: Record<string, Partial<ToolLogFormatter>> = {
  serper_search: {
    calling: (args) => ({
      message: `搜尋關鍵字「${(args as { query?: string }).query ?? ''}」`,
      data: { query: (args as { query?: string }).query },
    }),
    result: (_args, result) => {
      const organic = (result as { organic?: unknown[] }).organic;
      return {
        message: `取得搜尋結果，共 ${organic?.length ?? 0} 筆`,
        data: { resultCount: organic?.length },
      };
    },
  },
  images_generate: {
    calling: (args) => ({
      message: '生成圖片中',
      data: { prompt: (args as { prompt?: string }).prompt },
    }),
    result: (_args, result) => ({
      message: '圖片生成完成',
      data: { url: (result as { url?: string }).url },
    }),
  },
  images_edit: {
    calling: (args) => ({
      message: '編輯圖片中',
      data: { prompt: (args as { prompt?: string }).prompt },
    }),
    result: (_args, result) => ({
      message: '圖片編輯完成',
      data: { url: (result as { url?: string }).url },
    }),
  },
};

export interface ToolCall {
  toolName: string;
  args: Record<string, unknown>;
  result: unknown;
}

/**
 * Synthetic "submit" tool config — when the model calls this tool, the loop
 * treats its args as the final structured answer and terminates. The tool's
 * handler is never executed; we intercept the call in the loop.
 *
 * This is the unified pattern for tool-calling agents that also need to
 * deliver structured output: instead of running the loop to collect research
 * and then re-invoking the model with `withStructuredOutput` (which makes the
 * model write the answer twice), the schema becomes a tool the model calls
 * once it's ready to finalize.
 */
export interface FinalAnswerConfig<T> {
  schema: ZodType<T>;
  /** Tool name exposed to the model. Defaults to 'submit'. */
  name?: string;
  /** Description nudging the model when to call it. */
  description?: string;
  /**
   * Refuse `submit` until the model has invoked at least this many other tools.
   * If the model submits early, we reply with a tool error and let it continue.
   * Default 0 (no minimum).
   */
  minToolHops?: number;
}

export interface ToolLoopOptions<T = never> {
  modelConfig: ModelConfig;
  messages: BaseMessage[];
  tools: AgentTool[];
  maxHops?: number;
  emitLog: EmitLog;
  /** Per-tool overrides merged on top of DEFAULT_FORMATTERS. Keyed by tool.name. */
  logFormatters?: Record<string, Partial<ToolLogFormatter>>;
  /**
   * If set, registers a synthetic submit tool from the schema. Calling that
   * tool terminates the loop and returns the parsed args as `value`. Without
   * this, the loop exits when the model emits content with no tool_calls
   * (legacy behaviour).
   */
  finalAnswer?: FinalAnswerConfig<T>;
}

interface BaseResult {
  collected: BaseMessage[];
  calls: ToolCall[];
}

export type ToolLoopResult<T = never> =
  | (BaseResult & { kind: 'submitted'; value: T })
  | (BaseResult & { kind: 'plain' });

/**
 * Runs a tool-calling loop up to `maxHops` rounds, emitting a task log before
 * and after every tool invocation so the user can follow along in real time.
 *
 * When `finalAnswer` is provided, the schema is bound as an additional tool;
 * the model calling it terminates the loop with the parsed args. This avoids
 * the wasteful "tool loop → withStructuredOutput" double-generation pattern,
 * where the model first emits a free-form analysis (Pass 1's tail) and is
 * then prompted to re-derive the same answer as JSON (Pass 2).
 */
export async function runToolLoop<T = never>({
  modelConfig,
  messages,
  tools,
  maxHops = 6,
  emitLog,
  logFormatters = {},
  finalAnswer,
}: ToolLoopOptions<T>): Promise<ToolLoopResult<T>> {
  const formatters = { ...DEFAULT_FORMATTERS, ...logFormatters };

  const submitName = finalAnswer?.name ?? 'submit';
  const submitTool = finalAnswer
    ? tool(
        // Never invoked — we intercept the call before LangChain dispatches it.
        async () => 'submitted',
        {
          name: submitName,
          description:
            finalAnswer.description ??
            'Call this exactly once when your work is complete. The args ARE your final structured deliverable.',
          schema: finalAnswer.schema as ZodType<unknown>,
        },
      )
    : null;

  const allTools: AgentTool[] = submitTool
    ? [...tools, { id: `__final__.${submitName}`, tool: submitTool }]
    : tools;

  const toolModel = (
    buildModel(modelConfig) as unknown as {
      bindTools: (tools: unknown[]) => { invoke: (msgs: BaseMessage[]) => Promise<AIMessage> };
    }
  ).bindTools(allTools.map((t) => t.tool));

  const collected: BaseMessage[] = [...messages];
  const calls: ToolCall[] = [];
  let submittedValue: T | undefined;
  const minHops = finalAnswer?.minToolHops ?? 0;

  for (let hop = 0; hop < maxHops; hop++) {
    const res = (await toolModel.invoke(collected)) as AIMessage;
    collected.push(res);

    // Diagnostic: pino-only (NOT emitLog — would pollute the kanban timeline).
    // Lets us tell whether the model is writing the answer as content rather
    // than via the submit tool. Visible in dev terminal at LOG_LEVEL=debug.
    const contentLen =
      typeof res.content === 'string' ? res.content.length : JSON.stringify(res.content).length;
    const toolNames = (res.tool_calls ?? []).map((c) => c.name);
    logger.debug(
      {
        component: 'tool-loop',
        hop,
        contentChars: contentLen,
        toolCalls: toolNames,
        ...(contentLen > 0 && contentLen < 300
          ? { contentPreview: typeof res.content === 'string' ? res.content : '' }
          : {}),
      },
      `hop ${hop}: ${toolNames.length} tool_calls, ${contentLen} content chars`,
    );

    if (!res.tool_calls?.length) {
      // Legacy exit: model emitted content with no tool_calls.
      // If a final-answer tool is registered, nudge the model to use it
      // instead of accepting a free-form tail (the doubling pattern we want to avoid).
      if (finalAnswer && hop < maxHops - 1) {
        logger.warn(
          { component: 'tool-loop', hop, contentChars: contentLen },
          `coercion: hop ${hop} had no tool_calls but ${contentLen} content chars — nudging model to call ${submitName}`,
        );
        collected.push(
          new HumanMessage(
            `Please call the \`${submitName}\` tool now with your final structured answer.`,
          ),
        );
        continue;
      }
      break;
    }

    const submitCall = finalAnswer ? res.tool_calls.find((c) => c.name === submitName) : undefined;

    if (submitCall && finalAnswer) {
      const argsObj = (submitCall.args ?? {}) as Record<string, unknown>;

      if (calls.length < minHops) {
        // Reject early submission: tell model to do more research, then continue.
        logger.warn(
          { component: 'tool-loop', hop, callsSoFar: calls.length, minHops },
          `submit rejected: model called ${submitName} after only ${calls.length} research call(s), need ${minHops}`,
        );
        collected.push(
          new ToolMessage({
            tool_call_id: submitCall.id ?? '',
            content: `Error: research first. You've called ${calls.length} non-submit tool(s); call at least ${minHops} before submitting.`,
          }),
        );
        continue;
      }

      // Validate; if Zod rejects, surface as a tool error so the model can retry.
      const parsed = finalAnswer.schema.safeParse(argsObj);
      if (!parsed.success) {
        const issuePreview = parsed.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ');
        logger.warn(
          {
            component: 'tool-loop',
            hop,
            issueCount: parsed.error.issues.length,
            issues: parsed.error.issues.slice(0, 5),
          },
          `submit rejected (schema): ${issuePreview}`,
        );
        collected.push(
          new ToolMessage({
            tool_call_id: submitCall.id ?? '',
            content: `Error: submit args failed schema validation. ${parsed.error.message}. Fix and call ${submitName} again.`,
          }),
        );
        continue;
      }

      submittedValue = parsed.data;
      // Acknowledge the submit so any other tool_calls in this same hop don't
      // hang as orphans — but we break right after to skip them.
      collected.push(
        new ToolMessage({
          tool_call_id: submitCall.id ?? '',
          content: 'submitted',
        }),
      );
      break;
    }

    for (const call of res.tool_calls) {
      const agentTool = allTools.find((x) => x.tool.name === call.name);
      if (!agentTool) continue;

      const args = call.args as Record<string, unknown>;
      const fmt = formatters[call.name];

      const callingLog = fmt?.calling?.(args);
      await emitLog(`tool.calling.${call.name}`, callingLog?.message ?? `呼叫 ${call.name}`, {
        tool: call.name,
        ...callingLog?.data,
      });

      const result = await agentTool.tool.invoke(args);
      calls.push({ toolName: call.name, args, result });

      const resultLog = fmt?.result?.(args, result);
      await emitLog(`tool.result.${call.name}`, resultLog?.message ?? `${call.name} 完成`, {
        tool: call.name,
        ...resultLog?.data,
      });

      collected.push(
        new ToolMessage({ tool_call_id: call.id ?? '', content: JSON.stringify(result) }),
      );
    }
  }

  if (submittedValue !== undefined) {
    return { kind: 'submitted', value: submittedValue, collected, calls };
  }
  return { kind: 'plain', collected, calls };
}
