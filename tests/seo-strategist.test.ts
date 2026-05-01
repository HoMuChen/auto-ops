import { describe, expect, it, vi } from 'vitest';

/**
 * Verifies the SEO Strategist converts a structured content plan into well-formed
 * spawnTasks (one per topic, all addressed to seo-writer) and a human-readable
 * plan summary.
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
    },
    {
      title: 'Sustainable summer fabrics buyer guide',
      primaryKeyword: 'sustainable fabrics summer',
      language: 'en' as const,
      writerBrief: 'Buyer guide comparing linen, organic cotton, and Tencel for summer apparel.',
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

describe('seoStrategistAgent.build → invoke', () => {
  const ctx = {
    tenantId: '00000000-0000-0000-0000-000000000001',
    taskId: '00000000-0000-0000-0000-000000000002',
    modelConfig: seoStrategistAgent.manifest.defaultModel,
    systemPrompt: seoStrategistAgent.manifest.defaultPrompt,
    agentConfig: { maxTopics: 5, defaultLanguages: ['zh-TW' as const] },
    emitLog: vi.fn(async () => {}),
  };

  it('produces one spawnTask per planned topic, all assigned to seo-writer', async () => {
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
    // Topic without scheduledAt does not leak the key.
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
});
