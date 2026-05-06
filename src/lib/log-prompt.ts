import type { BaseMessage } from '@langchain/core/messages';
import { logger } from './logger.js';

/**
 * Diagnostic helpers for inspecting what gets sent to / returned from the LLM
 * on every agent invocation.
 *
 * Both helpers gate on `logger.isLevelEnabled('debug')` so the (potentially
 * large) message payload is only formatted when the log will actually be
 * emitted. Dev default is `debug`, prod default is `info` — so prod stays
 * silent without any extra config.
 *
 * Pair `logPromptBuilt` (input — system prompt + history) with `logLlmInvoked`
 * (output — content + tool_calls) per LLM call to reconstruct the full
 * conversation from logs alone, scoped by taskId + agentId.
 */

export interface PromptLogContext {
  taskId?: string | undefined;
  agentId?: string | undefined;
}

interface LlmResponse {
  content?: unknown;
  tool_calls?: { name: string; args: unknown }[];
}

function contentToString(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content === null || content === undefined) return '';
  return JSON.stringify(content);
}

/**
 * Log the messages array that's about to be sent to the LLM. Captures the
 * dynamically-built system prompt (tenant profile + skill packs + constraints)
 * as well as every history entry, so prompt drift is visible across runs.
 */
export function logPromptBuilt(ctx: PromptLogContext, messages: BaseMessage[]): void {
  if (!logger.isLevelEnabled('debug')) return;

  const summary = messages.map((m) => {
    const role = m.getType();
    const content = contentToString(m.content);
    return { role, contentChars: content.length, content };
  });

  logger.debug(
    {
      component: 'llm',
      taskId: ctx.taskId,
      agentId: ctx.agentId,
      event: 'prompt.built',
      messageCount: messages.length,
      messages: summary,
    },
    `prompt built (${messages.length} messages)`,
  );
}

/**
 * Log a single LLM response — content + tool_calls (full args). Use after
 * `model.invoke(...)`, `bindTools(...).invoke(...)`, or
 * `withStructuredOutput(...).invoke(...)`.
 *
 * For structured-output paths, pass `{ content: JSON.stringify(result) }` so
 * the output is still visible in the same shape.
 */
export function logLlmInvoked(ctx: PromptLogContext, response: LlmResponse): void {
  if (!logger.isLevelEnabled('debug')) return;

  const content = contentToString(response.content);
  const toolCalls = (response.tool_calls ?? []).map((c) => ({ name: c.name, args: c.args }));

  logger.debug(
    {
      component: 'llm',
      taskId: ctx.taskId,
      agentId: ctx.agentId,
      event: 'llm.invoked',
      contentChars: content.length,
      content,
      toolCalls,
    },
    `llm responded (${toolCalls.length} tool_calls, ${content.length} content chars)`,
  );
}
