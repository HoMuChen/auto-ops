import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { and, eq } from 'drizzle-orm';
import { env } from '../config/env.js';
import { db } from '../db/client.js';
import { agentConfigs } from '../db/schema/index.js';
import { ExternalServiceError } from '../lib/errors.js';
import { createAnthropicModel } from './providers/anthropic.js';
import { createOpenAIModel } from './providers/openai.js';
import type { ModelConfig } from './types.js';

/**
 * Per-(tenant, agent) model resolver.
 *
 * Resolution order:
 *   1. tenant override in agent_configs.model_config
 *   2. agent default (passed in)
 *   3. global default from env
 *
 * Models are cached by config hash so we don't reinstantiate them per call.
 */
const cache = new Map<string, BaseChatModel>();

function cacheKey(c: ModelConfig): string {
  return `${c.provider}:${c.model}:${c.temperature ?? 'def'}:${c.maxTokens ?? 'def'}`;
}

export function buildModel(config: ModelConfig): BaseChatModel {
  const key = cacheKey(config);
  const cached = cache.get(key);
  if (cached) return cached;

  let model: BaseChatModel;
  switch (config.provider) {
    case 'anthropic':
      model = createAnthropicModel(config);
      break;
    case 'openai':
      model = createOpenAIModel(config);
      break;
    default: {
      const _exhaustive: never = config.provider;
      throw new ExternalServiceError('llm', `Unknown provider: ${_exhaustive}`);
    }
  }
  cache.set(key, model);
  return model;
}

export async function resolveModelConfig(
  tenantId: string,
  agentKey: string,
  agentDefault?: ModelConfig,
): Promise<ModelConfig> {
  const [row] = await db
    .select({ modelConfig: agentConfigs.modelConfig })
    .from(agentConfigs)
    .where(and(eq(agentConfigs.tenantId, tenantId), eq(agentConfigs.agentKey, agentKey)))
    .limit(1);

  if (row?.modelConfig) return row.modelConfig;
  if (agentDefault) return agentDefault;
  return {
    provider: env.DEFAULT_LLM_PROVIDER,
    model: env.DEFAULT_LLM_MODEL,
  };
}

export async function buildModelFor(
  tenantId: string,
  agentKey: string,
  agentDefault?: ModelConfig,
): Promise<BaseChatModel> {
  const config = await resolveModelConfig(tenantId, agentKey, agentDefault);
  return buildModel(config);
}
