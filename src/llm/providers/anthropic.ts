import { ChatAnthropic } from '@langchain/anthropic';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { env } from '../../config/env.js';
import { ExternalServiceError } from '../../lib/errors.js';
import type { ModelConfig } from '../types.js';

export function createAnthropicModel(config: ModelConfig): BaseChatModel {
  if (!env.ANTHROPIC_API_KEY) {
    throw new ExternalServiceError('anthropic', 'ANTHROPIC_API_KEY is not configured');
  }
  return new ChatAnthropic({
    apiKey: env.ANTHROPIC_API_KEY,
    model: config.model,
    temperature: config.temperature ?? 0.3,
    maxTokens: config.maxTokens ?? 4096,
  });
}
