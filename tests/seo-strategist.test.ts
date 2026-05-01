import { describe, expect, it, vi } from 'vitest';

/**
 * Verifies the SEO Strategist converts a structured content plan into well-formed
 * spawnTasks, picks `assignedAgent` per topic from `availableExecutionAgents`,
 * and rejects LLM responses that name an unknown worker.
 *
 * The langchain model is mocked so the test is hermetic — no LLM, no DB.
 */

const planFixture = {
  reasoning: 'Three pillars covering top-of-funnel awareness for the summer campaign.',
  topics: [
    {
      title: '夏季穿搭 5 個必備單品',
      primaryKeyword: '夏季穿搭',
      language: 'zh-TW' as const,
      writerBrief: 'Long-form 1500 字文章, focus on layered styling for Taiwan humid summers.',
      assignedAgent: 'seo-writer',
    },
    {
      title: 'Sustainable summer fabrics buyer guide',
      primaryKeyword: 'sustainable fabrics summer',
      language: 'en' as const,
      writerBrief: 'Buyer guide comparing linen, organic cotton, and Tencel for summer apparel.',
      assignedAgent: 'seo-writer',
      scheduledAt: '2026-06-01T09:00:00.000Z',
    },
  ],
};

const invokeMock = vi.fn(async () => planFixture);
const withStructuredOutputMock = vi.fn(() => ({ invoke: invokeMock }));

vi.mock('../src/llm/model-registry.js', () => ({
  buildModel: vi.fn(() => ({
    withStructuredOutput: withStructuredOutputMock,
  })),
}));

const { seoStrategistAgent } = await import('../src/agents/builtin/seo-strategist/index.js');

const PEERS = [
  {
    id: 'seo-writer',
    name: 'AI SEO Writer',
    description: 'Writes a single multilingual SEO article from a focused brief.',
  },
];

describe('seoStrategistAgent.build → invoke', () => {
  const ctx = {
    tenantId: '00000000-0000-0000-0000-000000000001',
    taskId: '00000000-0000-0000-0000-000000000002',
    modelConfig: seoStrategistAgent.manifest.defaultModel,
    systemPrompt: seoStrategistAgent.manifest.defaultPrompt,
    agentConfig: { maxTopics: 5, defaultLanguages: ['zh-TW' as const] },
    availableExecutionAgents: PEERS,
    emitLog: vi.fn(async () => {}),
  };

  it('produces one spawnTask per planned topic, each carrying the LLM-picked assignedAgent', async () => {
    const runnable = await seoStrategistAgent.build(ctx);
    const result = await runnable.invoke({
      messages: [{ role: 'user', content: 'plan the summer SEO campaign for our store' }],
      params: {},
    });

    expect(result.awaitingApproval).toBe(true);
    expect(result.spawnTasks).toHaveLength(2);
    for (const spawn of result.spawnTasks ?? []) {
      expect(spawn.assignedAgent).toBe('seo-writer');
      expect(spawn.input).toHaveProperty('brief');
      expect(spawn.input).toHaveProperty('primaryKeyword');
      expect(spawn.input).toHaveProperty('language');
    }
  });

  it('forwards optional scheduledAt verbatim into the spawn spec', async () => {
    const runnable = await seoStrategistAgent.build(ctx);
    const result = await runnable.invoke({
      messages: [{ role: 'user', content: 'plan summer SEO' }],
      params: {},
    });

    const scheduled = result.spawnTasks?.find((s) => s.scheduledAt);
    expect(scheduled?.scheduledAt).toBe('2026-06-01T09:00:00.000Z');
    const unscheduled = result.spawnTasks?.find((s) => !s.scheduledAt);
    expect(unscheduled).toBeDefined();
    expect(Object.hasOwn(unscheduled ?? {}, 'scheduledAt')).toBe(false);
  });

  it('caps the topic count at agentConfig.maxTopics', async () => {
    const runnable = await seoStrategistAgent.build({
      ...ctx,
      agentConfig: { maxTopics: 1 },
    });
    const result = await runnable.invoke({
      messages: [{ role: 'user', content: 'plan summer SEO' }],
      params: {},
    });
    expect(result.spawnTasks).toHaveLength(1);
  });

  it('keeps the plan in payload for UI rendering', async () => {
    const runnable = await seoStrategistAgent.build(ctx);
    const result = await runnable.invoke({
      messages: [{ role: 'user', content: 'plan summer SEO' }],
      params: {},
    });
    expect(result.payload).toHaveProperty('plan');
    expect((result.payload as { plan: { topics: unknown[] } }).plan.topics).toHaveLength(2);
  });

  it('throws at build time if no peer worker agents are available', async () => {
    expect(() =>
      seoStrategistAgent.build({
        ...ctx,
        availableExecutionAgents: [],
      }),
    ).toThrow(/at least one peer worker agent/);
  });

  it('throws at invoke time if the LLM hallucinates an unknown assignedAgent', async () => {
    invokeMock.mockResolvedValueOnce({
      reasoning: 'plan with bad assignee',
      topics: [
        {
          title: 'whatever',
          primaryKeyword: 'kw',
          language: 'zh-TW',
          writerBrief: 'something long enough to satisfy the schema minimum length.',
          assignedAgent: 'nonexistent-writer',
        },
      ],
    });
    const runnable = await seoStrategistAgent.build(ctx);
    await expect(
      runnable.invoke({
        messages: [{ role: 'user', content: 'plan' }],
        params: {},
      }),
    ).rejects.toThrow(/unknown worker agent/);
  });
});
