import type { BaseMessage } from '@langchain/core/messages';
import { jsonrepair } from 'jsonrepair';
import type { ZodType } from 'zod';
import { buildModel } from '../../llm/model-registry.js';
import type { ModelConfig } from '../../llm/types.js';

/**
 * Invokes withStructuredOutput and handles OUTPUT_PARSING_FAILURE from OpenRouter.
 *
 * When LangChain's tool-call JSON parser fails (common with CJK content that
 * contains unescaped quotes or other problematic chars), we:
 *   1. Extract the raw arguments string from the LangChain error message.
 *   2. Run jsonrepair on it and validate with the Zod schema.
 *   3. Only if repair also fails, retry the full LLM call (up to maxRetries).
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
      // Try to salvage the raw JSON before burning a retry.
      const salvaged = tryRepairFromError<T>(err, schema);
      if (salvaged !== null) return salvaged;

      lastError = err;
      if (attempt < maxRetries - 1) {
        await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
      }
    }
  }
  throw lastError;
}

/**
 * LangChain error message format for OUTPUT_PARSING_FAILURE:
 *   Function "<name>" arguments:\n\n{...raw json...}\n\nare not valid JSON.\n...
 */
function tryRepairFromError<T>(err: unknown, schema: ZodType<T>): T | null {
  const msg = (err as { message?: string } | null)?.message;
  if (!msg) return null;
  const match = msg.match(/arguments:\n\n(\{[\s\S]*?)\n\nare not valid JSON/);
  if (!match?.[1]) return null;
  try {
    const repaired = jsonrepair(match[1]);
    return schema.parse(JSON.parse(repaired)) as T;
  } catch {
    return null;
  }
}
