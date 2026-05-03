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
  progressNote: '規劃了 2 個主軸，圍繞夏季 + 永續，老闆過目',
  topics: [
    {
      title: '夏季穿搭 5 個必備單品',
      primaryKeyword: '夏季穿搭',
      language: 'zh-TW' as const,
      writerBrief: 'Long-form 1500 字文章, focus on layered styling for Taiwan humid summers.',
      assignedAgent: 'shopify-blog-writer',
      searchIntent: 'commercial' as const,
      paaQuestions: ['Is linen good for summer?', 'How to care for linen?'],
      relatedSearches: ['linen vs cotton', 'best linen shirts 2026'],
      competitorTopAngles: ['fabric guides', 'comparison listicles'],
      competitorGaps: ['no Taiwan-specific humidity advice'],
      targetWordCount: 1200,
      eeatHook: 'Boss should share own washing/wearing experience in tropical humidity',
    },
    {
      title: 'Sustainable summer fabrics buyer guide',
      primaryKeyword: 'sustainable fabrics summer',
      language: 'en' as const,
      writerBrief: 'Buyer guide comparing linen, organic cotton, and Tencel for summer apparel.',
      assignedAgent: 'shopify-blog-writer',
      scheduledAt: '2026-06-01T09:00:00.000Z',
      searchIntent: 'informational' as const,
      paaQuestions: ['What is the most sustainable fabric?'],
      relatedSearches: ['eco-friendly fabrics', 'sustainable summer clothing'],
      competitorTopAngles: ['comparison tables', 'sustainability scores'],
      competitorGaps: ['no first-hand washing durability data'],
      targetWordCount: 1500,
      eeatHook: 'Boss should mention their sourcing relationships and certifications',
    },
  ],
};

// Pass 1: tool-calling model — returns AIMessage with no tool_calls so the loop exits immediately
const toolPassInvokeMock = vi.fn(async () => ({ content: '', tool_calls: [] }));
const bindToolsMock = vi.fn(() => ({ invoke: toolPassInvokeMock }));

// Pass 2: structured plan model — returns the fixture
const planPassInvokeMock = vi.fn(async () => planFixture);
const withStructuredOutputMock = vi.fn(() => ({ invoke: planPassInvokeMock }));

vi.mock('../src/llm/model-registry.js', () => ({
  buildModel: vi.fn(() => ({
    bindTools: bindToolsMock,
    withStructuredOutput: withStructuredOutputMock,
  })),
}));

const { seoStrategistAgent } = await import('../src/agents/builtin/seo-strategist/index.js');

const PEERS = [
  {
    id: 'shopify-blog-writer',
    name: 'Shopify Blog Writer',
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
      expect(spawn.assignedAgent).toBe('shopify-blog-writer');
      expect(spawn.input).toHaveProperty('brief');
      expect(spawn.input).toHaveProperty('primaryKeyword');
      expect(spawn.input).toHaveProperty('language');
      expect(spawn.input).toHaveProperty('research');
    }
  });

  it('forwards SERP research fields into spawn input', async () => {
    const runnable = await seoStrategistAgent.build(ctx);
    const result = await runnable.invoke({
      messages: [{ role: 'user', content: 'plan summer SEO' }],
      params: {},
    });
    const first = result.spawnTasks?.[0];
    const research = (first?.input as { research?: Record<string, unknown> }).research;
    expect(research).toBeDefined();
    expect(research?.searchIntent).toBe('commercial');
    expect(research?.paaQuestions).toHaveLength(2);
    expect(research?.targetWordCount).toBe(1200);
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

  it('emits a typed seo-plan artifact for UI rendering', async () => {
    const runnable = await seoStrategistAgent.build(ctx);
    const result = await runnable.invoke({
      messages: [{ role: 'user', content: 'plan summer SEO' }],
      params: {},
    });
    expect(result.artifact?.kind).toBe('seo-plan');
    if (result.artifact?.kind === 'seo-plan') {
      expect(result.artifact.data.topics).toHaveLength(2);
    }
  });

  it('throws at build time if no peer worker agents are available', async () => {
    await expect(
      seoStrategistAgent.build({
        ...ctx,
        availableExecutionAgents: [],
      }),
    ).rejects.toThrow(/at least one peer worker agent/);
  });

  it('throws at invoke time if the LLM hallucinates an unknown assignedAgent', async () => {
    planPassInvokeMock.mockResolvedValueOnce({
      reasoning: 'plan with bad assignee',
      progressNote: '計畫好了但 worker 名稱可能有誤',
      topics: [
        {
          title: 'whatever',
          primaryKeyword: 'kw',
          language: 'zh-TW',
          writerBrief: 'something long enough to satisfy the schema minimum length.',
          assignedAgent: 'nonexistent-writer',
          searchIntent: 'commercial',
          paaQuestions: [],
          relatedSearches: [],
          competitorTopAngles: [],
          competitorGaps: [],
          targetWordCount: 800,
          eeatHook: 'Boss should share their direct product experience clearly.',
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

  it('uses the LLM-produced progressNote as the agent.plan.ready timeline message', async () => {
    const emitLog = vi.fn(
      async (_event: string, _message: string, _data?: Record<string, unknown>) => {},
    );
    const runnable = await seoStrategistAgent.build({ ...ctx, emitLog });
    await runnable.invoke({
      messages: [{ role: 'user', content: 'plan' }],
      params: {},
    });

    const readyCall = emitLog.mock.calls.find((c) => c[0] === 'agent.plan.ready');
    expect(readyCall?.[1]).toBe('規劃了 2 個主軸，圍繞夏季 + 永續，老闆過目');
  });

  it('system prompt contains SEO Fundamentals skill pack when seoFundamentals is enabled', async () => {
    const runnable = await seoStrategistAgent.build(ctx);
    await runnable.invoke({
      messages: [{ role: 'user', content: 'plan' }],
      params: {},
    });
    // buildAgentMessages is called with the enriched systemPrompt; check it was passed
    // to both the tool-call model (bindTools) and the plan model (withStructuredOutput).
    // We verify by inspecting what was passed to planPassInvokeMock.
    const calls = planPassInvokeMock.mock.calls as unknown[][];
    const lastCallArgs = calls[calls.length - 1]?.[0] as { content?: string }[] | undefined;
    const systemMsg = lastCallArgs?.find((m) => 'content' in m);
    expect(JSON.stringify(systemMsg)).toContain('SEO Fundamentals');
  });
});
