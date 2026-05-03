import { describe, expect, it, vi } from 'vitest';

/**
 * product-planner: strategy agent that researches via Serper and spawns
 * product-designer tasks — one per content variant.
 */

const planFixture = {
  reasoning: 'Two variants covering e-commerce and Instagram for the Taiwan market.',
  summary: '規劃了兩個方向，一個主打電商上架，一個針對 IG 社群，老闆確認一下方向',
  progressNote: '研究完競品後規劃了 2 個 variants，老闆看一下',
  variants: [
    {
      title: '亞麻短袖 - 電商版 (zh-TW)',
      platform: 'shopify',
      language: 'zh-TW',
      marketingAngle: '機能透氣，台灣濕熱夏天通勤族',
      keyMessages: ['180g 亞麻不悶熱', '台灣製造', '可機洗'],
      copyBrief: {
        tone: 'warm, professional',
        featuresToHighlight: ['fabric weight', 'washability'],
        forbiddenClaims: [],
      },
      imagePlan: [
        { purpose: 'hero shot', styleHint: 'clean white background', priority: 'required' },
        { purpose: 'lifestyle - commute scene', styleHint: 'urban morning', priority: 'optional' },
      ],
      assignedAgent: 'product-designer',
    },
    {
      title: '亞麻短袖 - Instagram 版 (zh-TW)',
      platform: 'instagram',
      language: 'zh-TW',
      marketingAngle: '永續生活入門款',
      keyMessages: ['天然亞麻', '少買好物'],
      copyBrief: {
        tone: 'casual, aspirational',
        featuresToHighlight: ['natural material', 'timeless style'],
        forbiddenClaims: [],
      },
      imagePlan: [
        { purpose: 'lifestyle flat lay', styleHint: 'warm tones, linen texture', priority: 'required' },
      ],
      assignedAgent: 'product-designer',
    },
  ],
};

// Pass 1: tool-calling (serper search) — no tool_calls so loop exits immediately
const toolPassInvokeMock = vi.fn(async () => ({ content: '', tool_calls: [] }));
const bindToolsMock = vi.fn(() => ({ invoke: toolPassInvokeMock }));

// Pass 2: structured plan output
const planPassInvokeMock = vi.fn(async () => planFixture);
const withStructuredOutputMock = vi.fn(() => ({ invoke: planPassInvokeMock }));

vi.mock('../src/llm/model-registry.js', () => ({
  buildModel: vi.fn(() => ({
    bindTools: bindToolsMock,
    withStructuredOutput: withStructuredOutputMock,
  })),
}));

vi.mock('../src/integrations/serper/tools.js', () => ({
  SERPER_TOOL_IDS: ['serper.search'],
  buildSerperTools: vi.fn(() => [
    {
      id: 'serper.search',
      tool: {
        name: 'serper_search',
        invoke: vi.fn(async () => ({ organic: [], peopleAlsoAsk: [], relatedSearches: [] })),
      },
    },
  ]),
}));

vi.mock('../src/integrations/serper/cache.js', () => ({
  SerpCache: vi.fn(() => ({})),
}));

vi.mock('../src/integrations/serper/client.js', () => ({
  SerperClient: vi.fn(() => ({})),
}));

const { productPlannerAgent } = await import('../src/agents/builtin/product-planner/index.js');

const designerPeer = {
  id: 'product-designer',
  name: 'Product Designer',
  description: 'Generates images and copy from a variant spec.',
};

describe('product-planner', () => {
  it('spawns one product-designer task per variant', async () => {
    const runnable = await productPlannerAgent.build({
      tenantId: 't1',
      taskId: 'task-1',
      modelConfig: { model: 'anthropic/claude-opus-4.7', temperature: 0.2 },
      systemPrompt: 'You are a product planner.',
      agentConfig: {},
      availableExecutionAgents: [designerPeer],
      emitLog: vi.fn(async () => {}),
    });

    const output = await runnable.invoke({
      messages: [{ role: 'user', content: 'Plan content for this linen shirt' }],
      params: {},
    });

    expect(output.awaitingApproval).toBe(true);
    expect(output.spawnTasks).toHaveLength(2);
    expect(output.spawnTasks![0]!.assignedAgent).toBe('product-designer');
    expect(output.spawnTasks![0]!.input.variantSpec).toMatchObject({
      title: '亞麻短袖 - 電商版 (zh-TW)',
      assignedAgent: 'product-designer',
    });
  });

  it('throws when no product-designer peer is available', async () => {
    const runnable = await productPlannerAgent.build({
      tenantId: 't1',
      taskId: 'task-2',
      modelConfig: { model: 'anthropic/claude-opus-4.7', temperature: 0.2 },
      systemPrompt: 'sys',
      agentConfig: {},
      availableExecutionAgents: [],
      emitLog: vi.fn(async () => {}),
    });

    await expect(
      runnable.invoke({ messages: [{ role: 'user', content: 'brief' }], params: {} }),
    ).rejects.toThrow(/product-designer/i);
  });

  it('forwards originalImageIds to each spawned task', async () => {
    const runnable = await productPlannerAgent.build({
      tenantId: 't1',
      taskId: 'task-3',
      modelConfig: { model: 'anthropic/claude-opus-4.7', temperature: 0.2 },
      systemPrompt: 'sys',
      agentConfig: {},
      availableExecutionAgents: [designerPeer],
      emitLog: vi.fn(async () => {}),
    });

    const output = await runnable.invoke({
      messages: [{ role: 'user', content: 'brief' }],
      params: { imageIds: ['img-uuid-1', 'img-uuid-2'] },
    });

    expect(output.spawnTasks![0]!.input.originalImageIds).toEqual(['img-uuid-1', 'img-uuid-2']);
  });
});
