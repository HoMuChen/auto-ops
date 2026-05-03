import type { BaseMessage } from '@langchain/core/messages';
import type { ZodType } from 'zod';
import { buildModel } from '../../llm/model-registry.js';
import type { ModelConfig } from '../../llm/types.js';

/**
 * Invokes withStructuredOutput and retries on OUTPUT_PARSING_FAILURE.
 * LLM responses containing multibyte/CJK text occasionally produce malformed
 * JSON in the tool-call arguments path; retrying usually succeeds.
 */
export async function invokeStructured<T>(
  modelConfig: ModelConfig,
  schema: ZodType<T>,
  schemaName: string,
  messages: BaseMessage[],
  maxRetries = 3,
): Promise<T> {
  const model = buildModel(modelConfig).withStructuredOutput(schema, { name: schemaName });
  let lastError: unknown;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return (await model.invoke(messages)) as T;
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries - 1) {
        await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
      }
    }
  }
  throw lastError;
}
