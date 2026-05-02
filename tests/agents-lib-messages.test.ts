import { describe, expect, it } from 'vitest';
import { buildAgentMessages } from '../src/agents/lib/messages.js';
import { HumanMessage } from '@langchain/core/messages';

describe('buildAgentMessages — vision', () => {
  it('injects image_url blocks for messages with imageIds', async () => {
    const resolver = async (ids: string[]) => ids.map((id) => `https://img/${id}/public`);
    const history = [
      { role: 'user' as const, content: 'look at this product', imageIds: ['uuid-1'] },
    ];
    const msgs = await buildAgentMessages('System prompt', history, [], resolver);

    const human = msgs[1] as HumanMessage;
    expect(Array.isArray(human.content)).toBe(true);
    const parts = human.content as { type: string }[];
    expect(parts.some((p) => p.type === 'image_url')).toBe(true);
    expect(parts.some((p) => p.type === 'text')).toBe(true);
  });

  it('plain text when no imageIds', async () => {
    const history = [{ role: 'user' as const, content: 'hello' }];
    const msgs = await buildAgentMessages('sys', history);
    const human = msgs[1] as HumanMessage;
    expect(typeof human.content).toBe('string');
  });

  it('plain text when no resolver provided', async () => {
    const history = [{ role: 'user' as const, content: 'hi', imageIds: ['x'] }];
    const msgs = await buildAgentMessages('sys', history);
    const human = msgs[1] as HumanMessage;
    expect(typeof human.content).toBe('string');
  });
});
