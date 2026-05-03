import { type AIMessage, type BaseMessage, ToolMessage } from '@langchain/core/messages';
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
      message: `搜尋關鍵字「${(args as { q?: string }).q ?? ''}」`,
      data: { query: (args as { q?: string }).q },
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

export interface ToolLoopOptions {
  modelConfig: ModelConfig;
  messages: BaseMessage[];
  tools: AgentTool[];
  maxHops?: number;
  emitLog: EmitLog;
  /** Per-tool overrides merged on top of DEFAULT_FORMATTERS. Keyed by tool.name. */
  logFormatters?: Record<string, Partial<ToolLogFormatter>>;
}

export interface ToolLoopResult {
  /** Full message history including all assistant + tool messages from the loop. */
  collected: BaseMessage[];
  /** Every tool call that fired, in order. */
  calls: ToolCall[];
}

/**
 * Runs a tool-calling loop up to `maxHops` rounds, emitting a task log before
 * and after every tool invocation so the user can follow along in real time.
 */
export async function runToolLoop({
  modelConfig,
  messages,
  tools,
  maxHops = 6,
  emitLog,
  logFormatters = {},
}: ToolLoopOptions): Promise<ToolLoopResult> {
  const formatters = { ...DEFAULT_FORMATTERS, ...logFormatters };

  const toolModel = (
    buildModel(modelConfig) as unknown as {
      bindTools: (tools: unknown[]) => { invoke: (msgs: BaseMessage[]) => Promise<AIMessage> };
    }
  ).bindTools(tools.map((t) => t.tool));

  const collected: BaseMessage[] = [...messages];
  const calls: ToolCall[] = [];

  for (let hop = 0; hop < maxHops; hop++) {
    const res = (await toolModel.invoke(collected)) as AIMessage;
    collected.push(res);
    if (!res.tool_calls?.length) break;

    for (const call of res.tool_calls) {
      const agentTool = tools.find((x) => x.tool.name === call.name);
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

  return { collected, calls };
}
