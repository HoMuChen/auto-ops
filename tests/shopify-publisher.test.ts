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
  report: '## 我的切角\n\n機能透氣切「台灣通勤」實戰。',
  body: '## 主特色\n\n- 180g 亞麻\n- 可機洗',
  refs: {
    title: 'Linen Oversized Shirt',
    tags: ['linen', 'summer', 'oversize'],
    vendor: 'Acme',
    language: 'zh-TW',
    imageUrls: ['https://media.autoffice.app/img-1.png'],
  },
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
        // body is markdown; publisher converts via markdownToHtml at the boundary.
        bodyHtml: expect.stringContaining('<h2>主特色</h2>'),
        tags: expect.arrayContaining(['linen']),
        vendor: 'Acme',
        images: [{ url: 'https://media.autoffice.app/img-1.png' }],
      },
    });
    const artifact = output.artifact;
    expect(artifact).toBeDefined();
    expect(artifact).toMatchObject({
      report: expect.any(String),
      body: expect.any(String),
      refs: expect.objectContaining({
        title: 'Linen Oversized Shirt',
        vendor: 'Acme',
        imageUrls: ['https://media.autoffice.app/img-1.png'],
        ready: true,
      }),
    });
    expect(artifact).not.toHaveProperty('kind');
    expect(artifact).not.toHaveProperty('data');
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
      params: { content: { ...MOCK_CONTENT, refs: { ...MOCK_CONTENT.refs, imageUrls: [] } } },
    });

    expect(output.pendingToolCall?.args).not.toHaveProperty('images');
  });
});
