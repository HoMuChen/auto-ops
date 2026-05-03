import { describe, expect, it, vi } from 'vitest';
import type { ProductContent } from '../src/agents/builtin/shopify-publisher/content.js';

vi.mock('../src/integrations/shopify/tools.js', () => ({
  SHOPIFY_TOOL_IDS: ['shopify.create_product'],
  buildShopifyTools: vi.fn(async () => [
    {
      id: 'shopify.create_product',
      tool: { invoke: vi.fn(async () => ({ productId: 'gid://shopify/Product/1' })) },
    },
  ]),
}));

const { shopifyPublisherAgent } = await import('../src/agents/builtin/shopify-publisher/index.js');

const MOCK_CONTENT: ProductContent = {
  title: 'Linen Oversized Shirt',
  bodyHtml: '<p>Premium linen shirt.</p>',
  tags: ['linen', 'summer', 'oversize'],
  vendor: 'Acme',
  language: 'zh-TW',
  imageUrls: ['https://media.autoffice.app/img-1.png'],
  progressNote: '商品文案好了',
};

describe('shopify-publisher', () => {
  it('has metadata.kind = publisher', () => {
    expect(shopifyPublisherAgent.manifest.metadata?.kind).toBe('publisher');
  });

  it('invoke() maps ProductContent to pendingToolCall without calling LLM', async () => {
    const runnable = await shopifyPublisherAgent.build({
      tenantId: 't1',
      taskId: 'task-1',
      modelConfig: { model: 'anthropic/claude-sonnet-4.6', temperature: 0.2 },
      systemPrompt: 'unused',
      agentConfig: { shopify: { autoPublish: false } },
      availableExecutionAgents: [],
      emitLog: vi.fn(async () => {}),
    });

    const output = await runnable.invoke({
      messages: [{ role: 'user', content: 'brief' }],
      params: { content: MOCK_CONTENT },
    });

    expect(output.awaitingApproval).toBe(true);
    expect(output.pendingToolCall).toMatchObject({
      id: 'shopify.create_product',
      args: {
        title: 'Linen Oversized Shirt',
        bodyHtml: '<p>Premium linen shirt.</p>',
        tags: expect.arrayContaining(['linen']),
        vendor: 'Acme',
        images: [{ url: 'https://media.autoffice.app/img-1.png' }],
      },
    });
    expect(output.artifact).toEqual({
      kind: 'product-content',
      data: expect.objectContaining({
        title: 'Linen Oversized Shirt',
        vendor: 'Acme',
        imageUrls: ['https://media.autoffice.app/img-1.png'],
      }),
    });
  });

  it('invoke() omits images key when imageUrls is empty', async () => {
    const runnable = await shopifyPublisherAgent.build({
      tenantId: 't1',
      taskId: 'task-2',
      modelConfig: { model: 'anthropic/claude-sonnet-4.6', temperature: 0.2 },
      systemPrompt: 'unused',
      agentConfig: {},
      availableExecutionAgents: [],
      emitLog: vi.fn(async () => {}),
    });

    const output = await runnable.invoke({
      messages: [{ role: 'user', content: 'brief' }],
      params: { content: { ...MOCK_CONTENT, imageUrls: [] } },
    });

    expect(output.pendingToolCall?.args).not.toHaveProperty('images');
  });
});
