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
 *   scriptStructured({ nextAgent: 'seo-writer', clarification: null, done: false });
 *   scriptText('# Draft article ...');
 *
 * Calls drain the queue in order. An unscripted call throws so test gaps
 * surface immediately rather than silently masking real model usage.
 */

type ScriptedResponse =
  | { kind: 'text'; text: string }
  | { kind: 'structured'; data: Record<string, unknown> };

const queue: ScriptedResponse[] = [];

export function scriptText(text: string): void {
  queue.push({ kind: 'text', text });
}

export function scriptStructured(data: Record<string, unknown>): void {
  queue.push({ kind: 'structured', data });
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
