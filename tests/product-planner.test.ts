import { describe, expect, it, vi } from 'vitest';

/**
 * product-planner (post-PR4): strategy agent that researches via Serper and
 * spawns product-designer tasks. The synthesized markdown deliverable now
 * lives on `artifact.body` (was `artifact.report`); `artifact.report` is
 * filled by the shared report-writer node downstream from
 * `structuredOutput.schemaName='product-plan'`. Spawn behaviour is unchanged.
 */

const planFixture = {
  reasoning: 'Two variants covering e-commerce and Instagram for the Taiwan market.',
  overview: `## 市場觀察

兩條主軸：機能透氣（通勤客）跟永續生活（自我認同消費者）。亞麻在台灣夏季 SERP 多半被「悶熱」「縮水」恐懼壟斷，反向操作 → 主打 180g 不悶 + 可機洗。

## 我的策略

兩個 variant：一個 zh-TW 電商頁面切「機能透氣」、一個 IG 社群版切「永續生活感」。`,
  progressNote: '研究完競品後規劃了 2 個 variants，老闆看一下',
  keyDecisions: [
    '兩條主軸：機能透氣 vs 永續生活感',
    '反向操作 SERP 的悶熱恐懼，主打 180g 不悶 + 可機洗',
    '電商版切實用、IG 版切價值觀，避免角度互相吃掉',
  ],
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

// Single-pass mock: model immediately submits the plan via submit_plan tool.
// runToolLoop intercepts, validates against PlanSchema, returns submitted.
const toolPassInvokeMock = vi.fn();
toolPassInvokeMock.mockResolvedValue({
  content: '',
  tool_calls: [{ id: 'call_submit_1', name: 'submit_plan', args: planFixture }],
});
const bindToolsMock = vi.fn(() => ({ invoke: toolPassInvokeMock }));

vi.mock('../src/llm/model-registry.js', () => ({
  buildModel: vi.fn(() => ({
    bindTools: bindToolsMock,
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

// Stub the tenant skill-packs DB query — agent .build() now calls loadPacks
// with ctx.tenantId, which would otherwise hit the real DB and ECONNREFUSED.
vi.mock('../src/agents/skill-packs-repository.js', () => ({
  listPacksForAgent: vi.fn(async () => []),
}));

const { productPlannerAgent } = await import('../src/agents/builtin/product-planner/index.js');

const designerPeer = {
  id: 'product-designer',
  name: 'Product Designer',
  description: 'Generates images and copy from a variant spec.',
};

describe('product-planner', () => {
  it('spawns one product-designer task per variant; synthesis lands on artifact.body', async () => {
    const runnable = await productPlannerAgent.build({
      tenantId: 't1',
      taskId: 'task-1',
      modelConfig: { model: 'anthropic/claude-opus-4.7', temperature: 0.2 },
      systemPrompt: 'You are a product planner.',
      agentConfig: {},
      availableExecutionAgents: [designerPeer],
      tenantProfile: {
        profileMd: '',
        timezone: 'UTC',
        imageStyleSuffix: '',
        imageStyleReferenceImageIds: [],
      },
      logCtx: { taskId: 'task-1', agentId: 'product-planner' },
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

    const artifact = output.artifact;
    expect(artifact).toBeDefined();
    // The agent no longer writes report — that's report-writer's job now.
    expect(artifact).not.toHaveProperty('report');
    expect(artifact).toHaveProperty('body');
    if (artifact && 'body' in artifact) {
      expect(artifact.body).toContain('## 市場觀察');
      expect(artifact.body).toContain('### 亞麻短袖 - 電商版 (zh-TW)');
      expect(artifact.body).toContain('### 亞麻短袖 - Instagram 版 (zh-TW)');
    }
  });

  it('surfaces structuredOutput on the inter-node bus for report-writer', async () => {
    const runnable = await productPlannerAgent.build({
      tenantId: 't1',
      taskId: 'task-1',
      modelConfig: { model: 'anthropic/claude-opus-4.7', temperature: 0.2 },
      systemPrompt: 'You are a product planner.',
      agentConfig: {},
      availableExecutionAgents: [designerPeer],
      tenantProfile: {
        profileMd: '',
        timezone: 'UTC',
        imageStyleSuffix: '',
        imageStyleReferenceImageIds: [],
      },
      logCtx: { taskId: 'task-1', agentId: 'product-planner' },
      emitLog: vi.fn(async () => {}),
    });

    const output = await runnable.invoke({
      messages: [{ role: 'user', content: 'Plan content for this linen shirt' }],
      params: {},
    });

    expect(output.structuredOutput?.schemaName).toBe('product-plan');
    expect(output.structuredOutput?.data).toMatchObject({
      overview: expect.stringContaining('## 市場觀察'),
      variants: expect.arrayContaining([
        expect.objectContaining({
          title: '亞麻短袖 - 電商版 (zh-TW)',
          platform: 'shopify',
          language: 'zh-TW',
          assignedAgent: 'product-designer',
          brief: expect.stringContaining('Marketing angle'),
        }),
      ]),
    });
    expect(
      (output.structuredOutput?.data as { variants: unknown[] } | undefined)?.variants,
    ).toHaveLength(2);
    expect(output.structuredOutput?.keyDecisions).toEqual(planFixture.keyDecisions);
  });

  it('throws when no product-designer peer is available', async () => {
    const runnable = await productPlannerAgent.build({
      tenantId: 't1',
      taskId: 'task-2',
      modelConfig: { model: 'anthropic/claude-opus-4.7', temperature: 0.2 },
      systemPrompt: 'sys',
      agentConfig: {},
      availableExecutionAgents: [],
      tenantProfile: {
        profileMd: '',
        timezone: 'UTC',
        imageStyleSuffix: '',
        imageStyleReferenceImageIds: [],
      },
      logCtx: { taskId: 'task-1', agentId: 'product-planner' },
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
      tenantProfile: {
        profileMd: '',
        timezone: 'UTC',
        imageStyleSuffix: '',
        imageStyleReferenceImageIds: [],
      },
      logCtx: { taskId: 'task-3', agentId: 'product-planner' },
      emitLog: vi.fn(async () => {}),
    });

    const output = await runnable.invoke({
      messages: [{ role: 'user', content: 'brief' }],
      params: { imageIds: ['img-1', 'img-2'] },
    });

    expect(output.spawnTasks?.[0]?.input).toMatchObject({
      refs: { language: 'zh-TW', originalImageIds: ['img-1', 'img-2'] },
    });
    expect(output.spawnTasks?.[1]?.input).toMatchObject({
      refs: { language: 'zh-TW', originalImageIds: ['img-1', 'img-2'] },
    });
  });
});
