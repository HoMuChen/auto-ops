import { vi } from 'vitest';
import type { z } from 'zod';

/**
 * Scripted fake ChatModel used to make integration tests deterministic without
 * hitting OpenRouter.
 *
 * The Supervisor uses `model.withStructuredOutput(schema).invoke(...)` and
 * expects an object matching the Zod schema. Worker agents use
 * `model.invoke(...)` and expect `{ content: string }`.
 *
 * Use:
 *   vi.mock('../../src/llm/model-registry.js', () => llmMockModule());
 *   beforeEach(() => clearScript());
 *   scriptStructured({ nextAgent: 'shopify-blog-writer', clarification: null, done: false });
 *   scriptText('# Draft article ...');
 *
 * Calls drain the queue in order. An unscripted call throws so test gaps
 * surface immediately rather than silently masking real model usage.
 */

type ScriptedResponse =
  | { kind: 'text'; text: string }
  | { kind: 'structured'; data: Record<string, unknown> }
  | { kind: 'tool_call'; name: string; args: Record<string, unknown>; id: string };

const queue: ScriptedResponse[] = [];

export function scriptText(text: string): void {
  queue.push({ kind: 'text', text });
}

export function scriptStructured(data: Record<string, unknown>): void {
  queue.push({ kind: 'structured', data });
}

/** Script a tool-call turn for the tool-calling pass of two-pass agents. */
export function scriptToolCall(
  name: string,
  args: Record<string, unknown>,
  id = 'call_fake',
): void {
  queue.push({ kind: 'tool_call', name, args, id });
}

export function clearScript(): void {
  queue.length = 0;
}

export function pendingScript(): number {
  return queue.length;
}

class FakeChatModel {
  async invoke(_messages: unknown): Promise<{ content: string }> {
    const next = queue.shift();
    if (!next) throw new Error('FakeChatModel.invoke called with no scripted response');
    if (next.kind !== 'text') {
      throw new Error(`FakeChatModel.invoke expected text, got ${next.kind}`);
    }
    return { content: next.text };
  }

  withStructuredOutput<T>(_schema: z.ZodType<T>, _opts?: { name?: string }) {
    return {
      invoke: async (_messages: unknown): Promise<T> => {
        const next = queue.shift();
        if (!next) {
          throw new Error('FakeChatModel.withStructuredOutput called with no scripted response');
        }
        if (next.kind !== 'structured') {
          throw new Error(
            `FakeChatModel.withStructuredOutput expected structured, got ${next.kind}`,
          );
        }
        return next.data as T;
      },
    };
  }

  /**
   * Supports the two-pass tool-calling pattern used by seo-strategist.
   * If the queue head is a `tool_call` entry, returns it as an AIMessage-like
   * object with `tool_calls`. Otherwise returns a plain AIMessage with no
   * tool_calls so the loop exits and moves to pass 2.
   */
  bindTools(_tools: unknown[]) {
    return {
      invoke: async (_messages: unknown): Promise<{
        content: string;
        tool_calls?: { name: string; args: Record<string, unknown>; id: string }[];
      }> => {
        const next = queue[0];
        if (next?.kind === 'tool_call') {
          queue.shift();
          return { content: '', tool_calls: [{ name: next.name, args: next.args, id: next.id }] };
        }
        return { content: '', tool_calls: [] };
      },
    };
  }
}

export const fakeChatModel = new FakeChatModel();

/**
 * Returns the module shape that `vi.mock` should use to replace the real
 * `model-registry`. Keep this in sync with the real exports.
 */
export function llmMockModule() {
  return {
    buildModel: vi.fn(() => fakeChatModel),
  };
}
