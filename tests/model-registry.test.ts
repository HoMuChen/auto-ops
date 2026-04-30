import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Mock the provider modules BEFORE importing model-registry — the registry
 * caches model instances, so we want to control what the providers return.
 *
 * Each provider returns a fresh sentinel object on every call so we can assert
 * "same input config => same cached instance" by referential equality.
 */
const anthropicCalls: { model: string; temperature?: number }[] = [];
const openaiCalls: { model: string; temperature?: number }[] = [];

vi.mock('../src/llm/providers/anthropic.js', () => ({
  createAnthropicModel: vi.fn((config: { model: string; temperature?: number }) => {
    anthropicCalls.push({ model: config.model, temperature: config.temperature });
    return { __provider: 'anthropic', model: config.model };
  }),
}));

vi.mock('../src/llm/providers/openai.js', () => ({
  createOpenAIModel: vi.fn((config: { model: string; temperature?: number }) => {
    openaiCalls.push({ model: config.model, temperature: config.temperature });
    return { __provider: 'openai', model: config.model };
  }),
}));

// Import AFTER mocks so the registry binds to the mocked providers.
const { buildModel } = await import('../src/llm/model-registry.js');

describe('buildModel', () => {
  beforeEach(() => {
    anthropicCalls.length = 0;
    openaiCalls.length = 0;
  });

  it('routes to the right provider based on config.provider', () => {
    const a = buildModel({ provider: 'anthropic', model: 'claude-test-1' }) as unknown as {
      __provider: string;
    };
    const o = buildModel({ provider: 'openai', model: 'gpt-test-1' }) as unknown as {
      __provider: string;
    };
    expect(a.__provider).toBe('anthropic');
    expect(o.__provider).toBe('openai');
  });

  it('caches model instances by config shape', () => {
    const cfg = {
      provider: 'anthropic' as const,
      model: 'claude-cache-1',
      temperature: 0.3,
    };
    const m1 = buildModel(cfg);
    const m2 = buildModel({ ...cfg });
    expect(m1).toBe(m2);
    // Provider should have been invoked exactly once for these calls.
    const matching = anthropicCalls.filter((c) => c.model === 'claude-cache-1');
    expect(matching).toHaveLength(1);
  });

  it('returns different instances for different temperatures', () => {
    const a = buildModel({ provider: 'anthropic', model: 'claude-temp', temperature: 0.1 });
    const b = buildModel({ provider: 'anthropic', model: 'claude-temp', temperature: 0.9 });
    expect(a).not.toBe(b);
  });

  it('returns different instances for different providers', () => {
    const a = buildModel({ provider: 'anthropic', model: 'same-name' });
    const o = buildModel({ provider: 'openai', model: 'same-name' });
    expect(a).not.toBe(o);
  });
});
