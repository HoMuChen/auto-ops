import { describe, expect, it, vi } from 'vitest';

/**
 * Verifies the Shopify Ops agent produces a structured product listing,
 * a markdown preview for the kanban card, and a pendingToolCall that
 * the framework will fire after HITL approval.
 *
 * The langchain model is mocked so the test is hermetic — no LLM, no DB.
 * The Shopify tools are mocked too because building real tools requires
 * tenant credentials in the DB.
 */

const listingFixture = {
  title: 'Linen summer shirt',
  bodyHtml: '<p>A breathable, lightweight linen shirt for hot summer days.</p>',
  tags: ['summer', 'linen', 'shirt', 'mens'],
  vendor: 'Acme Apparel',
};

const invokeMock = vi.fn(async () => listingFixture);
const withStructuredOutputMock = vi.fn(() => ({ invoke: invokeMock }));

vi.mock('../src/llm/model-registry.js', () => ({
  buildModel: vi.fn(() => ({
    withStructuredOutput: withStructuredOutputMock,
  })),
}));

// Stub tool builder so the agent doesn't try to fetch credentials from the DB
// in a unit test. We only need it to return SOMETHING with the matching id.
vi.mock('../src/integrations/shopify/tools.js', () => ({
  SHOPIFY_TOOL_IDS: ['shopify.create_product', 'shopify.update_product'],
  buildShopifyTools: vi.fn(async () => [
    { id: 'shopify.create_product', tool: { invoke: vi.fn() }, requiresApproval: true },
    { id: 'shopify.update_product', tool: { invoke: vi.fn() }, requiresApproval: true },
  ]),
}));

const { shopifyOpsAgent } = await import('../src/agents/builtin/shopify-ops/index.js');

describe('shopifyOpsAgent.build → invoke', () => {
  const ctx = {
    tenantId: '00000000-0000-0000-0000-000000000001',
    taskId: '00000000-0000-0000-0000-000000000002',
    modelConfig: shopifyOpsAgent.manifest.defaultModel,
    systemPrompt: shopifyOpsAgent.manifest.defaultPrompt,
    agentConfig: {
      shopify: { defaultVendor: 'Acme', autoPublish: false },
      defaultLanguage: 'zh-TW' as const,
    },
    availableExecutionAgents: [],
    emitLog: vi.fn(async () => {}),
  };

  it('emits awaitingApproval=true with a pendingToolCall pointing at create_product', async () => {
    const runnable = await shopifyOpsAgent.build(ctx);
    const result = await runnable.invoke({
      messages: [{ role: 'user', content: 'Create a listing for a summer linen shirt' }],
      params: {},
    });

    expect(result.awaitingApproval).toBe(true);
    expect(result.pendingToolCall).toMatchObject({
      id: 'shopify.create_product',
      args: {
        title: 'Linen summer shirt',
        bodyHtml: expect.stringContaining('linen shirt'),
        tags: expect.arrayContaining(['summer']),
        vendor: 'Acme Apparel',
      },
    });
  });

  it('persists the structured listing and a markdown preview message', async () => {
    const runnable = await shopifyOpsAgent.build(ctx);
    const result = await runnable.invoke({
      messages: [{ role: 'user', content: 'shirt please' }],
      params: {},
    });

    expect(result.payload).toMatchObject({
      listing: { title: 'Linen summer shirt', vendor: 'Acme Apparel' },
      language: 'zh-TW',
    });
    // Preview should mention the title + tags + draft/active hint.
    expect(result.message).toContain('Linen summer shirt');
    expect(result.message).toContain('Acme Apparel');
    expect(result.message).toContain('draft'); // autoPublish=false → draft
  });

  it('does not invoke any tool from inside the agent (deferred to executor)', async () => {
    const { buildShopifyTools } = await import('../src/integrations/shopify/tools.js');
    const tools = await (buildShopifyTools as unknown as ReturnType<typeof vi.fn>).mock.results[0]
      ?.value;
    const runnable = await shopifyOpsAgent.build(ctx);
    await runnable.invoke({
      messages: [{ role: 'user', content: 'shirt' }],
      params: {},
    });
    for (const t of tools as { tool: { invoke: ReturnType<typeof vi.fn> } }[]) {
      expect(t.tool.invoke).not.toHaveBeenCalled();
    }
  });
});
