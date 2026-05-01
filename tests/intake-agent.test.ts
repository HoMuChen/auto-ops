import { describe, expect, it, vi } from 'vitest';

/**
 * Unit-tests the intake agent in isolation: confirms the structured output is
 * returned untouched, the system prompt embeds the available worker roster,
 * and the conversation history is replayed in order. The langchain model is
 * mocked so the test is hermetic.
 */

const sampleOutput = {
  reply: '了解，老闆你想要寫幾篇？目標客群是哪一塊？',
  draftTitle: 'SEO 文章撰寫',
  draftBrief: '老闆要產出 SEO 文章，主題是夏季穿搭。',
  readyToFinalize: false,
  missingInfo: ['數量', '目標客群'],
};

const invokeMock = vi.fn(async (_messages: unknown) => sampleOutput);
const withStructuredOutputMock = vi.fn(() => ({ invoke: invokeMock }));
const buildModelMock = vi.fn(() => ({ withStructuredOutput: withStructuredOutputMock }));

vi.mock('../src/llm/model-registry.js', () => ({
  buildModel: buildModelMock,
}));

const { runIntakeTurn } = await import('../src/intakes/agent.js');

const ROSTER = [
  {
    id: 'shopify-blog-writer',
    name: 'AI Shopify Blog Writer',
    description: 'Writes a single multilingual SEO article from a focused brief.',
  },
  {
    id: 'shopify-ops',
    name: 'AI Shopify Ops',
    description: 'Creates and updates products in the Shopify Admin API.',
  },
];

describe('runIntakeTurn', () => {
  it('passes structured output through unchanged', async () => {
    const result = await runIntakeTurn([], 'help me write articles', { availableAgents: ROSTER });
    expect(result).toEqual(sampleOutput);
  });

  it('embeds the available agent roster in the system prompt', async () => {
    invokeMock.mockClear();
    await runIntakeTurn([], 'do something', { availableAgents: ROSTER });

    const messages = invokeMock.mock.calls[0]?.[0] as unknown as { content: string }[];
    expect(messages[0]?.content).toContain('shopify-blog-writer');
    expect(messages[0]?.content).toContain('shopify-ops');
  });

  it('replays prior conversation turns then the new user message', async () => {
    invokeMock.mockClear();
    const history = [
      { role: 'user' as const, content: 'I want articles', createdAt: '2026-05-01T00:00:00Z' },
      {
        role: 'assistant' as const,
        content: 'Got it — how many?',
        createdAt: '2026-05-01T00:00:01Z',
      },
    ];
    await runIntakeTurn(history, 'three per week', { availableAgents: ROSTER });

    const messages = invokeMock.mock.calls[0]?.[0] as unknown as { content: string }[];
    // 1 system + 2 history + 1 new = 4
    expect(messages.length).toBe(4);
    expect(messages[1]?.content).toBe('I want articles');
    expect(messages[2]?.content).toContain('Got it — how many?');
    expect(messages[3]?.content).toBe('three per week');
  });

  it('falls back to a graceful note when no worker agents are enabled', async () => {
    invokeMock.mockClear();
    await runIntakeTurn([], 'do something', { availableAgents: [] });

    const messages = invokeMock.mock.calls[0]?.[0] as unknown as { content: string }[];
    expect(messages[0]?.content).toContain('no worker agents are enabled yet');
  });
});
