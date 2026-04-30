import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { createOpenRouterModel } from './providers/openrouter.js';
import type { ModelConfig } from './types.js';

/**
 * ModelRegistry — cached factory.
 *
 * Models are decided in code (each agent's manifest declares its own model
 * slug). There is no per-tenant override layer; the user does not pick the
 * LLM. This file exists primarily so we have a single insertion point for:
 *   - Caching ChatModel instances (reused across calls with the same config)
 *   - Wiring custom OpenRouter headers / future provider-side concerns
 */
const cache = new Map<string, BaseChatModel>();

function cacheKey(c: ModelConfig): string {
  return `${c.model}:${c.temperature ?? 'def'}:${c.maxTokens ?? 'def'}`;
}

export function buildModel(config: ModelConfig): BaseChatModel {
  const key = cacheKey(config);
  const cached = cache.get(key);
  if (cached) return cached;
  const model = createOpenRouterModel(config);
  cache.set(key, model);
  return model;
}
