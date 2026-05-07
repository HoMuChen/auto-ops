import { describe, expect, it, vi } from 'vitest';
import type { ProductContent } from '../src/agents/builtin/shopify-publisher/content.js';

/**
 * shopify-publisher (post-PR7): execution agent that converts a ProductContent
 * into a Shopify create_product pendingToolCall. Invoke is deterministic
 * (no LLM call) so keyDecisions are built from the listing fields in code.
 *
 * Post-PR7 contract:
 * - `artifact.body` = content.body + image markdown (boss-facing display).
 * - `artifact.report` is filled by report-writer, NOT by the agent.
 * - `pendingToolCall.args.bodyHtml` = markdownToHtml(content.body) — image-free,
 *   because Shopify takes images via the `images[]` field, not inline in HTML.
 * - `structuredOutput.schemaName='shopify-publish-intent'` — report-writer
 *   renders a tight "I'm about to ship" summary at the HITL boundary.
 * - `ProductContent` no longer has a `report` field; designer's mid-migration
 *   plumbing is gone.
 */

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
  it('has metadata.kind = publisher and shape = atomic', () => {
    expect(shopifyPublisherAgent.manifest.metadata?.kind).toBe('publisher');
    expect(shopifyPublisherAgent.manifest.metadata?.shape).toBe('atomic');
  });

  it('invoke() maps ProductContent to pendingToolCall + body+images artifact (no agent-written report)', async () => {
    const runnable = await shopifyPublisherAgent.build({
      tenantId: 't1',
      taskId: 'task-1',
      modelConfig: { model: 'anthropic/claude-sonnet-4.6', temperature: 0.2 },
      systemPrompt: 'unused',
      agentConfig: { shopify: { autoPublish: false } },
      availableExecutionAgents: [],
      tenantProfile: {
        profileMd: '',
        timezone: 'UTC',
        imageStyleSuffix: '',
        imageStyleReferenceImageIds: [],
      },
      logCtx: { taskId: 'task-1', agentId: 'shopify-publisher' },
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
        // Image markdown is NOT inline — Shopify takes images via `images[]`.
        bodyHtml: expect.stringContaining('<h2>主特色</h2>'),
        tags: expect.arrayContaining(['linen']),
        vendor: 'Acme',
        images: [{ url: 'https://media.autoffice.app/img-1.png' }],
      },
    });
    expect(output.pendingToolCall?.args.bodyHtml).not.toContain('<img');

    const artifact = output.artifact;
    expect(artifact).toBeDefined();
    // Post-PR7: agent no longer writes report — that's report-writer's job.
    expect(artifact).not.toHaveProperty('report');
    expect(artifact).toMatchObject({
      // bodyWithImages: image markdown appended so the boss sees images
      // alongside the description in the artifact panel.
      body: expect.stringContaining('## 主特色'),
      refs: expect.objectContaining({
        title: 'Linen Oversized Shirt',
        vendor: 'Acme',
        imageUrls: ['https://media.autoffice.app/img-1.png'],
        ready: true,
      }),
    });
    expect((artifact as { body: string }).body).toContain(
      '![圖 1](https://media.autoffice.app/img-1.png)',
    );
    expect(artifact).not.toHaveProperty('kind');
    expect(artifact).not.toHaveProperty('data');
  });

  it('invoke() omits images key when imageUrls is empty (and body has no image markdown)', async () => {
    const runnable = await shopifyPublisherAgent.build({
      tenantId: 't1',
      taskId: 'task-2',
      modelConfig: { model: 'anthropic/claude-sonnet-4.6', temperature: 0.2 },
      systemPrompt: 'unused',
      agentConfig: {},
      availableExecutionAgents: [],
      tenantProfile: {
        profileMd: '',
        timezone: 'UTC',
        imageStyleSuffix: '',
        imageStyleReferenceImageIds: [],
      },
      logCtx: { taskId: 'task-1', agentId: 'shopify-publisher' },
      emitLog: vi.fn(async () => {}),
    });

    const output = await runnable.invoke({
      messages: [{ role: 'user', content: 'brief' }],
      params: { content: { ...MOCK_CONTENT, refs: { ...MOCK_CONTENT.refs, imageUrls: [] } } },
    });

    expect(output.pendingToolCall?.args).not.toHaveProperty('images');
    // No images → no image markdown on artifact.body either.
    const artifact = output.artifact as { body: string };
    expect(artifact.body).not.toContain('## 生成的圖片');
    expect(artifact.body).not.toMatch(/!\[圖 \d+\]/);
  });

  it('emits structuredOutput { schemaName: shopify-publish-intent } with deterministic keyDecisions', async () => {
    const runnable = await shopifyPublisherAgent.build({
      tenantId: 't1',
      taskId: 'task-3',
      modelConfig: { model: 'anthropic/claude-sonnet-4.6', temperature: 0.2 },
      systemPrompt: 'unused',
      agentConfig: {},
      availableExecutionAgents: [],
      tenantProfile: {
        profileMd: '',
        timezone: 'UTC',
        imageStyleSuffix: '',
        imageStyleReferenceImageIds: [],
      },
      logCtx: { taskId: 'task-3', agentId: 'shopify-publisher' },
      emitLog: vi.fn(async () => {}),
    });

    const output = await runnable.invoke({
      messages: [{ role: 'user', content: 'brief' }],
      params: { content: MOCK_CONTENT },
    });

    expect(output.structuredOutput?.schemaName).toBe('shopify-publish-intent');
    expect(output.structuredOutput?.data).toMatchObject({
      title: 'Linen Oversized Shirt',
      vendor: 'Acme',
      tags: ['linen', 'summer', 'oversize'],
      language: 'zh-TW',
      imageCount: 1,
      imageUrls: ['https://media.autoffice.app/img-1.png'],
    });
    // productType is optional (not set on MOCK_CONTENT) — must NOT appear in
    // data, even as null/undefined, so the report-writer prompt stays clean.
    expect(output.structuredOutput?.data).not.toHaveProperty('productType');

    const decisions = output.structuredOutput?.keyDecisions ?? [];
    expect(decisions).toHaveLength(3);
    // First bullet names the title + platform — anchors the boss summary.
    expect(decisions[0]).toContain('Linen Oversized Shirt');
    expect(decisions[0]).toContain('Shopify');
    // Second bullet names the vendor.
    expect(decisions[1]).toContain('Acme');
    // Third bullet has the inventory metrics.
    expect(decisions[2]).toMatch(/3 個標籤/);
    expect(decisions[2]).toMatch(/1 張圖片/);
  });
});
