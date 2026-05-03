import { describe, expect, it, vi } from 'vitest';

/**
 * Verifies the SEO Strategist converts a structured content plan into well-formed
 * spawnTasks, picks `assignedAgent` per topic from `availableExecutionAgents`,
 * and rejects LLM responses that name an unknown worker.
 *
 * The langchain model is mocked so the test is hermetic — no LLM, no DB.
 */

const planFixture = {
  overview: `## 市場觀察

兩條主軸：夏季穿搭跟永續材質。台灣夏天又濕又熱，多數競品的內容都從歐美視角寫，缺乏在地實戰經驗。

## 我的策略

挑兩篇主打：一篇 zh-TW 切「在地穿搭實戰」，一篇英文 buyer guide 切「永續材質採購標準」，互不重疊。`,
  progressNote: '規劃了 2 個主軸，圍繞夏季 + 永續，老闆過目',
  topics: [
    {
      title: '夏季穿搭 5 個必備單品',
      primaryKeyword: '夏季穿搭',
      language: 'zh-TW' as const,
      writerBrief: `## 主題：夏季穿搭 5 個必備單品

**搜尋意圖**：commercial（讀者準備買，需要選品建議）

### PAA 必答
- Is linen good for summer?
- How to care for linen?

### 相關長尾
- linen vs cotton
- best linen shirts 2026

### 競品切角
listicle 7 件 / fabric 比較 / wash care guide

### 競品缺口（我們的切點）
沒有人從台灣濕熱氣候給穿搭建議。

### 目標
1500 字，layered styling for Taiwan humid summers。

### E-E-A-T 切入
老闆親身在台灣夏天試穿、洗滌的經驗，必入文。`,
      assignedAgent: 'shopify-blog-writer',
    },
    {
      title: 'Sustainable summer fabrics buyer guide',
      primaryKeyword: 'sustainable fabrics summer',
      language: 'en' as const,
      writerBrief: `## Topic: Sustainable summer fabrics buyer guide

**Search intent**: informational

### Must answer (PAA)
- What is the most sustainable fabric?

### Related queries
- eco-friendly fabrics
- sustainable summer clothing

### Competitor angles
comparison tables / sustainability scores

### Competitor gap (our hook)
No first-hand washing-durability evidence.

### Target
~1500 words. Compare linen, organic cotton, Tencel.

### E-E-A-T hook
Boss should mention sourcing relationships and certifications.`,
      assignedAgent: 'shopify-blog-writer',
      scheduledAt: '2026-06-01T09:00:00.000Z',
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
      expect(spawn.input).toHaveProperty('refs');
      expect((spawn.input as { refs: Record<string, unknown> }).refs).toHaveProperty(
        'primaryKeyword',
      );
      expect((spawn.input as { refs: Record<string, unknown> }).refs).toHaveProperty('language');
    }
  });

  it('passes minimal refs alongside the markdown brief', async () => {
    const runnable = await seoStrategistAgent.build(ctx);
    const result = await runnable.invoke({
      messages: [{ role: 'user', content: 'plan summer SEO' }],
      params: {},
    });
    const first = result.spawnTasks?.[0];
    const refs = (first?.input as { refs?: Record<string, unknown> }).refs;
    expect(refs).toEqual({
      primaryKeyword: '夏季穿搭',
      language: 'zh-TW',
    });
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

  it('emits an Artifact{report} with the overview and per-topic sections', async () => {
    const runnable = await seoStrategistAgent.build(ctx);
    const result = await runnable.invoke({
      messages: [{ role: 'user', content: 'plan summer SEO' }],
      params: {},
    });
    const artifact = result.artifact;
    expect(artifact).toBeDefined();
    expect(artifact).toHaveProperty('report');
    expect(artifact).not.toHaveProperty('kind');
    expect(artifact).not.toHaveProperty('data');
    if (artifact && 'report' in artifact) {
      expect(artifact.report).toContain('## 市場觀察');
      expect(artifact.report).toContain('### 夏季穿搭 5 個必備單品');
      expect(artifact.report).toContain('### Sustainable summer fabrics buyer guide');
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
      overview:
        '## 觀察\n\n為了測試錯誤處理，這份規劃故意指派一個不存在的 worker，預期框架會擋下並丟錯。',
      progressNote: '計畫好了但 worker 名稱可能有誤',
      topics: [
        {
          title: 'whatever',
          primaryKeyword: 'kw',
          language: 'zh-TW',
          writerBrief:
            '## Topic\n\nSomething long enough to satisfy the schema minimum length so the test reaches the worker-id validation step.',
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
