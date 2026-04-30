import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ChatOpenAI } from '@langchain/openai';
import { env } from '../../config/env.js';
import { ExternalServiceError } from '../../lib/errors.js';
import type { ModelConfig } from '../types.js';

export function createOpenAIModel(config: ModelConfig): BaseChatModel {
  if (!env.OPENAI_API_KEY) {
    throw new ExternalServiceError('openai', 'OPENAI_API_KEY is not configured');
  }
  return new ChatOpenAI({
    apiKey: env.OPENAI_API_KEY,
    model: config.model,
    temperature: config.temperature ?? 0.3,
    maxTokens: config.maxTokens ?? 4096,
  });
}
