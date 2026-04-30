import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Mock the OpenRouter provider BEFORE importing model-registry. The registry
 * caches model instances, so the mocked factory returns sentinel objects we
 * can compare by referential equality.
 */
const calls: { model: string; temperature?: number }[] = [];

vi.mock('../src/llm/providers/openrouter.js', () => ({
  createOpenRouterModel: vi.fn(
    (config: { model: string; temperature?: number; maxTokens?: number }) => {
      calls.push({ model: config.model, temperature: config.temperature });
      return {
        __mock: 'openrouter',
        model: config.model,
        temperature: config.temperature,
      };
    },
  ),
}));

// Import AFTER mocks so the registry binds to the mocked provider.
const { buildModel } = await import('../src/llm/model-registry.js');

describe('buildModel', () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it('caches model instances by config shape', () => {
    const cfg = { model: 'anthropic/claude-cache-1', temperature: 0.3 };
    const m1 = buildModel(cfg);
    const m2 = buildModel({ ...cfg });
    expect(m1).toBe(m2);
    const matching = calls.filter((c) => c.model === 'anthropic/claude-cache-1');
    expect(matching).toHaveLength(1);
  });

  it('returns different instances for different temperatures', () => {
    const a = buildModel({ model: 'anthropic/claude-temp', temperature: 0.1 });
    const b = buildModel({ model: 'anthropic/claude-temp', temperature: 0.9 });
    expect(a).not.toBe(b);
  });

  it('returns different instances for different model slugs', () => {
    const a = buildModel({ model: 'anthropic/claude-opus-4.7' });
    const b = buildModel({ model: 'openai/gpt-4o' });
    expect(a).not.toBe(b);
  });

  it('passes the slug through to the provider verbatim', () => {
    buildModel({ model: 'google/gemini-2.0-flash', temperature: 0.5 });
    expect(calls[calls.length - 1]).toEqual({
      model: 'google/gemini-2.0-flash',
      temperature: 0.5,
    });
  });
});
