import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

export const llmProviders = ['anthropic', 'openai'] as const;
export type LlmProvider = (typeof llmProviders)[number];

export interface ModelConfig {
  provider: LlmProvider;
  model: string;
  temperature?: number;
  maxTokens?: number;
}

export interface ModelFactory {
  create(config: ModelConfig): BaseChatModel;
}
