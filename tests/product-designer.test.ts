import { describe, expect, it, vi } from 'vitest';
import type { ProductContent } from '../src/agents/builtin/shopify-publisher/content.js';

/**
 * product-designer: execution agent that receives a markdown brief from
 * product-planner, generates images via tool loop, writes copy, then spawns
 * publisher tasks.
 *
 * Key behaviours tested:
 * 1. Happy path: spawns shopify-publisher with ProductContent
 * 2. Feedback round: preserves previous imageUrls when no tool calls fire
 * 3. Feedback round: replaces imageUrls when LLM generates new images
 * 4. Emits an Artifact { report, body, refs }
 */

const listingFixture = {
  title: 'Linen Oversized Shirt',
  body: '## 主特色\n\n180g 亞麻、台灣製造、可機洗。\n\n- 不悶熱\n- 可機洗',
  tags: ['linen', 'summer', 'oversized'],
  vendor: 'Acme',
  report: `## 我的切角

機能透氣切「台灣通勤」實戰。文案直接連結濕熱痛點。

## 為什麼選這個 vendor 跟 productType
從 brief 推斷 Acme 為品牌，productType 留空（brief 未指定）。`,
  progressNote: '文案好了，老闆看一下',
};

// Pass 1 mock: no tool calls by default (overridden per test)
let toolPassResponse: {
  content: string;
  tool_calls: { name: string; id: string; args: Record<string, unknown> }[];
} = { content: '', tool_calls: [] };
const toolPassInvokeMock = vi.fn(async () => toolPassResponse);
const bindToolsMock = vi.fn(() => ({ invoke: toolPassInvokeMock }));

// Pass 2 mock
const listingPassInvokeMock = vi.fn(async () => listingFixture);
const withStructuredOutputMock = vi.fn(() => ({ invoke: listingPassInvokeMock }));

vi.mock('../src/llm/model-registry.js', () => ({
  buildModel: vi.fn(() => ({
    bindTools: bindToolsMock,
    withStructuredOutput: withStructuredOutputMock,
  })),
}));

const generateToolInvoke = vi.fn(async () => ({
  id: 'img-1',
  url: 'https://cdn.example.com/img-1.jpg',
}));

vi.mock('../src/integrations/openai-images/tools.js', () => ({
  IMAGE_TOOL_IDS: ['images.generate', 'images.edit'],
  buildImageTools: vi.fn(() => [
    {
      id: 'images.generate',
      tool: { name: 'images_generate', invoke: generateToolInvoke },
    },
  ]),
}));

vi.mock('../src/config/env.js', () => ({
  env: {
    CLOUDFLARE_ACCOUNT_ID: 'test-account',
    CLOUDFLARE_R2_ACCESS_KEY_ID: 'test-access-key',
    CLOUDFLARE_R2_SECRET_ACCESS_KEY: 'test-secret-key',
    CLOUDFLARE_R2_BUCKET: 'test-bucket',
    CLOUDFLARE_R2_PUBLIC_BASE_URL: 'https://cdn.example.com',
    OPENAI_API_KEY: 'test-openai-key',
  },
}));

vi.mock('../src/integrations/cloudflare/images-client.js', () => ({
  CloudflareImagesClient: vi.fn(() => ({})),
}));
vi.mock('../src/integrations/openai-images/client.js', () => ({
  OpenAIImagesClient: vi.fn(() => ({})),
}));
vi.mock('../src/integrations/cloudflare/images-repository.js', () => ({
  insertImage: vi.fn(async () => ({ id: 'row-1' })),
  getImageById: vi.fn(async () => null),
}));

const { productDesignerAgent } = await import('../src/agents/builtin/product-designer/index.js');

const publisherPeer = {
  id: 'shopify-publisher',
  name: 'Shopify Publisher',
  description: 'Publishes to Shopify',
  metadata: { kind: 'publisher' },
};

// briefMarkdown emulates what product-planner now spawns: a markdown brief
// folding marketing angle / key messages / image plan / copy brief into prose.
const briefMarkdown = `### Marketing angle
機能透氣，台灣濕熱夏天通勤族 — 切「機能 + 在地實穿」。

### Key messages
- 不悶熱
- 可機洗

### Copy brief
**Tone**: warm, professional
**Features to highlight**: fabric

### Image plan
- **Hero (required)** white background, hero shot
`;

function buildCtx(overrides = {}) {
  return {
    tenantId: 't1',
    taskId: 'task-1',
    modelConfig: { model: 'anthropic/claude-sonnet-4.6', temperature: 0.3 },
    systemPrompt: 'You are a product designer.',
    agentConfig: {},
    availableExecutionAgents: [publisherPeer],
    emitLog: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('product-designer', () => {
  it('spawns shopify-publisher with ProductContent on first run', async () => {
    toolPassResponse = { content: '', tool_calls: [] };

    const runnable = await productDesignerAgent.build(buildCtx());
    const output = await runnable.invoke({
      messages: [{ role: 'user', content: briefMarkdown }],
      params: { brief: briefMarkdown, refs: { language: 'zh-TW' } },
    });

    expect(output.awaitingApproval).toBe(true);
    expect(output.spawnTasks).toHaveLength(1);
    expect(output.spawnTasks![0]!.assignedAgent).toBe('shopify-publisher');
    const content = output.spawnTasks![0]!.input.content as ProductContent;
    expect(content.refs.title).toBe('Linen Oversized Shirt');
    expect(content.body).toContain('180g 亞麻');
    expect(content.refs.language).toBe('zh-TW');
  });

  it('preserves previous imageUrls when feedback does not trigger image generation', async () => {
    toolPassResponse = { content: '', tool_calls: [] };

    const runnable = await productDesignerAgent.build(buildCtx());
    const output = await runnable.invoke({
      messages: [
        { role: 'user', content: briefMarkdown },
        { role: 'assistant', content: 'draft' },
        { role: 'user', content: 'copy tone is too formal' },
      ],
      params: { brief: briefMarkdown, refs: { language: 'zh-TW' } },
      taskOutput: {
        payload: { content: { refs: { imageUrls: ['https://cdn.example.com/prev.jpg'] } } },
      },
    });

    const content = output.spawnTasks![0]!.input.content as ProductContent;
    expect(content.refs.imageUrls).toEqual(['https://cdn.example.com/prev.jpg']);
  });

  it('replaces imageUrls when LLM generates new images on feedback', async () => {
    let hop = 0;
    toolPassInvokeMock.mockImplementation(async () => {
      if (hop === 0) {
        hop++;
        return {
          content: '',
          tool_calls: [
            { name: 'images_generate', id: 'call-1', args: { prompt: 'new background' } },
          ],
        };
      }
      return { content: '', tool_calls: [] };
    });

    const runnable = await productDesignerAgent.build(buildCtx());
    const output = await runnable.invoke({
      messages: [{ role: 'user', content: 'change background to dark wood' }],
      params: { brief: briefMarkdown, refs: { language: 'zh-TW' } },
      taskOutput: {
        payload: { content: { refs: { imageUrls: ['https://cdn.example.com/prev.jpg'] } } },
      },
    });

    const content = output.spawnTasks![0]!.input.content as ProductContent;
    expect(content.refs.imageUrls).toEqual(['https://cdn.example.com/img-1.jpg']);

    toolPassInvokeMock.mockImplementation(async () => ({ content: '', tool_calls: [] }));
    hop = 0;
  });

  it('emits an Artifact { report, body, refs }', async () => {
    toolPassResponse = { content: '', tool_calls: [] };
    const runnable = await productDesignerAgent.build(buildCtx());
    const output = await runnable.invoke({
      messages: [{ role: 'user', content: briefMarkdown }],
      params: { brief: briefMarkdown, refs: { language: 'zh-TW' } },
    });
    const artifact = output.artifact;
    expect(artifact).toHaveProperty('report');
    expect(artifact).toHaveProperty('body');
    expect(artifact).toHaveProperty('refs');
    expect(artifact).not.toHaveProperty('kind');
    expect(artifact).not.toHaveProperty('data');
    if (artifact && 'refs' in artifact) {
      expect(artifact.refs).toMatchObject({
        title: 'Linen Oversized Shirt',
        language: 'zh-TW',
        imageUrls: expect.any(Array),
      });
    }
  });
});
