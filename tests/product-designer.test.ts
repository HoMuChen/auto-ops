import { describe, expect, it, vi } from 'vitest';

/**
 * product-designer: execution agent that receives a variant spec from product-planner,
 * generates images via tool loop, writes copy, then spawns publisher tasks.
 *
 * Key behaviours tested:
 * 1. Happy path: spawns shopify-publisher with ProductContent
 * 2. Feedback round: preserves previous imageUrls when no tool calls fire
 * 3. Feedback round: replaces imageUrls when LLM generates new images
 */

const listingFixture = {
  title: 'Linen Oversized Shirt',
  bodyHtml: '<p>Premium 180g linen.</p>',
  tags: ['linen', 'summer', 'oversized'],
  vendor: 'Acme',
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

const variantSpec = {
  title: '亞麻短袖 - 電商版',
  platform: 'shopify',
  language: 'zh-TW',
  marketingAngle: '機能透氣，台灣通勤族',
  keyMessages: ['不悶熱', '可機洗'],
  copyBrief: { tone: 'warm', featuresToHighlight: ['fabric'], forbiddenClaims: [] },
  imagePlan: [{ purpose: 'hero shot', styleHint: 'white background', priority: 'required' }],
  assignedAgent: 'product-designer',
};

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
      messages: [{ role: 'user', content: 'brief' }],
      params: { variantSpec, originalImageIds: [] },
    });

    expect(output.awaitingApproval).toBe(true);
    expect(output.spawnTasks).toHaveLength(1);
    expect(output.spawnTasks![0]!.assignedAgent).toBe('shopify-publisher');
    const content = output.spawnTasks![0]!.input.content as { title: string };
    expect(content.title).toBe('Linen Oversized Shirt');
  });

  it('preserves previous imageUrls when feedback does not trigger image generation', async () => {
    toolPassResponse = { content: '', tool_calls: [] };

    const runnable = await productDesignerAgent.build(buildCtx());
    const output = await runnable.invoke({
      messages: [
        { role: 'user', content: 'brief' },
        { role: 'assistant', content: 'draft' },
        { role: 'user', content: 'copy tone is too formal' },
      ],
      params: { variantSpec, originalImageIds: [] },
      taskOutput: { payload: { content: { imageUrls: ['https://cdn.example.com/prev.jpg'] } } },
    });

    const content = output.spawnTasks![0]!.input.content as { imageUrls: string[] };
    expect(content.imageUrls).toEqual(['https://cdn.example.com/prev.jpg']);
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
      params: { variantSpec, originalImageIds: [] },
      taskOutput: { payload: { content: { imageUrls: ['https://cdn.example.com/prev.jpg'] } } },
    });

    const content = output.spawnTasks![0]!.input.content as { imageUrls: string[] };
    expect(content.imageUrls).toEqual(['https://cdn.example.com/img-1.jpg']);

    toolPassInvokeMock.mockImplementation(async () => ({ content: '', tool_calls: [] }));
    hop = 0;
  });
});
