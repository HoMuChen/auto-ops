import { beforeEach, describe, expect, it } from 'vitest';
import { AgentRegistry } from '../src/agents/registry.js';
import type { IAgent } from '../src/agents/types.js';
import { NotFoundError } from '../src/lib/errors.js';

function fakeAgent(id: string, plans: ('basic' | 'pro' | 'flagship')[] = ['basic']): IAgent {
  return {
    manifest: {
      id,
      name: id,
      description: `fake agent ${id}`,
      availableInPlans: plans,
      defaultModel: { model: 'anthropic/fake-model' },
      defaultPrompt: 'fake prompt',
    },
    build() {
      return { tools: [], invoke: async () => ({ message: '' }) };
    },
  };
}

describe('AgentRegistry (in-memory)', () => {
  let registry: AgentRegistry;

  beforeEach(() => {
    registry = new AgentRegistry();
  });

  it('registers and retrieves an agent', () => {
    const a = fakeAgent('seo-expert');
    registry.register(a);
    expect(registry.has('seo-expert')).toBe(true);
    expect(registry.get('seo-expert')).toBe(a);
  });

  it('throws when registering a duplicate id', () => {
    registry.register(fakeAgent('dup'));
    expect(() => registry.register(fakeAgent('dup'))).toThrow(/already registered/);
  });

  it('get throws NotFoundError for unknown ids', () => {
    expect(() => registry.get('missing')).toThrow(NotFoundError);
  });

  it('unregister removes the agent', () => {
    registry.register(fakeAgent('temp'));
    expect(registry.has('temp')).toBe(true);
    registry.unregister('temp');
    expect(registry.has('temp')).toBe(false);
  });

  it('unregister on missing id is a no-op', () => {
    expect(() => registry.unregister('never-registered')).not.toThrow();
  });

  it('manifests() returns all currently-registered manifests', () => {
    registry.register(fakeAgent('a'));
    registry.register(fakeAgent('b'));
    const ids = registry
      .manifests()
      .map((m) => m.id)
      .sort();
    expect(ids).toEqual(['a', 'b']);
  });
});
