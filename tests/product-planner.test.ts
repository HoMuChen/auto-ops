import { describe, expect, it, vi } from 'vitest';

/**
 * product-planner: strategy agent that researches via Serper and spawns
 * product-designer tasks — one per content variant.
 */

const planFixture = {
  reasoning: 'Two variants covering e-commerce and Instagram for the Taiwan market.',
  overview: `## 市場觀察

兩條主軸：機能透氣（通勤客）跟永續生活（自我認同消費者）。亞麻在台灣夏季 SERP 多半被「悶熱」「縮水」恐懼壟斷，反向操作 → 主打 180g 不悶 + 可機洗。

## 我的策略

兩個 variant：一個 zh-TW 電商頁面切「機能透氣」、一個 IG 社群版切「永續生活感」。`,
  progressNote: '研究完競品後規劃了 2 個 variants，老闆看一下',
  variants: [
    {
      title: '亞麻短袖 - 電商版 (zh-TW)',
      platform: 'shopify',
      language: 'zh-TW',
      brief: `### Marketing angle
台灣濕熱夏天通勤族，怕熱怕悶；切「機能透氣」+ 在地實穿。

### Key messages
- 180g 亞麻不悶熱
- 台灣製造
- 可機洗、不縮水

### Copy brief
**Tone**: 自信、實用、台灣口語
**Features to highlight**: 透氣、台灣製、可機洗
**Forbidden claims**: "100% 不會皺"、誇張涼感字眼

### Image plan
- **Hero (required)**：模特在通勤情境中穿著、自然光
- **Detail (required)**：布料近拍、織紋、標籤
- **Lifestyle (optional)**：辦公室／咖啡店場景`,
      assignedAgent: 'product-designer',
    },
    {
      title: '亞麻短袖 - Instagram 版 (zh-TW)',
      platform: 'instagram',
      language: 'zh-TW',
      brief: `### Marketing angle
追求永續生活感的城市消費者；切「天然亞麻 + 少買好物」價值觀。

### Key messages
- 天然亞麻
- 少買好物

### Copy brief
**Tone**: 溫暖、生活感、安靜自信
**Features to highlight**: 天然材質、可長穿
**Forbidden claims**: "百分百環保"

### Image plan
- **Hero (required)**：折疊在木桌上、靜態靜物
- **Detail (optional)**：縫線特寫`,
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
    expect(output.spawnTasks?.[0]?.input).toMatchObject({
      brief: expect.stringContaining('Marketing angle'),
      refs: { language: 'zh-TW' },
    });
    expect(output.spawnTasks?.[0]?.input).not.toHaveProperty('variantSpec');

    const artifact = output.artifact;
    expect(artifact).toBeDefined();
    expect(artifact).toHaveProperty('report');
    expect(artifact).not.toHaveProperty('kind');
    expect(artifact).not.toHaveProperty('data');
    if (artifact && 'report' in artifact) {
      expect(artifact.report).toContain('## 市場觀察');
      expect(artifact.report).toContain('### 亞麻短袖 - 電商版 (zh-TW)');
      expect(artifact.report).toContain('### 亞麻短袖 - Instagram 版 (zh-TW)');
    }
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

    expect(output.spawnTasks![0]!.input.refs).toMatchObject({
      originalImageIds: ['img-uuid-1', 'img-uuid-2'],
    });
  });
});
