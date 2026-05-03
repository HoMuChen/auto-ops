import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ChatOpenAI } from '@langchain/openai';
import { env } from '../../config/env.js';
import { ExternalServiceError } from '../../lib/errors.js';
import type { ModelConfig } from '../types.js';

/**
 * OpenRouter-backed ChatModel.
 *
 * OpenRouter exposes an OpenAI-compatible API, so we reuse `ChatOpenAI` with
 * a custom `baseURL`. Model selection happens via the slug in `config.model`
 * (e.g. `anthropic/claude-opus-4.7`); OpenRouter routes the request to the
 * upstream provider and normalises function-calling so LangChain features
 * like `withStructuredOutput` work uniformly.
 *
 * The optional `HTTP-Referer` / `X-Title` headers are recommended by
 * OpenRouter so the dashboard can attribute usage to this app.
 */
export function createOpenRouterModel(config: ModelConfig): BaseChatModel {
  if (!env.OPENROUTER_API_KEY) {
    throw new ExternalServiceError('openrouter', 'OPENROUTER_API_KEY is not configured');
  }
  return new ChatOpenAI({
    apiKey: env.OPENROUTER_API_KEY,
    model: config.model,
    temperature: config.temperature ?? 0.3,
    maxTokens: config.maxTokens ?? 16384,
    configuration: {
      baseURL: 'https://openrouter.ai/api/v1',
      defaultHeaders: {
        'HTTP-Referer': env.OPENROUTER_REFERER,
        'X-Title': 'auto-ops',
      },
    },
  });
}
