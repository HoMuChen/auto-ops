import { describe, expect, it, vi } from 'vitest';

const runToolLoopMock = vi.fn();
vi.mock('../src/agents/lib/tool-loop.js', () => ({
  runToolLoop: runToolLoopMock,
}));

vi.mock('../src/agents/lib/packs.js', () => ({
  loadPacks: vi.fn(async () => ''),
}));

vi.mock('../src/integrations/shopify/tools.js', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    buildShopifyTools: vi.fn(async () => [
      { id: 'shopify.publish_article', tool: { name: 'publish_article' } },
    ]),
  };
});

const { articleWriterAgent } = await import('../src/agents/builtin/article-writer/index.js');

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: '00000000-0000-0000-0000-000000000001',
    taskId: '00000000-0000-0000-0000-000000000002',
    modelConfig: { model: 'anthropic/claude-sonnet-4.6', temperature: 0.4 },
    systemPrompt: 'You are a writer.',
    agentConfig: { publishToShopify: true, skills: {} },
    availableExecutionAgents: [],
    tenantProfile: {
      tenantId: '...',
      industry: null,
      brandVoice: null,
      profileMd: null,
      imageStyleSuffix: null,
      timezone: 'UTC',
    },
    logCtx: { taskId: 'x', agentId: 'article-writer' },
    emitLog: vi.fn(async () => {}),
    ...overrides,
  } as never;
}

describe('article-writer — invoke contract', () => {
  it('emits structuredOutput + pendingToolCall, no artifact.report, when publishToShopify=true', async () => {
    runToolLoopMock.mockResolvedValueOnce({
      kind: 'submitted',
      value: {
        title: 'Linen shirts',
        slug: 'linen-shirts',
        body: '## Section\n\nLong enough body content.',
        summaryHtml: 'A summary.',
        tags: ['linen', 'summer'],
        language: 'en',
        author: null,
        keyDecisions: ['用機能性切入', '開頭塞 EEAT 數字'],
        progressNote: 'Draft done.',
      },
    });

    const runnable = await articleWriterAgent.build(makeCtx());
    const out = await runnable.invoke({
      messages: [{ role: 'user', content: 'Write about linen.' }],
      params: {},
    });

    expect(out.awaitingApproval).toBe(true);
    expect(out.artifact?.body).toContain('## Section');
    expect(out.artifact?.refs).toMatchObject({ title: 'Linen shirts', language: 'en' });
    expect(out.artifact?.report).toBeUndefined();
    expect(out.structuredOutput).toMatchObject({
      schemaName: 'article-draft',
      data: expect.objectContaining({ title: 'Linen shirts' }),
      keyDecisions: expect.arrayContaining(['用機能性切入']),
    });
    expect(out.pendingToolCall?.id).toBe('shopify.publish_article');
    expect(out.pendingToolCall?.args.bodyHtml).toContain('<h2>Section</h2>');
  });

  it('omits pendingToolCall when publishToShopify=false', async () => {
    runToolLoopMock.mockResolvedValueOnce({
      kind: 'submitted',
      value: {
        title: 'Drafts only',
        slug: 'drafts-only',
        body: '## Body\n\nLong enough body content here.',
        summaryHtml: 'A summary.',
        tags: ['draft'],
        language: 'en',
        author: null,
        keyDecisions: ['Keep as draft per config.'],
        progressNote: 'Draft done.',
      },
    });

    const runnable = await articleWriterAgent.build(
      makeCtx({ agentConfig: { publishToShopify: false, skills: {} } }),
    );
    const out = await runnable.invoke({
      messages: [{ role: 'user', content: 'draft only' }],
      params: {},
    });

    expect(out.pendingToolCall).toBeUndefined();
    expect(out.structuredOutput?.schemaName).toBe('article-draft');
  });
});
