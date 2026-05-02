import { describe, expect, it, vi } from 'vitest';
import { llmMockModule, scriptStructured } from './integration/helpers/llm-mock.js';

vi.mock('../src/llm/model-registry.js', () => llmMockModule());
// Mock image tools so no real CF/OpenAI calls
vi.mock('../src/integrations/openai-images/tools.js', () => ({
  IMAGE_TOOL_IDS: ['images.generate', 'images.edit'],
  buildImageTools: vi.fn(() => [
    {
      id: 'images.generate',
      tool: {
        invoke: vi.fn(async () => ({ id: 'img-1', url: 'https://media.autoffice.app/img-1.png' })),
      },
    },
  ]),
}));
vi.mock('../src/integrations/cloudflare/images-client.js', () => ({
  CloudflareImagesClient: vi.fn(() => ({})),
}));
vi.mock('../src/integrations/openai-images/client.js', () => ({
  OpenAIImagesClient: vi.fn(() => ({})),
}));
vi.mock('../src/integrations/cloudflare/images-repository.js', () => ({
  insertImage: vi.fn(async () => ({ id: 'img-row-1' })),
  getImageById: vi.fn(async () => null),
}));

const { productStrategistAgent } = await import(
  '../src/agents/builtin/product-strategist/index.js'
);

describe('product-strategist', () => {
  it('produces spawnTasks with ProductContent for each available publisher', async () => {
    scriptStructured({
      title: 'Linen Oversized Shirt',
      bodyHtml: '<p>Premium linen.</p>',
      tags: ['linen', 'summer'],
      vendor: 'Acme',
      progressNote: '商品文案好了，老闆看一下',
    });

    const publisherAgent = {
      id: 'shopify-publisher',
      name: 'Shopify Publisher',
      description: 'Publishes to Shopify',
      metadata: { kind: 'publisher' },
    };

    const runnable = await productStrategistAgent.build({
      tenantId: 't1',
      taskId: 'task-1',
      modelConfig: { model: 'anthropic/claude-sonnet-4.6', temperature: 0.2 },
      systemPrompt: 'You are a product content specialist.',
      agentConfig: {},
      availableExecutionAgents: [publisherAgent],
      emitLog: vi.fn(async () => {}),
    });

    const output = await runnable.invoke({
      messages: [{ role: 'user', content: 'List this linen shirt' }],
      params: {},
    });

    expect(output.awaitingApproval).toBe(true);
    expect(output.spawnTasks).toHaveLength(1);
    expect(output.spawnTasks![0]!.assignedAgent).toBe('shopify-publisher');
    expect(output.spawnTasks![0]!.input.content).toMatchObject({
      title: 'Linen Oversized Shirt',
      vendor: 'Acme',
      tags: expect.arrayContaining(['linen']),
    });
  });

  it('ignores non-publisher peers', async () => {
    scriptStructured({
      title: 'Shirt',
      bodyHtml: '<p>.</p>',
      tags: ['linen'],
      vendor: 'X',
      progressNote: 'ok',
    });

    const runnable = await productStrategistAgent.build({
      tenantId: 't1',
      taskId: 'task-2',
      modelConfig: { model: 'anthropic/claude-sonnet-4.6', temperature: 0.2 },
      systemPrompt: 'sys',
      agentConfig: {},
      availableExecutionAgents: [
        { id: 'seo-strategist', name: 'SEO', description: 'seo', metadata: { kind: 'strategy' } },
        { id: 'shopify-blog-writer', name: 'Writer', description: 'writer' },
      ],
      emitLog: vi.fn(async () => {}),
    });

    await expect(
      runnable.invoke({ messages: [{ role: 'user', content: 'brief' }], params: {} }),
    ).rejects.toThrow(/no publisher/i);
  });
});
