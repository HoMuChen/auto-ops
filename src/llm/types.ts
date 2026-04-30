import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

/**
 * A model is identified by its OpenRouter slug — e.g. `anthropic/claude-opus-4.7`,
 * `openai/gpt-4o`, `google/gemini-pro-1.5`. The full catalogue lives at
 * https://openrouter.ai/models. Every request goes through OpenRouter, so we
 * don't need provider-specific clients or env keys.
 */
export interface ModelConfig {
  /** OpenRouter model slug, e.g. "anthropic/claude-opus-4.7". */
  model: string;
  temperature?: number;
  maxTokens?: number;
}

export interface ModelFactory {
  create(config: ModelConfig): BaseChatModel;
}
